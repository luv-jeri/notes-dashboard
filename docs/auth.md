# Accounts and saved notes

People sign up with an email and a password, and each person sees only their
own notes. Google sign-in comes later and will sit beside this, not replace it.

## Decisions

| Id | Decision | Why |
| --- | --- | --- |
| D1 | Email and password sign-up and log-in. Google later. | Owner request, 2026-10-16 |
| D2 | The session is a JWT (HS256, PyJWT), valid 7 days, sent in an `httpOnly` cookie named `notes_session` (`SameSite=Lax`, `Secure` over HTTPS, `Path=/`). Log out clears it. | Scripts on the page can't read an `httpOnly` cookie, so an injected script can't steal the session. A token in `localStorage` can be read by any script. |
| D3 | Passwords are hashed with Argon2id (pwdlib, the library FastAPI's docs recommend). A log-in for an unknown email still checks a dummy hash. | Hashes can't be reversed; the dummy check makes "no such account" take as long as "wrong password", so timing doesn't reveal who has an account. |
| D4 | Storage is SQLAlchemy 2. With no `DATABASE_URL` it uses a SQLite file, `backend/notes.db` (not committed). On Vercel, `DATABASE_URL` points at Neon Postgres. Tables are created on startup. | Runs locally with no setup; the deployed app keeps accounts and notes across restarts. |
| D5 | Every note belongs to one user. Another user's note id answers 404, not 403. | Ids don't reveal that someone else's note exists. |
| D6 | A new account starts with no notes. The empty screen offers "New note" and "Add sample notes" (`POST /notes/samples`). | A clear first step, plus a quick way to see every feature with real-looking data. |
| D7 | The signing secret comes from `NOTES_JWT_SECRET`. On Vercel the app refuses to start without it; locally a random one is made at startup (sessions end on restart). | No secret in the code or the repo. |
| D8 | Writes rely on `SameSite=Lax` against cross-site requests: the browser doesn't send the cookie on a cross-site `POST`, and `PUT`/`DELETE` can't be sent cross-site without CORS, which the API doesn't allow. | Same-origin app; no CSRF token needed. |
| D9 | Log-in checks only that the email and password are filled in and not too long. An email that isn't valid, or a password shorter than 8 characters, gets the same 401 as a wrong password. | The sign-up rules describe new accounts. On the log-in form they would only tell someone why an attempt can't match, and a different answer for "too short" would show which passwords are worth trying. |
| D10 | Errors from `/auth/*` never repeat what was sent: validation errors keep only the field, the message and the type. `/auth/*` answers are not cached (`Cache-Control: no-store`). | FastAPI's default validation error echoes the input, which would put a password back on the wire and into logs. |

Not built yet, worth adding before real users: rate limits on log-in, email
verification, password reset, and Google sign-in.

## API

Everything is JSON. Errors are `{"detail": "..."}` (or FastAPI's list form for
validation errors), as before.

| Method and path | Body | Answer |
| --- | --- | --- |
| `POST /auth/signup` | `{name, email, password}` | `201` user, sets the cookie. `409` if the email has an account. |
| `POST /auth/login` | `{email, password}` | `200` user, sets the cookie. `401` "That email and password don't match an account." |
| `POST /auth/logout` | none | `204`, clears the cookie |
| `GET /auth/me` | none | `200` user, or `200` `null` when logged out (no error in the console on a first visit) |
| `GET /notes` | none | `200` the user's notes, with ETag and `304` as before |
| `POST /notes` | note fields | `201` note |
| `PUT /notes/{id}` | note fields | `200` note, `404` if not the user's |
| `DELETE /notes/{id}` | none | `204`, `404` if not the user's |
| `POST /notes/samples` | none | `201` the user's full list after adding the sample notes |

Every `/notes` route answers `401` "Log in to see your notes." without a valid
session.

- A user is `{id, name, email}`.
- `name`: 1 to 60 characters, trimmed.
- `email`: a valid address, stored in lower case, unique.
- `password`: 8 to 128 characters.
- The email and password rules apply at sign-up; log-in only needs both filled in (D9).
- A note keeps its current shape: `id, title, content, category, due_date,
  pinned, done, created_at, updated_at, completed_at`.
