import io
import json
import logging
import os
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, inspect, select, text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend import main
from backend.main import (
    CONTENT_MAX, MAX_BODY_BYTES, TITLE_MAX, Base, CategoryRecord, EmailTokenRecord, NoteRecord, UserRecord,
    app, database_url, get_db,
)


REAL_SEND_EMAIL = main.send_email


@pytest.fixture(autouse=True)
def outbox(monkeypatch):
    messages = []
    monkeypatch.setattr(main, "send_email", lambda to, subject, text, html: messages.append(
        {"to": to, "subject": subject, "text": text, "html": html}
    ))
    monkeypatch.setattr(main, "APP_URL", "https://notes.example")

    def block_network(*args, **kwargs):
        pytest.fail("Tests must never send network requests")

    monkeypatch.setattr(main.urllib.request, "urlopen", block_network)
    monkeypatch.setattr(main.urllib.request.OpenerDirector, "open", block_network)
    return messages


@pytest.fixture
def database(monkeypatch):
    url = os.getenv("NOTES_TEST_DATABASE_URL")
    if url:
        engine = main.make_engine(database_url(url))
        Base.metadata.drop_all(engine)
    else:
        engine = create_engine(
            "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
        )
    Base.metadata.create_all(engine)
    monkeypatch.setattr(main, "engine", engine)
    # Tests never use deployment credentials or inherit deployment-only startup rules.
    monkeypatch.setattr(main, "ON_VERCEL", False)
    monkeypatch.setattr(main, "JWT_SECRET", "test-only-signing-key-with-at-least-32-bytes")

    def test_session():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_db] = test_session
    yield engine
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture
def anonymous(database):
    with TestClient(app) as client:
        yield client


@pytest.fixture
def make_client(database):
    clients = []

    def create(email="owner@example.com", password="correct horse", name="Owner"):
        client = TestClient(app)
        clients.append(client)
        response = client.post(
            "/auth/signup", json={"name": name, "email": email, "password": password}
        )
        assert response.status_code == 201
        return client

    yield create
    for client in clients:
        client.close()


@pytest.fixture
def client(make_client):
    return make_client()


def test_create_assigns_ids_and_lists_newest_first(client):
    first = client.post("/notes", json={"title": "First", "content": "a"})
    second = client.post("/notes", json={"title": "Second", "content": "b"})

    assert first.status_code == 201
    assert first.json()["id"] == 1
    assert second.json()["id"] == 2
    assert [note["title"] for note in client.get("/notes").json()] == ["Second", "First"]


def test_create_fills_defaults_and_timestamps(client):
    note = client.post("/notes", json={"title": "Plain"}).json()

    assert note["content"] == ""
    assert note["category"] == "personal"
    assert note["due_date"] is None
    assert note["pinned"] is False
    assert note["done"] is False
    assert note["completed_at"] is None
    assert note["created_at"] == note["updated_at"]


def test_create_ignores_client_supplied_id_and_timestamps(client):
    response = client.post(
        "/notes",
        json={"id": 99, "title": "Mine", "created_at": "2000-01-01T00:00:00Z"},
    )

    assert response.json()["id"] == 1
    assert not response.json()["created_at"].startswith("2000")


def test_create_rejects_a_blank_title(client):
    response = client.post("/notes", json={"title": "   ", "content": "body"})

    assert response.status_code == 422


def test_title_and_content_limits_are_inclusive(client):
    at_limit = client.post("/notes", json={"title": "t" * TITLE_MAX, "content": "c" * CONTENT_MAX})
    long_title = client.post("/notes", json={"title": "t" * (TITLE_MAX + 1)})
    long_content = client.post("/notes", json={"title": "Fine", "content": "c" * (CONTENT_MAX + 1)})

    assert at_limit.status_code == 201
    assert long_title.status_code == 422
    assert long_content.status_code == 422


def test_an_oversized_body_is_refused_unread(client):
    response = client.post(
        "/notes",
        content=b'{"title": "Big", "content": "' + b"x" * MAX_BODY_BYTES + b'"}',
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "That note is too large to save."}


def test_list_answers_304_until_a_write_changes_it(client):
    client.post("/notes", json={"title": "Cached"})
    first = client.get("/notes")
    etag = first.headers["etag"]

    unchanged = client.get("/notes", headers={"If-None-Match": etag})
    client.put("/notes/1", json={"title": "Cached, edited"})
    changed = client.get("/notes", headers={"If-None-Match": etag})

    assert first.headers["cache-control"] == "private, no-cache"
    assert unchanged.status_code == 304
    assert unchanged.content == b""
    assert changed.status_code == 200
    assert changed.headers["etag"] != etag
    assert changed.json()[0]["title"] == "Cached, edited"


def test_a_large_list_is_gzipped(client):
    for index in range(50):
        client.post("/notes", json={"title": f"Note {index}", "content": "Some words. " * 20})

    response = client.get("/notes", headers={"Accept-Encoding": "gzip"})

    assert response.headers["content-encoding"] == "gzip"
    assert len(response.json()) == 50


def test_create_rejects_an_unknown_category(client):
    response = client.post("/notes", json={"title": "Odd", "category": "chores"})

    assert response.status_code == 422


def test_due_date_round_trips(client):
    note = client.post("/notes", json={"title": "Dated", "due_date": "2026-10-20"}).json()

    assert note["due_date"] == "2026-10-20"


def test_update_replaces_fields_and_keeps_created_at(client):
    created = client.post("/notes", json={"title": "Draft", "content": "old"}).json()

    response = client.put(
        "/notes/1",
        json={"title": "Final", "content": "new", "category": "work", "pinned": True},
    )

    updated = response.json()
    assert response.status_code == 200
    assert (updated["title"], updated["content"], updated["category"], updated["pinned"]) == (
        "Final",
        "new",
        "work",
        True,
    )
    assert updated["created_at"] == created["created_at"]
    assert updated["updated_at"] >= created["updated_at"]


def test_done_time_is_recorded_kept_on_edit_and_cleared_on_undo(client):
    client.post("/notes", json={"title": "Task"})

    done = client.put("/notes/1", json={"title": "Task", "done": True}).json()
    edited = client.put("/notes/1", json={"title": "Task, renamed", "done": True}).json()
    undone = client.put("/notes/1", json={"title": "Task, renamed", "done": False}).json()

    assert done["completed_at"] is not None
    assert edited["completed_at"] == done["completed_at"]
    assert undone["completed_at"] is None


def test_update_of_a_missing_note_returns_404(client):
    response = client.put("/notes/42", json={"title": "Ghost", "content": ""})

    assert response.status_code == 404
    assert response.json() == {"detail": "Note 42 not found"}


def test_delete_removes_the_note(client):
    client.post("/notes", json={"title": "Temp", "content": ""})

    response = client.delete("/notes/1")

    assert response.status_code == 204
    assert client.get("/notes").json() == []


def test_delete_of_a_missing_note_returns_404(client):
    assert client.delete("/notes/42").status_code == 404


def test_samples_give_every_view_something_to_show(client, monkeypatch):
    now = datetime(2026, 10, 16, 12, tzinfo=UTC)
    today = now.astimezone().date()
    monkeypatch.setattr(main, "utc_now", lambda: now)

    response = client.post("/notes/samples")

    assert response.status_code == 201
    notes = response.json()
    assert len(notes) == 15
    open_notes = [note for note in notes if not note["done"]]
    done_notes = [note for note in notes if note["done"]]
    assert any(note["due_date"] == today.isoformat() for note in open_notes)
    assert any(note["due_date"] and note["due_date"] < today.isoformat() for note in open_notes)
    assert any(note["pinned"] for note in open_notes)
    assert done_notes
    assert all(
        now - timedelta(days=7) < datetime.fromisoformat(note["completed_at"]) <= now
        for note in done_notes
    )
    assert {note["category"] for note in notes} == {"work", "personal", "ideas", "shopping", "health"}
    assert notes == client.get("/notes").json()


def test_signup_sets_cookie_and_returns_only_public_fields(anonymous):
    response = anonymous.post(
        "/auth/signup", json={"name": "  Jane  ", "email": " Jane@Example.COM ", "password": "secret pass"}
    )

    assert response.status_code == 201
    assert response.json() == {"id": 1, "name": "Jane", "email": "jane@example.com", "email_verified": False}
    cookie = response.headers["set-cookie"].lower()
    assert "notes_session=" in cookie
    assert "httponly" in cookie
    assert "samesite=lax" in cookie
    assert "path=/" in cookie
    assert "max-age=604800" in cookie
    assert "secure" not in cookie
    assert response.headers["cache-control"] == "no-store"
    assert anonymous.get("/notes").json() == []


def test_duplicate_email_is_case_insensitive(client):
    response = client.post(
        "/auth/signup", json={"name": "Other", "email": "OWNER@EXAMPLE.COM", "password": "another pass"}
    )
    assert response.status_code == 409
    assert response.json() == {"detail": main.DUPLICATE_EMAIL}
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("fields", [
    {"email": "invalid"}, {"password": "short"}, {"password": "x" * 129},
    {"name": "   "}, {"name": "x" * 61},
])
def test_signup_validates_account_fields(anonymous, fields):
    data = {"name": "Name", "email": "valid@example.com", "password": "valid pass"}
    response = anonymous.post("/auth/signup", json=data | fields)
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"


def test_password_spaces_are_preserved(make_client):
    client = make_client(password="  spaced pass  ")
    client.post("/auth/logout")
    assert client.post(
        "/auth/login", json={"email": "owner@example.com", "password": "  spaced pass  "}
    ).status_code == 200
    assert client.post(
        "/auth/login", json={"email": "owner@example.com", "password": "spaced pass"}
    ).status_code == 401


def test_login_sets_a_new_session(client):
    client.post("/auth/logout")
    response = client.post(
        "/auth/login", json={"email": " OWNER@EXAMPLE.COM ", "password": "correct horse"}
    )
    assert response.status_code == 200
    assert response.json() == {"id": 1, "name": "Owner", "email": "owner@example.com", "email_verified": False}
    assert "httponly" in response.headers["set-cookie"].lower()
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/notes").status_code == 200


def test_wrong_password_and_unknown_email_have_the_same_response(client):
    wrong = client.post("/auth/login", json={"email": "owner@example.com", "password": "incorrect pass"})
    unknown = client.post("/auth/login", json={"email": "nobody@example.com", "password": "incorrect pass"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json() == {"detail": main.LOGIN_FAILED}
    assert wrong.headers["cache-control"] == unknown.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("fields", [{"password": "short"}, {"email": "not-an-email"}])
def test_login_never_reports_signup_rules(client, fields):
    data = {"email": "owner@example.com", "password": "correct horse"} | fields
    response = client.post("/auth/login", json=data)
    assert response.status_code == 401
    assert response.json() == {"detail": main.LOGIN_FAILED}


def test_unknown_email_still_verifies_the_dummy_hash(anonymous, monkeypatch):
    calls = []
    class PasswordVerifier:
        def verify(self, password, password_hash):
            calls.append((password, password_hash == main.DUMMY_HASH))
            return False
    monkeypatch.setattr(main, "PASSWORD_HASH", PasswordVerifier())
    response = anonymous.post("/auth/login", json={"email": "absent@example.com", "password": "incorrect pass"})
    assert response.status_code == 401
    assert calls == [("incorrect pass", True)]


def test_me_and_logout_follow_session_state(anonymous):
    logged_out = anonymous.get("/auth/me")
    assert logged_out.status_code == 200 and logged_out.json() is None
    assert logged_out.headers["cache-control"] == "no-store"
    user = anonymous.post(
        "/auth/signup", json={"name": "Name", "email": "me@example.com", "password": "valid pass"}
    ).json()
    assert anonymous.get("/auth/me").json() == user
    response = anonymous.post("/auth/logout")
    assert response.status_code == 204 and response.content == b""
    assert response.headers["cache-control"] == "no-store"
    cookie = response.headers["set-cookie"].lower()
    assert "max-age=0" in cookie and "httponly" in cookie and "samesite=lax" in cookie and "path=/" in cookie
    assert anonymous.get("/auth/me").json() is None
    assert anonymous.post("/auth/logout").status_code == 204


@pytest.mark.parametrize("method,path,body", [
    ("get", "/notes", None), ("post", "/notes", {"title": "No session"}),
    ("put", "/notes/1", {"title": "No session"}), ("delete", "/notes/1", None),
    ("post", "/notes/samples", None),
])
def test_all_note_routes_require_a_session(anonymous, method, path, body):
    response = anonymous.request(method, path, json=body)
    assert response.status_code == 401
    assert response.json() == {"detail": "Log in to see your notes."}


@pytest.mark.parametrize("kind", ["tampered", "expired", "noninteger", "missing_exp", "missing_sub", "huge_id"])
def test_invalid_tokens_are_logged_out(client, kind):
    claims = {"sub": "1", "exp": main.utc_now() + timedelta(days=1)}
    key = main.JWT_SECRET
    if kind == "tampered":
        key = "wrong-test-signing-key-with-at-least-32-bytes"
    elif kind == "expired":
        claims["exp"] = main.utc_now() - timedelta(seconds=1)
    elif kind == "noninteger":
        claims["sub"] = "not-an-integer"
    elif kind == "huge_id":
        claims["sub"] = "9" * 100
    else:
        claims.pop("exp" if kind == "missing_exp" else "sub")
    client.cookies.clear()
    client.cookies.set("notes_session", jwt.encode(claims, key, algorithm="HS256"))
    assert client.get("/notes").status_code == 401
    response = client.get("/auth/me")
    assert response.status_code == 200 and response.json() is None


def test_session_for_deleted_user_is_logged_out(client, database):
    client.post("/notes", json={"title": "Removed with the account"})
    with Session(database) as session:
        session.delete(session.get(UserRecord, 1))
        session.commit()
        assert session.scalar(select(NoteRecord)) is None
    assert client.get("/notes").status_code == 401
    assert client.get("/auth/me").json() is None


def test_deleted_account_session_cannot_identify_a_new_account(client, database, make_client):
    with Session(database) as session:
        session.delete(session.get(UserRecord, 1))
        session.commit()
    other = make_client(email="later@example.com")
    assert other.get("/auth/me").json()["id"] != 1
    assert client.get("/notes").status_code == 401
    assert client.get("/auth/me").json() is None


def test_accounts_cannot_list_update_or_delete_each_others_notes(client, make_client):
    note_id = client.post("/notes", json={"title": "Private"}).json()["id"]
    other = make_client(email="other@example.com")
    assert other.get("/notes").json() == []
    for method, body in [("put", {"title": "Stolen"}), ("delete", None)]:
        response = other.request(method, f"/notes/{note_id}", json=body)
        assert response.status_code == 404
        assert response.json() == {"detail": f"Note {note_id} not found"}
    assert other.get("/notes").json() == []
    assert client.get("/notes").json()[0]["title"] == "Private"


def test_samples_only_land_on_the_callers_account_and_stay_backdated(client, make_client):
    other = make_client(email="other@example.com")
    recent = client.post("/notes", json={"title": "Latest"}).json()
    response = client.post("/notes/samples")
    assert response.status_code == 201
    assert len(response.json()) == 16
    assert response.json()[0] == recent
    assert other.get("/notes").json() == []


def test_password_is_stored_as_argon2_hash(client, database):
    with Session(database) as session:
        user = session.scalar(select(UserRecord))
        assert user.password_hash.startswith("$argon2id$")
        assert user.password_hash != "correct horse"
        assert main.PASSWORD_HASH.verify("correct horse", user.password_hash)


def test_note_timestamps_are_aware_utc_after_database_round_trip(client, database):
    created = client.post("/notes", json={"title": "Done", "done": True}).json()
    listed = client.get("/notes").json()[0]
    with Session(database) as session:
        record = session.get(NoteRecord, created["id"])
        for field in ("created_at", "updated_at", "completed_at"):
            value = getattr(record, field)
            assert value.tzinfo == UTC and value.utcoffset() == timedelta(0)
            assert datetime.fromisoformat(listed[field]) == value


def test_https_cookie_and_logout_attributes_match(database):
    with TestClient(app, base_url="https://testserver") as client:
        signup = client.post("/auth/signup", json={"name": "Name", "email": "https@example.com", "password": "valid pass"})
        assert "Secure" in signup.headers["set-cookie"]
        assert client.get("/auth/me").json()["email"] == "https@example.com"
        logout = client.post("/auth/logout")
        assert "Secure" in logout.headers["set-cookie"]
        assert client.get("/auth/me").json() is None


def test_signup_race_returns_duplicate_conflict(anonymous, monkeypatch):
    def collision(session):
        raise IntegrityError("duplicate email", {}, Exception("duplicate email"))
    monkeypatch.setattr(Session, "commit", collision)
    response = anonymous.post("/auth/signup", json={"name": "Name", "email": "race@example.com", "password": "valid pass"})
    assert response.status_code == 409
    assert response.json() == {"detail": main.DUPLICATE_EMAIL}


def test_session_has_seven_day_expiry_and_string_subject(client):
    claims = jwt.decode(client.cookies.get("notes_session"), main.JWT_SECRET, algorithms=["HS256"])
    assert claims["sub"] == "1"
    assert claims["exp"] - claims["iat"] == 7 * 24 * 60 * 60


@pytest.mark.parametrize("missing", ["database", "secret"])
def test_vercel_refuses_missing_configuration(database, monkeypatch, missing):
    monkeypatch.setattr(main, "ON_VERCEL", True)
    monkeypatch.setattr(main, "DATABASE_URL", None if missing == "database" else "configured")
    monkeypatch.setattr(main, "CONFIGURED_JWT_SECRET", None if missing == "secret" else "configured")
    message = "DATABASE_URL or POSTGRES_URL" if missing == "database" else "NOTES_JWT_SECRET"
    with pytest.raises(RuntimeError, match=message):
        with TestClient(app):
            pass


def test_neon_url_schemes_use_psycopg():
    for scheme in ("postgres", "postgresql", "postgresql+psycopg"):
        assert database_url(f"{scheme}://host/database") == "postgresql+psycopg://host/database"


def test_etag_accepts_weak_strong_list_and_wildcard(client):
    response = client.get("/notes")
    etag = response.headers["etag"]
    for value in (etag, etag.removeprefix("W/"), f'"other", {etag}', "*"):
        cached = client.get("/notes", headers={"If-None-Match": value})
        assert cached.status_code == 304
        assert cached.headers["cache-control"] == "private, no-cache"
    client.post("/notes", json={"title": "Changed"})
    changed = client.get("/notes")
    assert changed.headers["etag"] != etag
    client.delete(f'/notes/{changed.json()[0]["id"]}')
    assert client.get("/notes", headers={"If-None-Match": changed.headers["etag"]}).status_code == 200


def test_tied_timestamps_use_descending_ids(client, monkeypatch):
    now = datetime.now(UTC)
    monkeypatch.setattr(main, "utc_now", lambda: now)
    client.post("/notes", json={"title": "First"})
    client.post("/notes", json={"title": "Second"})
    assert [note["title"] for note in client.get("/notes").json()] == ["Second", "First"]


@pytest.mark.parametrize("url", ["sqlite://", "postgresql+psycopg://localhost/unused"])
def test_engine_factory_hides_bound_parameters(url):
    engine = main.make_engine(url)
    try:
        assert engine.hide_parameters is True
    finally:
        engine.dispose()


@pytest.mark.parametrize("path", ["/auth/login", "/auth/signup", "/api/auth/login", "/api/auth/signup"])
def test_auth_overlong_password_is_not_echoed(anonymous, path):
    password = "validation-sentinel-" * 8
    response = anonymous.post(
        path, json={"name": "Name", "email": "valid@example.com", "password": password}
    )
    assert response.status_code == 422
    assert password not in response.text
    assert response.headers["cache-control"] == "no-store"
    errors = response.json()["detail"]
    assert errors
    assert all(set(error) == {"loc", "msg", "type"} for error in errors)
    assert errors[0]["loc"] == ["body", "password"]


@pytest.mark.parametrize("path", ["/auth/login", "/auth/signup"])
@pytest.mark.parametrize("kind", ["missing_email", "array", "invalid_json", "nested_password"])
def test_auth_malformed_body_does_not_echo_password(anonymous, path, kind):
    password = "malformed-body-sentinel"
    if kind == "invalid_json":
        response = anonymous.post(
            path, content='{"password":"' + password + '",',
            headers={"Content-Type": "application/json"},
        )
    else:
        body = {"name": "Name", "password": password}
        if kind == "array":
            body = [body]
        elif kind == "nested_password":
            body |= {"email": "valid@example.com", "password": {"value": password}}
        response = anonymous.post(path, json=body)
    assert response.status_code == 422
    assert password not in response.text
    errors = response.json()["detail"]
    assert errors
    assert all(set(error) == {"loc", "msg", "type"} for error in errors)


@pytest.mark.parametrize("cookie", [None, "unrelated=value", "notes_session=", "notes_session=invalid"])
def test_logout_only_deletes_a_cookie_present_in_request(anonymous, cookie):
    headers = {} if cookie is None else {"Cookie": cookie}
    response = anonymous.post("/auth/logout", headers=headers)
    assert response.status_code == 204
    assert response.content == b""
    assert ("set-cookie" in response.headers) == (cookie is not None and cookie.startswith("notes_session="))
    if "set-cookie" in response.headers:
        assert "Max-Age=0" in response.headers["set-cookie"]


@pytest.mark.parametrize("field", ["name", "email"])
def test_signup_rejects_nul_before_persistence(anonymous, database, field):
    body = {"name": "Name", "email": "nul@example.com", "password": "valid pass"}
    body[field] = "Na\x00me" if field == "name" else "nu\x00l@example.com"
    response = anonymous.post("/auth/signup", json=body)
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", field]
    with Session(database) as session:
        assert session.scalar(select(UserRecord)) is None


@pytest.mark.parametrize("method", ["post", "put"])
@pytest.mark.parametrize("field", ["title", "content"])
def test_note_writes_reject_nul_before_persistence(client, method, field):
    original = client.post("/notes", json={"title": "Original", "content": "Keep"}).json()
    path = "/notes" if method == "post" else f'/notes/{original["id"]}'
    response = client.request(method, path, json={"title": "Valid", field: "has\x00nul"})
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", field]
    assert client.get("/notes").json() == [original]


@pytest.mark.parametrize("method", ["put", "delete"])
@pytest.mark.parametrize("note_id", [-1, 0, 2**31, 2**63, 10**100])
def test_out_of_range_note_ids_return_404_without_lookup(client, monkeypatch, method, note_id):
    def unexpected_lookup(*args, **kwargs):
        pytest.fail("An out-of-range note id must not reach a database lookup")

    monkeypatch.setattr(Session, "scalar", unexpected_lookup)
    response = client.request(method, f"/notes/{note_id}", json={"title": "Missing"})
    assert response.status_code == 404
    assert response.json() == {"detail": f"Note {note_id} not found"}


def test_vercel_proxy_sets_secure_cookies_over_http(anonymous, monkeypatch):
    # Toggle after startup: the database fixture already supplies test storage.
    monkeypatch.setattr(main, "ON_VERCEL", True)
    signup = anonymous.post(
        "/auth/signup", json={"name": "Name", "email": "proxy@example.com", "password": "valid pass"}
    )
    login = anonymous.post(
        "/auth/login", json={"email": "proxy@example.com", "password": "valid pass"}
    )
    # HTTP clients correctly withhold Secure cookies; emulate the proxy's
    # forwarding of a browser cookie received over the public HTTPS connection.
    logout = anonymous.post("/auth/logout", headers={"Cookie": "notes_session=proxy-cookie"})
    for response, expected_status in [(signup, 201), (login, 200), (logout, 204)]:
        assert response.status_code == expected_status
        assert response.request.url.scheme == "http"
        assert "Secure" in response.headers["set-cookie"]


# Account links are exercised through the fake inbox, never a real email API.
def emailed_token(outbox, purpose):
    marker = f"{main.APP_URL}/#{purpose}="
    assert marker in outbox[-1]["text"]
    return outbox[-1]["text"].split(marker, 1)[1].split()[0]


def advance_clock(monkeypatch, seconds):
    later = main.utc_now() + timedelta(seconds=seconds)
    monkeypatch.setattr(main, "utc_now", lambda: later)


def fail_email(*args):
    raise main.EmailError("Delivery failed")


def test_signup_sends_one_confirmation_and_stores_only_hash(client, outbox, database):
    assert len(outbox) == 1
    assert outbox[0]["to"] == "owner@example.com"
    assert outbox[0]["subject"] == "Confirm your email for Notes"
    raw = emailed_token(outbox, "verify-email")
    assert client.get("/auth/me").json()["email_verified"] is False
    with Session(database) as session:
        record = session.scalar(select(EmailTokenRecord))
        assert record.token_hash == main.hashlib.sha256(raw.encode()).hexdigest()
        assert record.expires_at - record.created_at == timedelta(hours=24)
        assert all(raw not in str(getattr(record, column.name)) for column in record.__table__.columns)


def test_signup_succeeds_when_email_delivery_fails(anonymous, database, monkeypatch):
    monkeypatch.setattr(main, "send_email", fail_email)
    response = anonymous.post("/auth/signup", json={"name": "Name", "email": "unsent@example.com", "password": "valid pass"})
    assert response.status_code == 201
    assert "set-cookie" in response.headers
    assert anonymous.get("/auth/me").json()["email_verified"] is False
    with Session(database) as session:
        assert session.scalar(select(EmailTokenRecord)) is None
        assert session.scalar(select(UserRecord)) is not None


def test_confirmation_and_second_click_are_successful_without_logging_in(client, outbox, database, anonymous):
    raw = emailed_token(outbox, "verify-email")
    for _ in range(2):
        response = anonymous.post("/auth/verify-email", json={"token": raw})
        assert response.status_code == 204 and response.content == b""
        assert "set-cookie" not in response.headers
    assert anonymous.get("/auth/me").json() is None
    assert client.get("/auth/me").json()["email_verified"] is True
    with Session(database) as session:
        assert session.scalar(select(EmailTokenRecord)).used_at is not None


@pytest.mark.parametrize("kind", ["garbage", "expired", "reset", "email_changed"])
def test_invalid_confirmation_links(client, outbox, database, kind):
    raw = emailed_token(outbox, "verify-email")
    if kind == "garbage":
        raw = "unknown-link"
    elif kind == "reset":
        client.post("/auth/password/forgot", json={"email": "owner@example.com"})
        raw = emailed_token(outbox, "reset-password")
    else:
        with Session(database) as session:
            if kind == "expired":
                session.scalar(select(EmailTokenRecord)).expires_at = main.utc_now() - timedelta(seconds=1)
            else:
                session.get(UserRecord, 1).email = "changed@example.com"
            session.commit()
    response = client.post("/auth/verify-email", json={"token": raw})
    assert response.status_code == 400
    assert response.json() == {"detail": main.INVALID_LINK}
    assert response.headers["cache-control"] == "no-store"


def test_resend_requires_login(anonymous):
    response = anonymous.post("/auth/verify-email/resend")
    assert response.status_code == 401
    assert response.json() == {"detail": "Log in to see your notes."}
    assert response.headers["cache-control"] == "no-store"


def test_resend_gap_daily_cap_and_retry_after(client, outbox, monkeypatch):
    response = client.post("/auth/verify-email/resend")
    assert response.status_code == 429
    assert response.json() == {"detail": "Wait a minute before asking for another email."}
    assert 1 <= int(response.headers["retry-after"]) <= 60
    for _ in range(4):
        advance_clock(monkeypatch, 61)
        response = client.post("/auth/verify-email/resend")
        assert response.status_code == 204 and response.content == b""
    assert len(outbox) == 5
    advance_clock(monkeypatch, 61)
    response = client.post("/auth/verify-email/resend")
    assert response.status_code == 429
    assert response.json() == {"detail": "You've asked for 5 emails today. Try again tomorrow."}
    assert 86_000 < int(response.headers["retry-after"]) <= 86_400
    advance_clock(monkeypatch, 86_400)
    assert client.post("/auth/verify-email/resend").status_code == 204


def test_verified_account_cannot_resend(client, outbox):
    client.post("/auth/verify-email", json={"token": emailed_token(outbox, "verify-email")})
    response = client.post("/auth/verify-email/resend")
    assert response.status_code == 409
    assert response.json() == {"detail": "Your email is already confirmed."}
    assert len(outbox) == 1


def test_resend_failure_does_not_count_toward_limits(client, database, monkeypatch, outbox):
    advance_clock(monkeypatch, 61)
    with monkeypatch.context() as patch:
        patch.setattr(main, "send_email", fail_email)
        response = client.post("/auth/verify-email/resend")
        assert response.status_code == 503
        assert response.json() == {"detail": "We couldn't send the email. Try again in a few minutes."}
    with Session(database) as session:
        assert len(list(session.scalars(select(EmailTokenRecord)))) == 1
    assert client.post("/auth/verify-email/resend").status_code == 204
    assert len(outbox) == 2


def test_forgot_is_private_and_uses_configured_url(client, outbox):
    count = len(outbox)
    response = client.post("/auth/password/forgot", json={"email": "missing@example.com"})
    assert response.status_code == 202 and response.content == b""
    assert len(outbox) == count
    response = client.post("/auth/password/forgot", json={"email": " OWNER@EXAMPLE.COM "}, headers={"Host": "evil.example"})
    assert response.status_code == 202 and response.content == b""
    assert response.headers["cache-control"] == "no-store"
    assert len(outbox) == count + 1
    assert outbox[-1]["subject"] == "Reset your Notes password"
    emailed_token(outbox, "reset-password")
    assert "evil.example" not in outbox[-1]["text"]
    assert client.post("/auth/password/forgot", json={"email": "owner@example.com"}).status_code == 202
    assert len(outbox) == count + 1


def test_later_reset_email_invalidates_previous_link(client, outbox, monkeypatch):
    client.post("/auth/password/forgot", json={"email": "owner@example.com"})
    first = emailed_token(outbox, "reset-password")
    advance_clock(monkeypatch, 61)
    client.post("/auth/password/forgot", json={"email": "owner@example.com"})
    second = emailed_token(outbox, "reset-password")
    assert client.post("/auth/password/reset", json={"token": first, "password": "replacement pass"}).status_code == 400
    assert client.post("/auth/password/reset", json={"token": second, "password": "replacement pass"}).status_code == 200


def test_forgot_failure_rolls_back_and_returns_202(client, database, monkeypatch, outbox):
    client.post("/auth/password/forgot", json={"email": "owner@example.com"})
    first = emailed_token(outbox, "reset-password")
    advance_clock(monkeypatch, 61)
    monkeypatch.setattr(main, "send_email", fail_email)
    response = client.post("/auth/password/forgot", json={"email": "owner@example.com"})
    assert response.status_code == 202 and response.content == b""
    with Session(database) as session:
        records = list(session.scalars(select(EmailTokenRecord).where(EmailTokenRecord.purpose == "reset_password")))
        assert len(records) == 1 and records[0].used_at is None
    assert client.post("/auth/password/reset", json={"token": first, "password": "replacement pass"}).status_code == 200


def test_forgot_daily_limit_is_also_private(client, outbox, monkeypatch):
    for _ in range(5):
        assert client.post("/auth/password/forgot", json={"email": "owner@example.com"}).status_code == 202
        advance_clock(monkeypatch, 61)
    count = len(outbox)
    response = client.post("/auth/password/forgot", json={"email": "owner@example.com"})
    assert response.status_code == 202 and response.content == b""
    assert len(outbox) == count


def test_password_reset_entire_journey_ends_old_sessions(client, anonymous, outbox, database):
    old_cookie = client.cookies.get("notes_session")
    client.post("/notes", json={"title": "Still here after reset"})
    client.post("/auth/password/forgot", json={"email": "owner@example.com"})
    raw = emailed_token(outbox, "reset-password")
    response = anonymous.post("/auth/password/reset", json={"token": raw, "password": "  replacement pass  "})
    assert response.status_code == 200
    assert response.json() == {"id": 1, "name": "Owner", "email": "owner@example.com", "email_verified": True}
    assert "httponly" in response.headers["set-cookie"].lower()
    assert response.headers["cache-control"] == "no-store"
    assert anonymous.get("/notes").json()[0]["title"] == "Still here after reset"
    assert client.cookies.get("notes_session") == old_cookie
    assert client.get("/notes").status_code == 401
    assert client.get("/auth/me").json() is None
    assert anonymous.post("/auth/password/reset", json={"token": raw, "password": "another pass"}).status_code == 400
    assert client.post("/auth/login", json={"email": "owner@example.com", "password": "correct horse"}).status_code == 401
    assert client.post("/auth/login", json={"email": "owner@example.com", "password": "  replacement pass  "}).status_code == 200
    with Session(database) as session:
        assert session.get(UserRecord, 1).session_version == 1
        assert all(record.used_at is not None for record in session.scalars(
            select(EmailTokenRecord).where(EmailTokenRecord.purpose == "reset_password")))
    claims = jwt.decode(client.cookies.get("notes_session"), main.JWT_SECRET, algorithms=["HS256"])
    assert claims["sv"] == 1


@pytest.mark.parametrize("kind", ["expired", "garbage", "verify", "email_changed"])
def test_invalid_reset_links(client, database, outbox, kind):
    verify = emailed_token(outbox, "verify-email")
    client.post("/auth/password/forgot", json={"email": "owner@example.com"})
    raw = emailed_token(outbox, "reset-password")
    with Session(database) as session:
        record = session.scalar(select(EmailTokenRecord).where(EmailTokenRecord.purpose == "reset_password"))
        assert record.expires_at - record.created_at == timedelta(hours=1)
        if kind == "expired":
            record.expires_at = main.utc_now() - timedelta(seconds=1)
        elif kind == "email_changed":
            session.get(UserRecord, 1).email = "changed@example.com"
        session.commit()
    if kind == "garbage":
        raw = "unknown-reset-link"
    elif kind == "verify":
        raw = verify
    response = client.post("/auth/password/reset", json={"token": raw, "password": "replacement pass"})
    assert response.status_code == 400
    assert response.json() == {"detail": main.INVALID_LINK}
    with Session(database) as session:
        assert session.get(UserRecord, 1).session_version == 0
        assert main.PASSWORD_HASH.verify("correct horse", session.get(UserRecord, 1).password_hash)


@pytest.mark.parametrize("prefix", ["", "/api"])
@pytest.mark.parametrize("path,body", [
    ("/auth/verify-email", {"token": "token-sentinel-" * 11}),
    ("/auth/verify-email", {"token": "token-sentinel\x00"}),
    ("/auth/password/forgot", {"email": "email-sentinel\x00@example.com"}),
    ("/auth/password/forgot", {"email": " "}),
    ("/auth/password/reset", {"token": "token-sentinel", "password": "tiny"}),
    ("/auth/password/reset", {"token": "token-sentinel-" * 11, "password": "password-sentinel"}),
    ("/auth/password/reset", {"token": "token-sentinel", "password": "password-sentinel" * 10}),
])
def test_new_auth_validation_is_private_and_no_store(anonymous, prefix, path, body):
    response = anonymous.post(prefix + path, json=body)
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"
    assert all(value not in response.text for value in body.values() if value.strip())
    assert all(set(error) == {"loc", "msg", "type"} for error in response.json()["detail"])


@pytest.mark.parametrize("path", ["/auth/verify-email", "/auth/password/reset", "/auth/password/forgot"])
@pytest.mark.parametrize("kind", ["array", "invalid_json", "nested"])
def test_new_auth_malformed_bodies_do_not_echo_inputs(anonymous, path, kind):
    sentinel = "private-input-sentinel"
    body = {"token": sentinel, "password": sentinel, "email": sentinel}
    if kind == "array":
        response = anonymous.post(path, json=[body])
    elif kind == "nested":
        response = anonymous.post(path, json={key: {"value": value} for key, value in body.items()})
    else:
        response = anonymous.post(path, content='{"token":"' + sentinel + '",', headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert sentinel not in response.text
    assert response.headers["cache-control"] == "no-store"


def test_all_new_auth_routes_have_no_store_on_errors(anonymous):
    for path, body in [
        ("/auth/verify-email/resend", None), ("/auth/verify-email", {"token": "garbage"}),
        ("/auth/password/reset", {"token": "garbage", "password": "valid pass"}),
        ("/auth/password/forgot", {"email": "absent@example.com"}),
    ]:
        assert anonymous.post(path, json=body).headers["cache-control"] == "no-store"


# Category CRUD covers ownership and the note reassignment transaction together.
def test_categories_and_notes_journey(client, outbox):
    assert client.get("/categories").json() == []
    created = client.post("/categories", json={"name": "  Travel  ", "color": "sky"})
    assert created.status_code == 201
    category = created.json()
    assert category == {"id": category["id"], "key": f'c{category["id"]}', "name": "Travel", "color": "sky"}
    note = client.post("/notes", json={"title": "Tickets", "category": category["key"]}).json()
    etag = client.get("/notes").headers["etag"]
    changed = client.patch(f'/categories/{category["id"]}', json={"name": "Trips", "color": "mint"})
    assert changed.status_code == 200
    assert changed.json() == category | {"name": "Trips", "color": "mint"}
    assert client.patch(f'/categories/{category["id"]}', json={"color": "sage"}).status_code == 200
    assert client.patch(f'/categories/{category["id"]}', json={"name": "TRIPS"}).status_code == 200
    assert client.get("/notes").headers["etag"] == etag
    assert len(client.get("/categories").json()) == 1
    removed = client.delete(f'/categories/{category["id"]}')
    assert removed.status_code == 204 and removed.content == b""
    assert client.get("/categories").json() == []
    moved = client.get("/notes").json()[0]
    assert moved == note | {"category": "personal"}
    assert client.get("/notes").headers["etag"] != etag


def test_category_list_order_is_oldest_first_even_with_tied_clocks(client, monkeypatch):
    now = main.utc_now()
    monkeypatch.setattr(main, "utc_now", lambda: now)
    for name in ("Zebra", "Apple"):
        client.post("/categories", json={"name": name, "color": "stone"})
    assert [item["name"] for item in client.get("/categories").json()] == ["Zebra", "Apple"]


@pytest.mark.parametrize("name,spelling", [("wOrK", "Work"), (" PERSONAL ", "Personal"), ("ideas", "Ideas"), ("shopping", "Shopping"), ("health", "Health"), ("tRaVeL", "Travel")])
def test_category_name_clashes_use_existing_spelling(client, name, spelling):
    client.post("/categories", json={"name": "Travel", "color": "lilac"})
    response = client.post("/categories", json={"name": name, "color": "rose"})
    assert response.status_code == 409
    assert response.json() == {"detail": f'You already have a category called "{spelling}".'}
    second = client.post("/categories", json={"name": "Plans", "color": "peach"}).json()
    response = client.patch(f'/categories/{second["id"]}', json={"name": name})
    assert response.status_code == 409
    assert response.json() == {"detail": f'You already have a category called "{spelling}".'}


def test_category_daily_cap_is_per_account(client, make_client):
    for index in range(20):
        assert client.post("/categories", json={"name": f"Group {index}", "color": "butter"}).status_code == 201
    response = client.post("/categories", json={"name": "One too many", "color": "butter"})
    assert response.status_code == 409
    assert response.json() == {"detail": "You can have up to 20 categories of your own."}
    other = make_client(email="other@example.com")
    assert other.post("/categories", json={"name": "Group 0", "color": "butter"}).status_code == 201


@pytest.mark.parametrize("body", [
    {"name": "x" * 25, "color": "sky"}, {"name": "  ", "color": "sky"},
    {"name": "Nu\x00l", "color": "sky"}, {"name": "Valid", "color": "red"},
    {"name": None, "color": "sky"}, {"name": "Valid", "color": None},
])
def test_category_input_validation_on_create_and_patch(client, body):
    category = client.post("/categories", json={"name": "Keep", "color": "mint"}).json()
    assert client.post("/categories", json=body).status_code == 422
    assert client.patch(f'/categories/{category["id"]}', json=body).status_code == 422
    assert client.get("/categories").json() == [category]
    assert client.patch(f'/categories/{category["id"]}', json={}).status_code == 422


def test_custom_categories_are_private_for_notes_and_crud(client, make_client):
    category = client.post("/categories", json={"name": "Travel", "color": "sky"}).json()
    own_note = client.post("/notes", json={"title": "Mine"}).json()
    assert client.put(f'/notes/{own_note["id"]}', json={"title": "Mine", "category": category["key"]}).status_code == 200
    other = make_client(email="other@example.com")
    assert other.get("/categories").json() == []
    other_note = other.post("/notes", json={"title": "Theirs"}).json()
    for method, path in [("post", "/notes"), ("put", f'/notes/{other_note["id"]}')]:
        response = other.request(method, path, json={"title": "Wrong", "category": category["key"]})
        assert response.status_code == 422
        assert response.json() == {"detail": "Choose a category from the list."}
    for method in ("patch", "delete"):
        response = other.request(method, f'/categories/{category["id"]}', json={"name": "Stolen"})
        assert response.status_code == 404
        assert response.json() == {"detail": f'Category {category["id"]} not found'}
    assert other.get("/notes").json() == [other_note]
    assert len(client.get("/categories").json()) == 1


@pytest.mark.parametrize("category_id", [-1, 0, 2**31, 2**63, 10**100])
@pytest.mark.parametrize("method", ["patch", "delete"])
def test_category_out_of_range_ids_are_404(client, category_id, method):
    response = client.request(method, f"/categories/{category_id}", json={"name": "Missing"})
    assert response.status_code == 404
    assert response.json() == {"detail": f"Category {category_id} not found"}


@pytest.mark.parametrize("key", ["c999999999999", "c2147483648", "c0", "c01", "c-1", "c１２", "c", "unknown"])
def test_unknown_category_keys_are_422_on_both_note_writes(client, key):
    note = client.post("/notes", json={"title": "Keep"}).json()
    for method, path in [("post", "/notes"), ("put", f'/notes/{note["id"]}')]:
        response = client.request(method, path, json={"title": "Wrong", "category": key})
        assert response.status_code == 422
        assert response.json() == {"detail": "Choose a category from the list."}
    assert client.get("/notes").json() == [note]


@pytest.mark.parametrize("method,path,body", [
    ("get", "/categories", None), ("post", "/categories", {"name": "Travel", "color": "sky"}),
    ("patch", "/categories/1", {"name": "Travel"}), ("delete", "/categories/1", None),
])
def test_category_routes_require_session(anonymous, method, path, body):
    response = anonymous.request(method, path, json=body)
    assert response.status_code == 401
    assert response.json() == {"detail": "Log in to see your notes."}


def test_deleting_user_cascades_tokens_and_categories(client, database):
    client.post("/categories", json={"name": "Travel", "color": "sky"})
    client.post("/auth/password/forgot", json={"email": "owner@example.com"})
    with Session(database) as session:
        assert len(list(session.scalars(select(EmailTokenRecord)))) == 2
        session.delete(session.get(UserRecord, 1))
        session.commit()
        assert session.scalar(select(CategoryRecord)) is None
        assert session.scalar(select(EmailTokenRecord)) is None


def test_old_users_table_migrates_idempotently():
    database = create_engine("sqlite://")
    try:
        with database.begin() as connection:
            connection.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR(60) NOT NULL, email VARCHAR(320) NOT NULL UNIQUE, password_hash VARCHAR NOT NULL, created_at TIMESTAMP NOT NULL)"))
            connection.execute(text("INSERT INTO users VALUES (1, 'Old user', 'old@example.com', 'unused-hash', '2026-01-01 00:00:00')"))
        for _ in range(2):
            with database.begin() as connection:
                main.migrate_users(connection)
        assert {"email_verified_at", "session_version"} <= {column["name"] for column in inspect(database).get_columns("users")}
        with Session(database) as session:
            user = session.get(UserRecord, 1)
            assert user.name == "Old user"
            assert user.email_verified_at is None
            assert user.session_version == 0
    finally:
        database.dispose()


@pytest.mark.skipif(not os.getenv("NOTES_TEST_DATABASE_URL"), reason="Postgres test database is not configured")
def test_prepare_database_waits_for_postgres_startup_lock(database):
    started = Event()
    finished = Event()

    def executing(connection, cursor, statement, parameters, context, executemany):
        started.set()

    def prepare():
        try:
            main.prepare_database(database)
        finally:
            finished.set()

    with ThreadPoolExecutor(max_workers=1) as executor:
        with database.begin() as blocker:
            blocker.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": main.DATABASE_PREPARE_LOCK})
            event.listen(database, "before_cursor_execute", executing)
            try:
                future = executor.submit(prepare)
                assert started.wait(timeout=5), "Startup never reached the database"
                assert not finished.wait(timeout=0.5), "Startup bypassed the advisory lock"
            finally:
                event.remove(database, "before_cursor_execute", executing)
        future.result(timeout=5)
    # Existing tables and migrated columns must survive repeated cold starts.
    main.prepare_database(database)
    main.prepare_database(database)


@pytest.mark.parametrize("missing", ["resend", "app_url"])
def test_vercel_requires_email_configuration(database, monkeypatch, missing):
    monkeypatch.setattr(main, "ON_VERCEL", True)
    monkeypatch.setattr(main, "DATABASE_URL", "configured")
    monkeypatch.setattr(main, "CONFIGURED_JWT_SECRET", "configured")
    monkeypatch.setattr(main, "RESEND_API_KEY", None if missing == "resend" else "configured")
    if missing == "app_url":
        monkeypatch.delenv("NOTES_APP_URL", raising=False)
    else:
        monkeypatch.setenv("NOTES_APP_URL", "https://notes.example")
    with pytest.raises(RuntimeError, match="RESEND_API_KEY" if missing == "resend" else "NOTES_APP_URL"):
        with TestClient(app):
            pass


class EmailResponse:
    def __init__(self, code=200, body=b""):
        self.status = code
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self, size):
        return self.body[:size]


def test_resend_api_payload_and_delivery(monkeypatch):
    key = main.secrets.token_urlsafe(32)
    monkeypatch.setattr(main, "RESEND_API_KEY", key)
    monkeypatch.setattr(main, "EMAIL_FROM", "Notes <notes@example.com>")
    calls = []

    def fake_open(opener, request, timeout):
        calls.append((request, timeout))
        assert any(isinstance(handler, main.NoEmailRedirect) for handler in opener.handlers)
        return EmailResponse(201)

    monkeypatch.setattr(main.urllib.request.OpenerDirector, "open", fake_open)
    REAL_SEND_EMAIL("reader@example.com", "A subject", "Plain text", "<p>Plain text</p>")
    assert len(calls) == 1
    request, timeout = calls[0]
    assert request.full_url == "https://api.resend.com/emails"
    assert request.method == "POST" and timeout == 10
    assert request.get_header("Authorization") == f"Bearer {key}"
    assert request.get_header("Content-type") == "application/json"
    assert request.get_header("User-agent") == "notes-dashboard"
    assert json.loads(request.data) == {
        "from": "Notes <notes@example.com>", "to": ["reader@example.com"],
        "subject": "A subject", "text": "Plain text", "html": "<p>Plain text</p>",
    }


@pytest.mark.parametrize("kind", ["http", "non_2xx", "network", "timeout", "malformed", "body_read_failure", "protocol", "truncated_body", "echo"])
def test_email_delivery_failures_are_safe(monkeypatch, caplog, kind):
    key = main.secrets.token_urlsafe(32)
    raw = main.secrets.token_urlsafe(32)
    link = f"https://notes.example/#reset-password={raw}"
    text_body = f"Private text: {link}"
    html_body = f"<a href='{link}'>Choose a new password</a>"
    monkeypatch.setattr(main, "RESEND_API_KEY", key)

    def fake_open(*args, **kwargs):
        body = json.dumps({"name": "validation_error", "message": "Provider failed", "other": text_body}).encode()
        if kind == "network":
            raise main.urllib.error.URLError(text_body)
        if kind == "timeout":
            raise TimeoutError(text_body)
        if kind == "protocol":
            raise main.http.client.BadStatusLine(text_body)
        if kind == "truncated_body":
            raise main.http.client.IncompleteRead(text_body.encode())
        if kind == "malformed":
            body = b"not JSON"
        if kind == "echo":
            body = json.dumps({"name": "validation_error", "message": f"{key} {text_body} {html_body}"}).encode()
        if kind == "body_read_failure":
            class BrokenBody(io.BytesIO):
                def read(self, *args):
                    raise OSError(text_body)
            raise main.urllib.error.HTTPError("https://api.resend.com/emails", 503, "failure", {}, BrokenBody())
        if kind in ("http", "malformed", "echo"):
            raise main.urllib.error.HTTPError("https://api.resend.com/emails", 503, "failure", {}, io.BytesIO(body))
        return EmailResponse(302, body)

    monkeypatch.setattr(main.urllib.request.OpenerDirector, "open", fake_open)
    with caplog.at_level(logging.WARNING, logger="notes.email"):
        with pytest.raises(main.EmailError) as error:
            REAL_SEND_EMAIL("reader@example.com", "Subject", text_body, html_body)
    assert key not in caplog.text and raw not in caplog.text
    assert text_body not in caplog.text and html_body not in caplog.text
    assert raw not in str(error.value)
    assert "Email delivery failed" in caplog.text
    if kind == "http":
        assert "503" in caplog.text and "validation_error" in caplog.text and "Provider failed" in caplog.text


def test_email_api_refuses_redirects():
    handler = main.NoEmailRedirect()
    assert handler.redirect_request(None, None, 302, "Found", {}, "https://evil.example") is None


def test_local_email_logger_has_a_handler_and_info_level(monkeypatch):
    monkeypatch.setattr(main, "RESEND_API_KEY", None)
    logger = logging.getLogger("notes.email")
    with monkeypatch.context() as patch:
        patch.setattr(logger, "handlers", [])
        patch.setattr(logger, "level", logging.WARNING)
        stream = io.StringIO()
        patch.setattr(sys, "stderr", stream)
        patch.setattr(logger, "propagate", False)
        REAL_SEND_EMAIL("dev@example.com", "Local subject", "Local development body", "<p>Body</p>")
        assert logger.handlers and logger.level == logging.INFO
        assert "Local subject" in stream.getvalue()
        assert "dev@example.com" in stream.getvalue()
        assert "Local development body" in stream.getvalue()


def test_email_html_escapes_name(make_client, outbox):
    make_client(name='<img src=x onerror="bad">')
    assert '<img src=x' not in outbox[-1]["html"]
    assert "&lt;img" in outbox[-1]["html"]


@pytest.fixture
def concurrent_database(database, tmp_path, monkeypatch, request):
    if getattr(request, "param", "sqlite") == "postgresql":
        yield database
        return
    # Separate connections to a file exercise real SQLite writer contention;
    # StaticPool's single connection cannot model concurrent transactions.
    engine = main.make_engine(f"sqlite:///{tmp_path / 'concurrent.db'}")
    Base.metadata.create_all(engine)
    monkeypatch.setattr(main, "engine", engine)

    def sessions():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_db] = sessions
    yield engine
    engine.dispose()


@pytest.mark.parametrize("concurrent_database", [
    "sqlite", pytest.param("postgresql", marks=pytest.mark.skipif(
        not os.getenv("NOTES_TEST_DATABASE_URL"), reason="Postgres test database is not configured",
    )),
], indirect=True)
@pytest.mark.parametrize("flow", ["signup", "resend", "forgot"])
def test_account_email_delivery_releases_database_locks(concurrent_database, make_client, monkeypatch, flow):
    client = TestClient(app) if flow == "signup" else make_client()
    advance_clock(monkeypatch, 61)
    writes = []

    def send_while_another_connection_writes(to, subject, text_body, html_body):
        if concurrent_database.dialect.name == "sqlite":
            try:
                with sqlite3.connect(concurrent_database.url.database, timeout=0.2) as connection:
                    changed = connection.execute("UPDATE users SET name = name WHERE email = ?", (to,))
                    writes.append(changed.rowcount == 1)
            except sqlite3.OperationalError:
                writes.append(False)
        else:
            try:
                with concurrent_database.begin() as connection:
                    connection.execute(text("SET LOCAL lock_timeout = '200ms'"))
                    user_id = connection.scalar(select(UserRecord.id).where(UserRecord.email == to).with_for_update())
                    writes.append(user_id is not None)
            except OperationalError:
                writes.append(False)

    monkeypatch.setattr(main, "send_email", send_while_another_connection_writes)
    try:
        if flow == "signup":
            response = client.post("/auth/signup", json={"name": "Owner", "email": "owner@example.com", "password": main.secrets.token_urlsafe(16)})
            assert response.status_code == 201
        elif flow == "resend":
            assert client.post("/auth/verify-email/resend").status_code == 204
        else:
            assert client.post("/auth/password/forgot", json={"email": "owner@example.com"}).status_code == 202
        assert writes == [True], "Delivery held a database lock against another connection"
    finally:
        if flow == "signup":
            client.close()


@pytest.mark.parametrize("flow", ["signup", "resend", "forgot"])
def test_failed_delivery_removes_only_committed_pending_token(concurrent_database, make_client, monkeypatch, outbox, flow):
    client = TestClient(app) if flow == "signup" else make_client()
    if flow == "forgot":
        client.post("/auth/password/forgot", json={"email": "owner@example.com"})
        earlier_link = emailed_token(outbox, "reset-password")
    advance_clock(monkeypatch, 61)
    with Session(concurrent_database) as session:
        earlier_ids = set(session.scalars(select(EmailTokenRecord.id)))
    pending_ids = []

    def fail_after_observing_committed_token(*args):
        with Session(concurrent_database) as session:
            pending_ids.extend(set(session.scalars(select(EmailTokenRecord.id))) - earlier_ids)
        raise main.EmailError("Delivery failed")

    monkeypatch.setattr(main, "send_email", fail_after_observing_committed_token)
    try:
        if flow == "signup":
            response = client.post("/auth/signup", json={"name": "Owner", "email": "owner@example.com", "password": main.secrets.token_urlsafe(16)})
            assert response.status_code == 201
        elif flow == "resend":
            assert client.post("/auth/verify-email/resend").status_code == 503
        else:
            assert client.post("/auth/password/forgot", json={"email": "owner@example.com"}).status_code == 202
        assert len(pending_ids) == 1, "The pending token was not committed before delivery"
        with Session(concurrent_database) as session:
            assert set(session.scalars(select(EmailTokenRecord.id))) == earlier_ids
            if flow == "forgot":
                assert session.scalar(select(EmailTokenRecord).where(EmailTokenRecord.purpose == "reset_password")).used_at is None
        if flow == "forgot":
            assert client.post("/auth/password/reset", json={"token": earlier_link, "password": main.secrets.token_urlsafe(16)}).status_code == 200
    finally:
        if flow == "signup":
            client.close()


@pytest.mark.parametrize("stage", ["lookup", "lock", "limit", "reserve", "cleanup", "invalidate"])
def test_forgot_database_errors_still_return_202(client, monkeypatch, caplog, stage):
    rolled_back = []
    original_rollback = Session.rollback

    def rollback(session):
        original_rollback(session)
        rolled_back.append(not session.in_transaction())

    def fail_database(*args, **kwargs):
        # A driver error may contain private values; it must never be logged.
        raise OperationalError("unavailable", {}, Exception("private-driver-detail"))

    with monkeypatch.context() as patch:
        patch.setattr(Session, "rollback", rollback)
        if stage == "lookup":
            patch.setattr(Session, "scalar", fail_database)
        elif stage == "lock":
            patch.setattr(main, "lock_user", fail_database)
        elif stage == "limit":
            patch.setattr(main, "email_limit", fail_database)
        elif stage == "reserve":
            patch.setattr(Session, "commit", fail_database)
        elif stage == "cleanup":
            patch.setattr(main, "send_email", fail_email)
            original_execute = Session.execute

            def fail_delete(session, statement, *args, **kwargs):
                if statement.is_delete:
                    fail_database()
                return original_execute(session, statement, *args, **kwargs)

            patch.setattr(Session, "execute", fail_delete)
        else:
            original_execute = Session.execute

            def fail_invalidation(session, statement, *args, **kwargs):
                if statement.is_update and statement.table.name == "email_tokens":
                    fail_database()
                return original_execute(session, statement, *args, **kwargs)

            patch.setattr(Session, "execute", fail_invalidation)
        with caplog.at_level(logging.WARNING, logger="notes.email"):
            response = client.post("/auth/password/forgot", json={"email": "owner@example.com"})
    assert response.status_code == 202 and response.content == b""
    assert response.headers["cache-control"] == "no-store"
    assert "Password reset database work could not be completed." in caplog.text
    assert "owner@example.com" not in caplog.text and "private-driver-detail" not in caplog.text
    assert rolled_back == [True]


def parallel_requests(cookie, path, body):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    barrier = Barrier(2)

    def send(index):
        with TestClient(app) as client:
            barrier.wait(timeout=5)
            payload = body(index) if callable(body) else body
            return client.post(path, json=payload, headers={"Cookie": f"notes_session={cookie}"}).status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        return sorted(executor.map(send, range(2)))


def test_simultaneous_resends_send_only_once(concurrent_database, make_client, monkeypatch, outbox):
    client = make_client()
    advance_clock(monkeypatch, 61)
    statuses = parallel_requests(client.cookies.get("notes_session"), "/auth/verify-email/resend", None)
    assert statuses == [204, 429]
    assert len(outbox) == 2


def test_simultaneous_categories_cannot_exceed_cap(concurrent_database, make_client):
    client = make_client()
    for index in range(19):
        client.post("/categories", json={"name": f"Group {index}", "color": "sky"})
    statuses = parallel_requests(client.cookies.get("notes_session"), "/categories", lambda index: {
        "name": f"Last {index}", "color": "sky",
    })
    assert statuses == [201, 409]
    assert len(client.get("/categories").json()) == 20


def test_simultaneous_resets_can_consume_link_only_once(concurrent_database, make_client, outbox):
    client = make_client()
    client.post("/auth/password/forgot", json={"email": "owner@example.com"})
    statuses = parallel_requests(client.cookies.get("notes_session"), "/auth/password/reset", {
        "token": emailed_token(outbox, "reset-password"), "password": "replacement pass",
    })
    assert statuses == [200, 400]
    with Session(concurrent_database) as session:
        assert session.get(UserRecord, 1).session_version == 1


def test_unicode_category_names_fit_the_folded_key(client):
    # Each of these 24 characters folds to three code points on Postgres too.
    name = "ΐ" * 24
    assert len(name.casefold()) == 72
    response = client.post("/categories", json={"name": name, "color": "mint"})
    assert response.status_code == 201
    assert response.json()["name"] == name
    duplicate = client.post("/categories", json={"name": name, "color": "sky"})
    assert duplicate.status_code == 409
    assert duplicate.json() == {"detail": f'You already have a category called "{name}".'}
    assert CategoryRecord.__table__.c.name_key.type.length >= len(name.casefold())


def test_signup_and_concurrent_resend_share_limits(concurrent_database, monkeypatch, outbox):
    original_lock = main.lock_user
    intercepted = False

    def resend_before_signup_lock(session, user_id):
        nonlocal intercepted
        if not intercepted:
            intercepted = True
            # The committed account can already log in through another request.
            with TestClient(app) as other:
                assert other.post("/auth/login", json={"email": "race@example.com", "password": "valid pass"}).status_code == 200
                assert other.post("/auth/verify-email/resend").status_code == 204
        return original_lock(session, user_id)

    monkeypatch.setattr(main, "lock_user", resend_before_signup_lock)
    with TestClient(app) as client:
        response = client.post("/auth/signup", json={"name": "Name", "email": "race@example.com", "password": "valid pass"})
        assert response.status_code == 201
        assert client.get("/auth/me").json()["email_verified"] is False
    assert intercepted and len(outbox) == 1
