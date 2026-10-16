"""Accounts and private, database-backed notes for the Notes Dashboard.

Run locally with uvicorn backend.main:app --reload. Vercel imports this same
file as main, so the backend stays in one module.
"""

import asyncio
import hashlib
import html
import http.client
import json
import logging
import math
import os
import secrets
import sqlite3
import urllib.error
import urllib.request
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
from pydantic import BaseModel, ConfigDict, EmailStr, Field, TypeAdapter, field_validator, model_validator
from pwdlib import PasswordHash
from sqlalchemy import (
    Boolean, Date, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint,
    create_engine, delete, event, func, inspect, select, text, update,
)
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column
from sqlalchemy.types import TypeDecorator

# Settings and clocks are module-level so tests can control sessions and time.
SESSION_SECONDS = 7 * 24 * 60 * 60
ON_VERCEL = os.getenv("VERCEL") is not None
DATABASE_URL = os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL")
CONFIGURED_JWT_SECRET = os.getenv("NOTES_JWT_SECRET")
# Local sessions end on restart unless a persistent secret is configured.
JWT_SECRET = CONFIGURED_JWT_SECRET or secrets.token_urlsafe(32)
RESEND_API_KEY = os.getenv("RESEND_API_KEY")
EMAIL_FROM = os.getenv("NOTES_EMAIL_FROM", "Notes <onboarding@resend.dev>")
APP_URL = os.getenv("NOTES_APP_URL", "http://localhost:5173").rstrip("/")
VERIFY_TOKEN_LIFETIME = timedelta(hours=24)
RESET_TOKEN_LIFETIME = timedelta(hours=1)
EMAIL_MIN_INTERVAL = timedelta(seconds=60)
EMAIL_DAILY_WINDOW = timedelta(hours=24)
EMAIL_DAILY_LIMIT = 5
DATABASE_PREPARE_LOCK = 721437590218
CATEGORY_COLORS = ("lilac", "rose", "peach", "mint", "sky", "butter", "sage", "stone")
BUILTIN_CATEGORIES = {key: key.title() for key in ("work", "personal", "ideas", "shopping", "health")}
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
CategoryColor = Literal["lilac", "rose", "peach", "mint", "sky", "butter", "sage", "stone"]

# The frontend enforces the same limits. Its counts are UTF-16 units, which are
# never fewer than Python's code points, so it can't send what we refuse.
TITLE_MAX = 200
CONTENT_MAX = 10_000


class NoteInput(BaseModel):
    """What a client may send when creating or replacing a note."""

    model_config = ConfigDict(str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=TITLE_MAX)
    content: str = Field(default="", max_length=CONTENT_MAX)
    category: str = Field(default="personal", max_length=16)
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
    email_verified: bool


class TokenInput(BaseModel):
    token: str = Field(min_length=1, max_length=128)

    @field_validator("token")
    @classmethod
    def reject_nul(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("NUL characters are not allowed.")
        return value


class ForgotPasswordInput(BaseModel):
    email: str = Field(min_length=1, max_length=320)

    @field_validator("email", mode="before")
    @classmethod
    def normalise_email(cls, value: object) -> object:
        return LoginInput.normalise_email(value)


class ResetPasswordInput(TokenInput):
    password: str = Field(min_length=8, max_length=128)


class CategoryPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=24)
    color: CategoryColor | None = None

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value: object) -> object:
        if isinstance(value, str) and "\x00" in value:
            raise ValueError("NUL characters are not allowed.")
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def require_fields(self) -> "CategoryPatch":
        if not self.model_fields_set:
            raise ValueError("Choose a name or color to change.")
        if any(getattr(self, field) is None for field in self.model_fields_set):
            raise ValueError("Choose a name or color from the list.")
        return self


class CategoryInput(CategoryPatch):
    name: str = Field(min_length=1, max_length=24)
    color: CategoryColor


class Category(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    key: str
    name: str
    color: str


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
    email_verified_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    session_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    @property
    def email_verified(self) -> bool:
        return self.email_verified_at is not None


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


class EmailTokenRecord(Base):
    __tablename__ = "email_tokens"
    __table_args__ = {"sqlite_autoincrement": True}

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    purpose: Mapped[str] = mapped_column(String)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(320))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utc_now)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class CategoryRecord(Base):
    __tablename__ = "categories"
    __table_args__ = (UniqueConstraint("user_id", "name_key"), {"sqlite_autoincrement": True})

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(24))
    # Unicode case folding can expand one name character into three.
    name_key: Mapped[str] = mapped_column(String(72))
    color: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utc_now)

    @property
    def key(self) -> str:
        return f"c{self.id}"


def migrate_users(connection: Connection) -> None:
    """create_all leaves existing tables alone; add the two account fields."""
    columns = {column["name"] for column in inspect(connection).get_columns("users")}
    additions = {
        "email_verified_at": "TIMESTAMP NULL",
        "session_version": "INTEGER NOT NULL DEFAULT 0",
    }
    for name, definition in additions.items():
        if name not in columns:
            connection.execute(text(f"ALTER TABLE users ADD COLUMN {name} {definition}"))


def prepare_database(database: Engine) -> None:
    """Serialize cold starts before inspecting or changing the schema."""
    with database.begin() as connection:
        if connection.dialect.name == "postgresql":
            connection.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": DATABASE_PREPARE_LOCK})
        Base.metadata.create_all(connection)
        migrate_users(connection)


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
    if ON_VERCEL and not RESEND_API_KEY:
        raise RuntimeError("RESEND_API_KEY is required on Vercel; email links must not enter deployment logs.")
    if ON_VERCEL and not os.getenv("NOTES_APP_URL"):
        raise RuntimeError("NOTES_APP_URL is required on Vercel.")
    prepare_database(engine)
    yield


# Email delivery and single-use account links.
class EmailError(Exception):
    """Delivery failed; callers decide whether that should fail the request."""


class NoEmailRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A redirect is a delivery failure, and must not forward the API key.
        return None


def send_email(to: str, subject: str, text: str, html: str) -> None:
    logger = logging.getLogger("notes.email")
    if not RESEND_API_KEY:
        # Uvicorn configures its own loggers, so this one needs a local handler.
        if not logger.handlers:
            logger.addHandler(logging.StreamHandler())
        logger.setLevel(logging.INFO)
        logger.info("%s\nTo: %s\n%s", subject, to, text)
        return
    payload = {"from": EMAIL_FROM, "to": [to], "subject": subject, "text": text, "html": html}
    request = urllib.request.Request(
        "https://api.resend.com/emails", data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json",
                 "User-Agent": "notes-dashboard"},
    )
    error_body = b""
    code = None
    try:
        opener = urllib.request.build_opener(NoEmailRedirect())
        try:
            with opener.open(request, timeout=10) as response:
                code = response.status
                if 200 <= code < 300:
                    return
                error_body = response.read(16_384)
        except urllib.error.HTTPError as error:
            with error:
                code = error.code
                error_body = error.read(16_384)
    except (urllib.error.URLError, OSError, TimeoutError, http.client.HTTPException):
        pass
    try:
        error_fields = json.loads(error_body)
    except (ValueError, UnicodeError):
        error_fields = {}
    # Provider messages are untrusted too: remove anything from our payload,
    # including links, before logging the two allowed error fields.
    fields = {}
    for key in ("name", "message"):
        value = error_fields.get(key) if isinstance(error_fields, dict) else None
        if isinstance(value, str):
            links = [word for word in text.split() if "://" in word]
            private_values = [RESEND_API_KEY, text, html, *links]
            private_values.extend(link.rsplit("=", 1)[-1] for link in links)
            for private in private_values:
                if private:
                    value = value.replace(private, "[redacted]")
            fields[key] = value[:500]
    logger.warning("Email delivery failed: status=%s name=%s message=%s", code, fields.get("name"), fields.get("message"))
    raise EmailError("Email delivery failed.") from None


def account_email(user: UserRecord, purpose: str, raw: str) -> tuple[str, str, str]:
    if purpose == "verify_email":
        subject = "Confirm your email for Notes"
        intro = "Confirm that this is your email address so you can reset your password if you ever forget it."
        label = "Confirm email"
        ending = "The link works for 24 hours. If you didn't create a Notes account, ignore this email."
        link = f"{APP_URL}/#verify-email={raw}"
    else:
        subject = "Reset your Notes password"
        intro = "Someone asked to reset the password for your Notes account. If it was you, choose a new password here:"
        label = "Choose a new password"
        ending = "The link works for 1 hour and only once. If you didn't ask, ignore this email: your password stays the same."
        link = f"{APP_URL}/#reset-password={raw}"
    text_body = f"Hi {user.name},\n\n{intro}\n\n{label}: {link}\n\n{ending}"
    html_body = (
        '<div style="font-family: sans-serif; line-height: 1.5; color: #29252e">'
        f'<p>Hi {html.escape(user.name)},</p><p>{html.escape(intro)}</p>'
        f'<p><a style="color: #665091" href="{html.escape(link, quote=True)}">{label}</a></p>'
        f'<p>{html.escape(ending)}</p></div>'
    )
    return subject, text_body, html_body


def lock_user(session: Session, user_id: int) -> UserRecord:
    # SQLite has no row locks. A no-op write takes its writer lock before
    # checking limits, so simultaneous local requests cannot both pass them.
    if session.get_bind().dialect.name == "sqlite":
        session.execute(update(UserRecord).where(UserRecord.id == user_id).values(
            session_version=UserRecord.session_version,
        ))
    # Refresh because authentication may have loaded an earlier version.
    return session.scalar(
        select(UserRecord).where(UserRecord.id == user_id).with_for_update()
        .execution_options(populate_existing=True)
    )


def email_limit(session: Session, user_id: int, purpose: str) -> tuple[str, int] | None:
    now = utc_now()
    times = list(session.scalars(
        select(EmailTokenRecord.created_at).where(
            EmailTokenRecord.user_id == user_id, EmailTokenRecord.purpose == purpose,
            EmailTokenRecord.created_at > now - EMAIL_DAILY_WINDOW,
        ).order_by(EmailTokenRecord.created_at)
    ))
    if times and times[-1] + EMAIL_MIN_INTERVAL > now:
        seconds = math.ceil((times[-1] + EMAIL_MIN_INTERVAL - now).total_seconds())
        return "Wait a minute before asking for another email.", max(1, seconds)
    if len(times) >= EMAIL_DAILY_LIMIT:
        seconds = math.ceil((times[-EMAIL_DAILY_LIMIT] + EMAIL_DAILY_WINDOW - now).total_seconds())
        return "You've asked for 5 emails today. Try again tomorrow.", max(1, seconds)
    return None


def send_account_email(session: Session, user: UserRecord, purpose: str) -> int:
    raw = secrets.token_urlsafe(32)
    now = utc_now()
    recipient = user.email
    message = account_email(user, purpose, raw)
    record = EmailTokenRecord(
        user_id=user.id, purpose=purpose, token_hash=hashlib.sha256(raw.encode()).hexdigest(),
        email=user.email, created_at=now,
        expires_at=now + (VERIFY_TOKEN_LIFETIME if purpose == "verify_email" else RESET_TOKEN_LIFETIME),
    )
    session.add(record)
    session.flush()
    record_id = record.id
    # The committed token reserves the limit while delivery runs without locks.
    # Save the payload and id first because commit expires ORM attributes.
    session.commit()
    try:
        send_email(recipient, *message)
    except EmailError:
        # Remove only this failed send so earlier links and limits survive.
        session.execute(delete(EmailTokenRecord).where(EmailTokenRecord.id == record_id))
        session.commit()
        raise
    return record_id


INVALID_LINK = "This link has expired or was already used."


def find_email_token(session: Session, raw: str, purpose: str) -> tuple[EmailTokenRecord, UserRecord]:
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    record = session.scalar(select(EmailTokenRecord).where(EmailTokenRecord.token_hash == token_hash))
    if record is None or record.purpose != purpose:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, INVALID_LINK)
    user = lock_user(session, record.user_id)
    session.refresh(record)
    if user is None or record.email != user.email:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, INVALID_LINK)
    return record, user


# Category ownership is checked before a note can store a custom key.
def find_user_category(session: Session, user_id: int, category_id: int) -> CategoryRecord:
    if 1 <= category_id <= 2**31 - 1:
        record = session.scalar(select(CategoryRecord).where(
            CategoryRecord.user_id == user_id, CategoryRecord.id == category_id,
        ))
        if record is not None:
            return record
    raise HTTPException(status.HTTP_404_NOT_FOUND, f"Category {category_id} not found")


def validate_note_category(session: Session, user_id: int, key: str) -> None:
    if key in BUILTIN_CATEGORIES:
        return
    if key.startswith("c") and key[1:].isascii() and key[1:].isdigit():
        category_id = int(key[1:])
        if key == f"c{category_id}" and 1 <= category_id <= 2**31 - 1:
            if session.scalar(select(CategoryRecord.id).where(
                CategoryRecord.id == category_id, CategoryRecord.user_id == user_id,
            )) is not None:
                return
    raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose a category from the list.")


def check_category_name(session: Session, user_id: int, name: str, category_id: int | None = None) -> None:
    spelling = next((label for label in BUILTIN_CATEGORIES.values() if label.casefold() == name.casefold()), None)
    if spelling is None:
        query = select(CategoryRecord).where(
            CategoryRecord.user_id == user_id, CategoryRecord.name_key == name.casefold(),
        )
        if category_id is not None:
            query = query.where(CategoryRecord.id != category_id)
        existing = session.scalar(query)
        spelling = existing.name if existing else None
    if spelling is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f'You already have a category called "{spelling}".')


def commit_category(session: Session, user_id: int, name: str, category_id: int | None = None) -> None:
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        # The database constraint is the final guard if a concurrent name wins.
        check_category_name(session, user_id, name, category_id)
        raise


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
    user = session.get(UserRecord, user_id)
    return user if user and claims.get("sv", 0) == user.session_version else None


def current_user(user: Annotated[UserRecord | None, Depends(session_user)]) -> UserRecord:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Log in to see your notes.")
    return user


CurrentUser = Annotated[UserRecord, Depends(current_user)]


def cookie_secure(request: Request) -> bool:
    return ON_VERCEL or request.url.scheme == "https"


def set_session_cookie(response: Response, request: Request, user: UserRecord) -> None:
    now = utc_now()
    token = jwt.encode(
        {"sub": str(user.id), "sv": user.session_version, "iat": now, "exp": now + timedelta(seconds=SESSION_SECONDS)},
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
    try:
        user = lock_user(session, user.id)
        # Login can succeed after the account commit but before this send.
        # Share the resend lock and limit so those requests cannot send twice.
        if not email_limit(session, user.id, "verify_email"):
            send_account_email(session, user, "verify_email")
        session.commit()
    except EmailError:
        session.rollback()
        logging.getLogger("notes.email").warning("Signup confirmation email could not be sent.")
    set_session_cookie(response, request, user)
    return User.model_validate(user)


@app.post("/auth/login", response_model=User)
def login(data: LoginInput, request: Request, response: Response, session: Database) -> User:
    user = session.scalar(select(UserRecord).where(UserRecord.email == data.email))
    valid = PASSWORD_HASH.verify(data.password, user.password_hash if user else DUMMY_HASH)
    if user is None or not valid:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, LOGIN_FAILED)
    set_session_cookie(response, request, user)
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


@app.post("/auth/verify-email/resend", status_code=status.HTTP_204_NO_CONTENT)
def resend_verification(session: Database, user: CurrentUser) -> None:
    user = lock_user(session, user.id)
    if user.email_verified:
        raise HTTPException(status.HTTP_409_CONFLICT, "Your email is already confirmed.")
    limit = email_limit(session, user.id, "verify_email")
    if limit:
        message, seconds = limit
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, message, headers={"Retry-After": str(seconds)})
    try:
        send_account_email(session, user, "verify_email")
    except EmailError:
        session.rollback()
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "We couldn't send the email. Try again in a few minutes.") from None


@app.post("/auth/verify-email", status_code=status.HTTP_204_NO_CONTENT)
def verify_email(data: TokenInput, session: Database) -> None:
    record, user = find_email_token(session, data.token, "verify_email")
    if record.used_at is not None:
        if user.email_verified:
            return
        raise HTTPException(status.HTTP_400_BAD_REQUEST, INVALID_LINK)
    if record.expires_at <= utc_now():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, INVALID_LINK)
    now = utc_now()
    user.email_verified_at = user.email_verified_at or now
    record.used_at = now
    session.commit()


@app.post("/auth/password/forgot", status_code=status.HTTP_202_ACCEPTED)
def forgot_password(data: ForgotPasswordInput, session: Database) -> Response:
    try:
        user = session.scalar(select(UserRecord).where(UserRecord.email == data.email))
        if user is not None:
            user = lock_user(session, user.id)
            if not email_limit(session, user.id, "reset_password"):
                user_id = user.id
                record_id = send_account_email(session, user, "reset_password")
                # Keep earlier links usable until the replacement was delivered.
                session.execute(update(EmailTokenRecord).where(
                    EmailTokenRecord.user_id == user_id, EmailTokenRecord.purpose == "reset_password",
                    EmailTokenRecord.used_at.is_(None), EmailTokenRecord.id != record_id,
                ).values(used_at=utc_now()))
                session.commit()
    except EmailError:
        session.rollback()
        logging.getLogger("notes.email").warning("Password reset email could not be sent.")
    except OperationalError:
        session.rollback()
        logging.getLogger("notes.email").warning("Password reset database work could not be completed.")
    return Response(status_code=status.HTTP_202_ACCEPTED)


@app.post("/auth/password/reset", response_model=User)
def reset_password(data: ResetPasswordInput, request: Request, response: Response, session: Database) -> User:
    record, user = find_email_token(session, data.token, "reset_password")
    now = utc_now()
    if record.used_at is not None or record.expires_at <= now:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, INVALID_LINK)
    # Claim the link atomically, also on SQLite where FOR UPDATE is unavailable.
    claimed = session.execute(update(EmailTokenRecord).where(
        EmailTokenRecord.id == record.id, EmailTokenRecord.used_at.is_(None),
    ).values(used_at=now))
    if claimed.rowcount != 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, INVALID_LINK)
    session.refresh(user)
    user.password_hash = PASSWORD_HASH.hash(data.password)
    user.session_version += 1
    user.email_verified_at = user.email_verified_at or now
    session.execute(update(EmailTokenRecord).where(
        EmailTokenRecord.user_id == user.id, EmailTokenRecord.purpose == "reset_password",
        EmailTokenRecord.used_at.is_(None),
    ).values(used_at=now))
    session.commit()
    set_session_cookie(response, request, user)
    return User.model_validate(user)


# Custom categories belong to an account, just like notes.
@app.get("/categories", response_model=list[Category])
def list_categories(session: Database, user: CurrentUser) -> list[Category]:
    records = session.scalars(select(CategoryRecord).where(CategoryRecord.user_id == user.id)
                              .order_by(CategoryRecord.created_at, CategoryRecord.id))
    return [Category.model_validate(record) for record in records]


@app.post("/categories", status_code=status.HTTP_201_CREATED, response_model=Category)
def create_category(data: CategoryInput, session: Database, user: CurrentUser) -> Category:
    lock_user(session, user.id)
    check_category_name(session, user.id, data.name)
    count = session.scalar(select(func.count()).select_from(CategoryRecord).where(CategoryRecord.user_id == user.id))
    if count >= 20:
        raise HTTPException(status.HTTP_409_CONFLICT, "You can have up to 20 categories of your own.")
    record = CategoryRecord(
        user_id=user.id, name=data.name, name_key=data.name.casefold(), color=data.color,
        created_at=utc_now(),
    )
    session.add(record)
    commit_category(session, user.id, data.name)
    return Category.model_validate(record)


@app.patch("/categories/{category_id}", response_model=Category)
def update_category(category_id: int, data: CategoryPatch, session: Database, user: CurrentUser) -> Category:
    lock_user(session, user.id)
    record = find_user_category(session, user.id, category_id)
    if data.name is not None:
        check_category_name(session, user.id, data.name, record.id)
        record.name = data.name
        record.name_key = data.name.casefold()
    if data.color is not None:
        record.color = data.color
    name = record.name
    commit_category(session, user.id, name, category_id)
    return Category.model_validate(record)


@app.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(category_id: int, session: Database, user: CurrentUser) -> None:
    lock_user(session, user.id)
    record = find_user_category(session, user.id, category_id)
    session.execute(update(NoteRecord).where(
        NoteRecord.user_id == user.id, NoteRecord.category == record.key,
    ).values(category="personal"))
    session.delete(record)
    session.commit()


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
    lock_user(session, user.id)
    validate_note_category(session, user.id, data.category)
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
    lock_user(session, user.id)
    validate_note_category(session, user.id, data.category)
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
