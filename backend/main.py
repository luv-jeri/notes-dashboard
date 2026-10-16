"""Accounts and private, database-backed notes for the Notes Dashboard.

Run locally with uvicorn backend.main:app --reload. Vercel imports this same
file as main, so the backend stays in one module.
"""

import asyncio
import hashlib
import os
import secrets
import sqlite3
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Annotated, Iterator, Literal

import jwt
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, EmailStr, Field, TypeAdapter, field_validator
from pwdlib import PasswordHash
from sqlalchemy import Boolean, Date, DateTime, ForeignKey, String, Text, create_engine, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column
from sqlalchemy.types import TypeDecorator

# Settings and clocks are module-level so tests can control sessions and time.
SESSION_SECONDS = 7 * 24 * 60 * 60
ON_VERCEL = os.getenv("VERCEL") is not None
DATABASE_URL = os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL")
CONFIGURED_JWT_SECRET = os.getenv("NOTES_JWT_SECRET")
# Local sessions end on restart unless a persistent secret is configured.
JWT_SECRET = CONFIGURED_JWT_SECRET or secrets.token_urlsafe(32)
PASSWORD_HASH = PasswordHash.recommended()
DUMMY_HASH = PASSWORD_HASH.hash(secrets.token_urlsafe(32))


def utc_now() -> datetime:
    return datetime.now(UTC)


def database_url(url: str | None) -> str:
    """Use psycopg for Neon's URLs, and a stable local file for development."""
    if not url:
        return f"sqlite:///{Path(__file__).parent / 'notes.db'}"
    if url.startswith(("postgres://", "postgresql://")):
        return "postgresql+psycopg://" + url.split("://", 1)[1]
    return url


@event.listens_for(Engine, "connect")
def enable_sqlite_foreign_keys(connection, connection_record) -> None:
    """SQLite needs this switch for ON DELETE CASCADE to take effect."""
    if isinstance(connection, sqlite3.Connection):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


def make_engine(url: str) -> Engine:
    if url.startswith("sqlite:"):
        return create_engine(url, connect_args={"check_same_thread": False}, hide_parameters=True)
    return create_engine(
        url,
        hide_parameters=True,
        pool_pre_ping=True,
        pool_recycle=300,
        pool_size=5,
        max_overflow=5,
        connect_args={"prepare_threshold": None},
    )


engine = make_engine(database_url(DATABASE_URL))

# Request and response shapes. Password whitespace is deliberately preserved.
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

    @field_validator("title", "content")
    @classmethod
    def reject_nul(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("NUL characters are not allowed.")
        return value


class Note(NoteInput):
    id: int
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None


class LoginInput(BaseModel):
    # No shape rules here: a value no account could have fails as a plain
    # mismatch, so the log-in form never shows a signup rule.
    email: str = Field(min_length=1, max_length=320)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email", mode="before")
    @classmethod
    def normalise_email(cls, value: object) -> object:
        if isinstance(value, str) and "\x00" in value:
            raise ValueError("NUL characters are not allowed.")
        return value.strip().lower() if isinstance(value, str) else value


class SignupInput(LoginInput):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(min_length=1, max_length=60)

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value: object) -> object:
        if isinstance(value, str) and "\x00" in value:
            raise ValueError("NUL characters are not allowed.")
        return value.strip() if isinstance(value, str) else value


class User(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str


_note_list = TypeAdapter(list[Note])

# Database models and per-request sessions.
class UTCDateTime(TypeDecorator[datetime]):
    """Store naive UTC so SQLite and Postgres return the same aware values."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        if value is None:
            return None
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        return value.replace(tzinfo=UTC) if value is not None else None


class Base(DeclarativeBase):
    pass


class UserRecord(Base):
    __tablename__ = "users"
    # A deleted account's id must never identify a later account in an old JWT.
    __table_args__ = {"sqlite_autoincrement": True}

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(60))
    email: Mapped[str] = mapped_column(String(320), unique=True)
    password_hash: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utc_now)


class NoteRecord(Base):
    __tablename__ = "notes"
    __table_args__ = {"sqlite_autoincrement": True}

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(TITLE_MAX))
    content: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String)
    due_date: Mapped[date | None] = mapped_column(Date)
    pinned: Mapped[bool] = mapped_column(Boolean)
    done: Mapped[bool] = mapped_column(Boolean)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


def get_db() -> Iterator[Session]:
    """Endpoints own commits; closing the session rolls back unfinished work."""
    with Session(engine) as session:
        yield session


Database = Annotated[Session, Depends(get_db)]


@asynccontextmanager
async def lifespan(app: FastAPI):
    if ON_VERCEL and not DATABASE_URL:
        raise RuntimeError("DATABASE_URL or POSTGRES_URL is required on Vercel; SQLite cannot persist notes there.")
    if ON_VERCEL and not CONFIGURED_JWT_SECRET:
        raise RuntimeError("NOTES_JWT_SECRET is required on Vercel.")
    Base.metadata.create_all(engine)
    yield


# Note operations always take the account id, including lookup for writes.
def list_user_notes(session: Session, user_id: int) -> list[Note]:
    records = session.scalars(
        select(NoteRecord)
        .where(NoteRecord.user_id == user_id)
        .order_by(NoteRecord.created_at.desc(), NoteRecord.id.desc())
    )
    return [Note.model_validate(record, from_attributes=True) for record in records]


def create_user_note(
    session: Session, user_id: int, data: NoteInput, now: datetime | None = None
) -> NoteRecord:
    now = now or utc_now()
    record = NoteRecord(
        user_id=user_id,
        **data.model_dump(),
        created_at=now,
        updated_at=now,
        completed_at=now if data.done else None,
    )
    session.add(record)
    return record


def find_user_note(session: Session, user_id: int, note_id: int) -> NoteRecord:
    # Mapped[int] uses INTEGER, which is signed 32-bit on Postgres.
    if not 1 <= note_id <= 2**31 - 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Note {note_id} not found")
    record = session.scalar(
        select(NoteRecord).where(NoteRecord.user_id == user_id, NoteRecord.id == note_id)
    )
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Note {note_id} not found")
    return record


def _completed_at(current: NoteRecord, data: NoteInput, now: datetime) -> datetime | None:
    """Keeps the original "done" time when a done note is edited again."""
    if not data.done:
        return None
    return current.completed_at if current.done else now


def add_sample_notes(session: Session, user_id: int, now: datetime | None = None) -> None:
    """Adds sample notes for one account, dated around today.

    Dates are relative to the request, so every view (due
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
        note = create_user_note(session, user_id, data, now=created_at)
        if done_at is not None:
            note.completed_at = done_at
            note.updated_at = done_at


# Session cookies and account authentication.
def session_user(request: Request, session: Database) -> UserRecord | None:
    token = request.cookies.get("notes_session")
    if not token:
        return None
    try:
        claims = jwt.decode(
            token, JWT_SECRET, algorithms=["HS256"], options={"require": ["exp", "sub"]}
        )
        user_id = int(claims["sub"])
    except (jwt.PyJWTError, ValueError, TypeError, OverflowError):
        return None
    # An arbitrary integer in a signed token must not overflow a DB parameter.
    if not 0 < user_id <= 2**63 - 1:
        return None
    return session.get(UserRecord, user_id)


def current_user(user: Annotated[UserRecord | None, Depends(session_user)]) -> UserRecord:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Log in to see your notes.")
    return user


CurrentUser = Annotated[UserRecord, Depends(current_user)]


def cookie_secure(request: Request) -> bool:
    return ON_VERCEL or request.url.scheme == "https"


def set_session_cookie(response: Response, request: Request, user_id: int) -> None:
    now = utc_now()
    token = jwt.encode(
        {"sub": str(user_id), "iat": now, "exp": now + timedelta(seconds=SESSION_SECONDS)},
        JWT_SECRET,
        algorithm="HS256",
    )
    response.set_cookie(
        "notes_session", token, max_age=SESSION_SECONDS, httponly=True,
        samesite="lax", path="/", secure=cookie_secure(request),
    )


# The app is published under /api. Locally the Vite proxy strips that prefix;
# on Vercel the request keeps it. With root_path set, routing drops a leading
# /api when there is one, so /notes and /api/notes reach the same endpoint.
app = FastAPI(title="Notes API", root_path="/api")
app.router.lifespan_context = lifespan
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    if request.url.path.removeprefix("/api").startswith("/auth/"):
        # Inputs can contain the whole body, including passwords; context can
        # also carry submitted values. Keep only the public error description.
        errors = [
            {key: error[key] for key in ("loc", "msg", "type")}
            for error in exc.errors()
        ]
        return JSONResponse({"detail": errors}, status_code=status.HTTP_422_UNPROCESSABLE_CONTENT)
    return await request_validation_exception_handler(request, exc)


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
            headers={"Cache-Control": "no-store"}
            if request.url.path.removeprefix("/api").startswith("/auth/") else None,
        )
    if LATENCY_MS > 0:
        await asyncio.sleep(LATENCY_MS / 1000)
    response = await call_next(request)
    # Include validation errors and failed logins: account responses never cache.
    if request.url.path.removeprefix("/api").startswith("/auth/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def _etag_matches(header: str | None, etag: str) -> bool:
    """Weak comparison, as HTTP asks for If-None-Match: ignore any W/ prefix."""
    if not header:
        return False
    tags = {tag.strip().removeprefix("W/") for tag in header.split(",")}
    return "*" in tags or etag.removeprefix("W/") in tags


# Account endpoints.
DUPLICATE_EMAIL = "An account with that email already exists. Log in instead."
LOGIN_FAILED = "That email and password don't match an account."


@app.post("/auth/signup", status_code=status.HTTP_201_CREATED, response_model=User)
def signup(data: SignupInput, request: Request, response: Response, session: Database) -> User:
    if session.scalar(select(UserRecord).where(UserRecord.email == data.email)) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, DUPLICATE_EMAIL)
    user = UserRecord(name=data.name, email=str(data.email), password_hash=PASSWORD_HASH.hash(data.password))
    session.add(user)
    try:
        session.commit()
    except IntegrityError:
        # A concurrent signup can win after the earlier lookup.
        session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, DUPLICATE_EMAIL) from None
    session.refresh(user)
    set_session_cookie(response, request, user.id)
    return User.model_validate(user)


@app.post("/auth/login", response_model=User)
def login(data: LoginInput, request: Request, response: Response, session: Database) -> User:
    user = session.scalar(select(UserRecord).where(UserRecord.email == data.email))
    valid = PASSWORD_HASH.verify(data.password, user.password_hash if user else DUMMY_HASH)
    if user is None or not valid:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, LOGIN_FAILED)
    set_session_cookie(response, request, user.id)
    return User.model_validate(user)


@app.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, response: Response) -> None:
    if "notes_session" in request.cookies:
        response.delete_cookie(
            "notes_session", path="/", samesite="lax", secure=cookie_secure(request), httponly=True,
        )


@app.get("/auth/me", response_model=User | None)
def me(user: Annotated[UserRecord | None, Depends(session_user)]) -> User | None:
    return User.model_validate(user) if user else None


# Private notes retain the original validation, timestamps and ETag protocol.
@app.get("/notes", response_model=list[Note])
def list_notes(request: Request, session: Database, user: CurrentUser) -> Response:
    body = _note_list.dump_json(list_user_notes(session, user.id))
    etag = f'W/"{hashlib.blake2b(body, digest_size=16).hexdigest()}"'
    # A browser may keep its copy, but a shared cache must never store it.
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(body, media_type="application/json", headers=headers)


@app.post("/notes", status_code=status.HTTP_201_CREATED)
def create_note(data: NoteInput, session: Database, user: CurrentUser) -> Note:
    record = create_user_note(session, user.id, data)
    session.commit()
    session.refresh(record)
    return Note.model_validate(record, from_attributes=True)


@app.post("/notes/samples", status_code=status.HTTP_201_CREATED)
def samples(session: Database, user: CurrentUser) -> list[Note]:
    add_sample_notes(session, user.id)
    session.commit()
    return list_user_notes(session, user.id)


@app.put("/notes/{note_id}")
def update_note(note_id: int, data: NoteInput, session: Database, user: CurrentUser) -> Note:
    record = find_user_note(session, user.id, note_id)
    now = utc_now()
    record.completed_at = _completed_at(record, data, now)
    for field, value in data.model_dump().items():
        setattr(record, field, value)
    record.updated_at = now
    session.commit()
    session.refresh(record)
    return Note.model_validate(record, from_attributes=True)


@app.delete("/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_note(note_id: int, session: Database, user: CurrentUser) -> None:
    record = find_user_note(session, user.id, note_id)
    session.delete(record)
    session.commit()
