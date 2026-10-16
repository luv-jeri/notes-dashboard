import os
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend import main
from backend.main import (
    CONTENT_MAX, MAX_BODY_BYTES, TITLE_MAX, Base, NoteRecord, UserRecord,
    app, database_url, get_db,
)


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
    assert response.json() == {"id": 1, "name": "Jane", "email": "jane@example.com"}
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
    assert response.json() == {"id": 1, "name": "Owner", "email": "owner@example.com"}
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
