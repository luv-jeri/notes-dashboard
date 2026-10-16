from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from backend.main import CONTENT_MAX, MAX_BODY_BYTES, TITLE_MAX, NoteStore, app, get_store, seed_demo_notes


@pytest.fixture
def client():
    store = NoteStore()
    app.dependency_overrides[get_store] = lambda: store
    yield TestClient(app)
    app.dependency_overrides.clear()


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

    assert first.headers["cache-control"] == "no-cache"
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


def test_demo_seed_gives_every_view_something_to_show():
    now = datetime(2026, 10, 16, 12, tzinfo=UTC)
    today = now.astimezone().date()
    store = NoteStore()

    seed_demo_notes(store, now=now)

    notes = store.all()
    open_notes = [note for note in notes if not note.done]
    done_notes = [note for note in notes if note.done]
    assert any(note.due_date == today for note in open_notes)
    assert any(note.due_date and note.due_date < today for note in open_notes)
    assert any(note.pinned for note in open_notes)
    assert done_notes
    assert all(now - timedelta(days=7) < note.completed_at <= now for note in done_notes)
    assert {note.category for note in notes} == {"work", "personal", "ideas", "shopping", "health"}
