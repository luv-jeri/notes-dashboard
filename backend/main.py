"""Notes API: in-memory CRUD storage for the Notes Dashboard.

Run from the repository root:
    uvicorn backend.main:app --reload

Based on the assessment's starter, with three fixes:
- The server assigns ids. Clients send only the note's fields, so two clients
  can never create notes with the same id.
- Missing notes return HTTP 404 instead of a 200 with an error body, so the
  frontend can tell failure from success by status code.
- Writes happen under a lock. FastAPI runs sync endpoints on a thread pool, so
  two requests can touch the store at the same moment.

On top of the starter's title and content, a note has a category, an optional
due date, and pinned/done flags. The server owns the timestamps: when the note
was created, last edited and marked done.

Built to stay fast with thousands of notes:
- Lookups, edits and deletes by id are dictionary operations, so they cost the
  same with ten notes or ten thousand.
- The note list is serialised once per change, not once per request, and
  carries an ETag. The dashboard refetches on every window focus; when nothing
  changed, the answer is an empty 304 and the browser reuses its copy.
- Large responses are gzipped, and oversized request bodies are refused before
  they are parsed.
"""

import asyncio
import hashlib
import os
from datetime import UTC, date, datetime, timedelta
from threading import Lock
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

Category = Literal["work", "personal", "ideas", "shopping", "health"]

# The frontend enforces the same limits. Its counts are UTF-16 units, which are
# never fewer than Python's code points, so it can't send what we refuse.
TITLE_MAX = 200
CONTENT_MAX = 10_000


class NoteInput(BaseModel):
    """What a client may send when creating or replacing a note."""

    model_config = ConfigDict(str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=TITLE_MAX)
    content: str = Field(default="", max_length=CONTENT_MAX)
    category: Category = "personal"
    due_date: date | None = None
    pinned: bool = False
    done: bool = False


class Note(NoteInput):
    id: int
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None


_note_list = TypeAdapter(list[Note])


def utc_now() -> datetime:
    return datetime.now(UTC)


class NoteStore:
    """In-memory notes, keyed by id. Every method holds the lock.

    `now` is a parameter so tests and the demo seed can control the clock.
    """

    def __init__(self) -> None:
        self._notes: dict[int, Note] = {}
        self._next_id = 1
        self._lock = Lock()
        # The serialised list and its ETag, rebuilt on the first read after a write.
        self._listing: tuple[bytes, str] | None = None

    def all(self) -> list[Note]:
        """Newest first, so a new note appears at the top of the dashboard.

        Ids only grow and dicts keep insertion order, so reversing is enough:
        no sort.
        """
        with self._lock:
            return list(reversed(self._notes.values()))

    def listing(self) -> tuple[bytes, str]:
        """The list as JSON bytes, plus an ETag that changes when the bytes do."""
        with self._lock:
            if self._listing is None:
                body = _note_list.dump_json(list(reversed(self._notes.values())))
                etag = f'W/"{hashlib.blake2b(body, digest_size=16).hexdigest()}"'
                self._listing = (body, etag)
            return self._listing

    def create(self, data: NoteInput, now: datetime | None = None) -> Note:
        now = now or utc_now()
        with self._lock:
            note = Note(
                id=self._next_id,
                **data.model_dump(),
                created_at=now,
                updated_at=now,
                completed_at=now if data.done else None,
            )
            self._notes[note.id] = note
            self._next_id += 1
            self._listing = None
            return note

    def update(self, note_id: int, data: NoteInput, now: datetime | None = None) -> Note | None:
        now = now or utc_now()
        with self._lock:
            current = self._notes.get(note_id)
            if current is None:
                return None
            note = Note(
                id=note_id,
                **data.model_dump(),
                created_at=current.created_at,
                updated_at=now,
                completed_at=_completed_at(current, data, now),
            )
            self._notes[note_id] = note
            self._listing = None
            return note

    def delete(self, note_id: int) -> bool:
        with self._lock:
            if self._notes.pop(note_id, None) is None:
                return False
            self._listing = None
            return True


def _completed_at(current: Note, data: NoteInput, now: datetime) -> datetime | None:
    """Keeps the original "done" time when a done note is edited again."""
    if not data.done:
        return None
    return current.completed_at if current.done else now


def seed_demo_notes(store: NoteStore, now: datetime | None = None) -> None:
    """Fills the store with sample notes dated around today.

    Dates are relative to the moment the server starts, so every view (due
    today, overdue, pinned, done this week) has something to show on any day.
    """
    now = now or utc_now()
    today = now.astimezone().date()

    def due(days: int) -> date:
        return today + timedelta(days=days)

    def ago(days: float = 0, hours: float = 0) -> datetime:
        return now - timedelta(days=days, hours=hours)

    # (note, created at, done at). Oldest first, so ids follow creation order.
    samples: list[tuple[NoteInput, datetime, datetime | None]] = [
        (
            NoteInput(
                title="Books to read",
                content="Piranesi by Susanna Clarke\nThe Design of Everyday Things\nA Philosophy of Software Design",
            ),
            ago(9),
            None,
        ),
        (
            NoteInput(
                title="Fix the leaking tap",
                content="Washer is half an inch. The hardware store on the corner has them.",
                done=True,
            ),
            ago(8),
            ago(5),
        ),
        (
            NoteInput(
                title="Sketch the onboarding flow",
                content="Three screens at most. Skip the account step until the first note is saved.",
                category="ideas",
                done=True,
            ),
            ago(7),
            ago(4),
        ),
        (
            NoteInput(
                title="Renew passport",
                content="Photos are in the desk drawer. The fee can be paid online.",
                due_date=due(-2),
            ),
            ago(6, 4),
            None,
        ),
        (
            NoteInput(
                title="App idea: shared grocery lists",
                content="Each item shows who added it. Tap an item to claim it before you head out.",
                category="ideas",
                pinned=True,
            ),
            ago(6),
            None,
        ),
        (
            NoteInput(
                title="Call Mum about the trip",
                content="Dates, who picks up the keys, and whether the dog comes too.",
                done=True,
            ),
            ago(5),
            ago(2),
        ),
        (
            NoteInput(
                title="Questions for my next 1:1",
                content="Can the release move to next sprint?\nWho owns the onboarding doc now?",
                category="work",
                due_date=due(3),
            ),
            ago(4, 6),
            None,
        ),
        (
            NoteInput(
                title="Send invoice to Northwind",
                content="October hours plus the design review. Payment due in 30 days.",
                category="work",
                done=True,
            ),
            ago(4),
            ago(1),
        ),
        (
            NoteInput(
                title="Try the 20-minute stretch routine",
                content="Hips, hamstrings, then shoulders. Every morning before coffee.",
                category="health",
            ),
            ago(3),
            None,
        ),
        (
            NoteInput(
                title="Book a dentist appointment",
                content="Ask about a cleaning. Morning slots work best.",
                category="health",
                due_date=due(1),
            ),
            ago(2),
            None,
        ),
        (
            NoteInput(
                title="Weekend market list",
                content="Sourdough\nTomatoes\nFresh basil\nFlowers for the table",
                category="shopping",
                due_date=due(2),
            ),
            ago(1, 3),
            None,
        ),
        (
            NoteInput(
                title="Grocery run",
                content="Oat milk\nEggs\nBasil and lemons\nCoffee beans, the dark roast",
                category="shopping",
                done=True,
            ),
            ago(1),
            ago(hours=2),
        ),
        (
            NoteInput(
                title="Morning run",
                content="5 km along the river.",
                category="health",
                done=True,
            ),
            ago(hours=6),
            ago(hours=5),
        ),
        (
            NoteInput(
                title="Prepare the Q4 roadmap review",
                content="Pull usage numbers from the dashboard\nDraft three options for the hiring plan\nSend the deck before 4pm",
                category="work",
                due_date=due(0),
                pinned=True,
            ),
            ago(hours=3),
            None,
        ),
        (
            NoteInput(
                title="Pay the electricity bill",
                content="Account number is on the last letter.",
                due_date=due(0),
            ),
            ago(hours=1),
            None,
        ),
    ]

    for data, created_at, done_at in samples:
        note = store.create(data.model_copy(update={"done": False}), now=created_at)
        if done_at is not None:
            store.update(note.id, data, now=done_at)


_store = NoteStore()
seed_demo_notes(_store)


def get_store() -> NoteStore:
    """A dependency, so tests can swap in a fresh store per test."""
    return _store


Store = Annotated[NoteStore, Depends(get_store)]

# The app is published under /api. Locally the Vite proxy strips that prefix;
# on Vercel the request keeps it. With root_path set, routing drops a leading
# /api when there is one, so /notes and /api/notes reach the same endpoint.
app = FastAPI(title="Notes API", root_path="/api")
app.add_middleware(GZipMiddleware, minimum_size=1024)

# The largest valid note is about 40 KB of JSON, even written entirely in
# emoji or escaped characters. Anything far bigger is refused unread.
MAX_BODY_BYTES = 128 * 1024

# Local responses arrive in a few milliseconds, which hides loading states.
# Start the server with NOTES_API_LATENCY_MS=800 to watch them.
LATENCY_MS = int(os.getenv("NOTES_API_LATENCY_MS", "0"))


@app.middleware("http")
async def limit_body_and_simulate_latency(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
        return JSONResponse(
            {"detail": "That note is too large to save."},
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
        )
    if LATENCY_MS > 0:
        await asyncio.sleep(LATENCY_MS / 1000)
    return await call_next(request)


def _etag_matches(header: str | None, etag: str) -> bool:
    """Weak comparison, as HTTP asks for If-None-Match: ignore any W/ prefix."""
    if not header:
        return False
    tags = {tag.strip().removeprefix("W/") for tag in header.split(",")}
    return "*" in tags or etag.removeprefix("W/") in tags


@app.get("/notes", response_model=list[Note])
def list_notes(request: Request, store: Store) -> Response:
    body, etag = store.listing()
    # no-cache means "check with the server first", not "don't store".
    headers = {"ETag": etag, "Cache-Control": "no-cache"}
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(body, media_type="application/json", headers=headers)


@app.post("/notes", status_code=status.HTTP_201_CREATED)
def create_note(data: NoteInput, store: Store) -> Note:
    return store.create(data)


@app.put("/notes/{note_id}")
def update_note(note_id: int, data: NoteInput, store: Store) -> Note:
    note = store.update(note_id, data)
    if note is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Note {note_id} not found")
    return note


@app.delete("/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_note(note_id: int, store: Store) -> None:
    if not store.delete(note_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Note {note_id} not found")
