# Accounts and saved notes

People sign up with an email and a password, and each person sees only their
own notes. They confirm their email from a link, and can reset a forgotten
password the same way. Google sign-in comes later and will sit beside this,
not replace it.

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
| D11 | Email goes through Resend (`POST https://api.resend.com/emails`, standard library only). Without `RESEND_API_KEY` the email is printed in the backend's terminal instead, so links work locally with no account. On Vercel the app refuses to start without `RESEND_API_KEY` and `NOTES_APP_URL`. | Owner request, 2026-10-16. The printed fallback must never run in production: it would put reset links in Vercel's logs. Production sends from `Notes <hello@cojeev.com>` (owner, 2026-10-16: "use the cojeev email for this"): cojeev.com is already verified in the owner's Resend account, and replies to hello@ reach a real inbox. |
| D12 | Links are `NOTES_APP_URL` + `/#verify-email=<token>` or `/#reset-password=<token>`. They are built only from `NOTES_APP_URL`, never from the request. The page reads the token, takes it out of the address bar, and sends it in a `POST`. | The part after `#` never reaches a server, so the token stays out of request logs and `Referer` headers. A link built from the `Host` header could be pointed at an attacker's site. Mail scanners that open links only load the page; they can't use the token up. |
| D13 | A token is `secrets.token_urlsafe(32)`. Only its SHA-256 is stored (`email_tokens`), with the address it was sent to. Confirmation links last 24 hours; reset links 1 hour and work once, and a new reset link cancels the older ones. A link stops working if the account's email has changed. | A database leak can't be turned into working links. A fast hash is enough for 256 random bits; slow hashing is for guessable passwords. |
| D14 | At most one email a minute and five a day per account and kind. A failed send doesn't count. The link is saved and committed before the email goes out, and the send runs with no transaction open; a failed send deletes its own link. A new reset link cancels the older ones only once it has been sent. | Stops the app from being used to flood someone's inbox, and keeps within Resend's free tier. The saved link holds the limit while the email is on its way, so two requests can't both send, and a slow email provider never holds the account's lock (which would block that person's saves for up to 10 seconds). |
| D15 | Forgot password always answers `202`, whether or not the email has an account, a limit was hit, or the send failed. A request for a real account can answer slower, because it waits for the email to send. | The answer never says who has signed up. The timing difference is accepted: sign-up's `409` already tells anyone whether an email has an account, so it reveals nothing new. |
| D16 | Each user has a `session_version`, carried in the JWT as `sv`. A password reset increments it, which ends every existing session, and logs the browser that reset it back in. A cookie from before this change has no `sv` and counts as version 0. | Someone who reset their password because of a stolen session gets the thief logged out. Old cookies keep working until the first reset. |
| D17 | Confirming is not required to use the app. Until someone confirms, the dashboard shows "Confirm your email" with Send again; a reset link also confirms the address. | Owner question 2 (open) defaults to this. Nothing is locked; the confirmed address is what makes password reset safe to rely on. |
| D18 | Existing databases get the new `users` columns (`email_verified_at`, `session_version`) from a small startup migration: it adds whichever is missing. Table creation and the migration run in one transaction behind a Postgres advisory lock, so two cold starts take turns instead of racing. Existing accounts start unconfirmed. | `create_all` creates new tables but never changes an existing one, and production already has users. |
| D19 | People can add their own categories beside the five built-in ones: a name (1 to 24 characters) and one of eight pastel colours, up to 20 each. A name can't repeat a built-in or another of theirs, in any case. Deleting one moves its notes to Personal. A note stores `c<id>` for a custom category. | Owner request, 2026-10-16. Moving notes to Personal means a delete never loses a note; the unique name keeps the filter pills unambiguous. |

Not built yet, worth adding before real users: rate limits on log-in, changing
your email address, and Google sign-in.

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
| `POST /auth/verify-email` | `{token}` | `204` confirmed (also for a used link whose account is already confirmed). `400` "This link has expired or was already used." Logs nobody in. |
| `POST /auth/verify-email/resend` | none, needs a session | `204` sent. `409` already confirmed. `429` with `Retry-After`: "Wait a minute before asking for another email." or "You've asked for 5 emails today. Try again tomorrow." `503` if the send failed. |
| `POST /auth/password/forgot` | `{email}` | Always `202`, no body (D15) |
| `POST /auth/password/reset` | `{token, password}` | `200` user, sets a new cookie and ends every other session. `400` "This link has expired or was already used." |
| `GET /categories` | none | `200` the user's own categories, oldest first |
| `POST /categories` | `{name, color}` | `201` category. `409` if the name matches a built-in or one of theirs (any case), or they already have 20. |
| `PATCH /categories/{id}` | `{name?, color?}` | `200` category, same rules. `404` if not the user's. |
| `DELETE /categories/{id}` | none | `204`. Its notes move to Personal first (their `updated_at` stays). `404` if not the user's. |

Every `/notes` and `/categories` route answers `401` "Log in to see your notes." without a valid
session.

- A user is `{id, name, email, email_verified}`.
- `name`: 1 to 60 characters, trimmed.
- `email`: a valid address, stored in lower case, unique.
- `password`: 8 to 128 characters.
- The email and password rules apply at sign-up; log-in only needs both filled in (D9).
- A note keeps its current shape: `id, title, content, category, due_date,
  pinned, done, created_at, updated_at, completed_at`.
- A note's `category` is a built-in key (`work`, `personal`, `ideas`,
  `shopping`, `health`) or `c<id>` for one of the user's own categories.
  Anything else, including another user's, answers `422` "Choose a category
  from the list."
- A category is `{id, key, name, color}`: `key` is `c<id>`, `name` 1 to 24
  characters (trimmed), `color` one of `lilac, rose, peach, mint, sky,
  butter, sage, stone`.
