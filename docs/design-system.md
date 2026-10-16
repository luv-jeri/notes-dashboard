# Notes design system

The look follows a reference shot the owner picked (a soft course dashboard):
pastel cards on a warm white page, big friendly type, black pills for "you are
here", an icon rail on the left and a summary panel on the right.

## Principles

1. **Colour means category.** Every pastel stands for one category, everywhere:
   card fill, filter pill icon, chart segment, "due soon" card. Colour is never
   decoration.
2. **Black means selected.** The active view, the active filter and the main
   button are near-black pills. Everything else stays light.
3. **Round and soft, never fussy.** Large radii, no borders on cards, no drop
   shadows except on the dialog and toasts that float above the page.
4. **The headline says something true.** The big type is a live summary
   ("2 notes due today"), not a slogan.
5. **Every state has words.** Loading, empty, no matches, offline and failed
   saves each say what happened and what to do next.

## Colour tokens

Defined in `frontend/src/styles/tokens.css`. Components use tokens only, never
raw hex values.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#fbf8f5` | `#141317` | Page |
| `--surface` | `#f2ede8` | `#1d1c21` | Rail, side panel, inactive pills, done cards |
| `--raised` | `#ffffff` | `#29282e` | Icon circles, chips, panel cards, inputs, dialog |
| `--ink` | `#18171c` | `#f3f0ec` | Text, selected pills |
| `--ink-soft` | `#4a474f` | `#c9c4cc` | Note previews |
| `--ink-muted` | `#6b6670` | `#9c97a0` | Labels, meta, placeholders |
| `--on-ink` | `#ffffff` | `#18171c` | Text and icons on a selected pill |
| `--line` | `#e6e0da` | `#34333a` | Hairlines, chart tracks |
| `--danger` | `#b42318` | `#ff8a80` | Overdue, delete, errors |
| `--danger-soft` | `#fde4e1` | `#3a2224` | Overdue chip fill |

Category pastels. Cards keep dark text in both themes (`--on-pastel`), so dark
mode dims the pastels slightly instead of inverting them.

| Category | Fill token | Light | Dark | Strong (chart, light / dark) | Icon |
| --- | --- | --- | --- | --- | --- |
| Work | `--lilac` | `#dcd7f7` | `#c9c3ee` | `#b3a9ee` / `#a79ce8` | Briefcase |
| Personal | `--rose` | `#f4cdd0` | `#e8bcc0` | `#eba4aa` / `#e0959c` | User |
| Ideas | `--peach` | `#f8dfc4` | `#ecd0b1` | `#f2bf8a` / `#e6b27c` | Lightbulb |
| Shopping | `--mint` | `#c9eedb` | `#b5e2cb` | `#8fdab4` / `#80cfa6` | Shopping bag |
| Health | `--sky` | `#cfe3f6` | `#bcd5ec` | `#9cc5ec` / `#8db8e2` | Heart pulse |

`--on-pastel` is `#18171c` and `--on-pastel-soft` is `#45424a` in both themes.

## Type

One family: **DM Sans** (variable, self-hosted through Fontsource). Geometric
and round like the reference, with a double-storey "a" that stays readable at
small sizes.

| Role | Size / line height | Weight | Tracking |
| --- | --- | --- | --- |
| Display (headline) | `clamp(2.25rem, 2.5vw + 1.5rem, 3.5rem)` / 1.05 | 500 | -0.035em |
| Card title | 1.375rem / 1.25 | 500 | -0.015em |
| Panel number | 2rem / 1 | 500 | -0.03em |
| Body | 0.9375rem / 1.5 | 400 | 0 |
| Section label | 0.9375rem / 1.4 | 500 | 0, `--ink-muted` |
| Small label (category, chip) | 0.8125rem / 1.2 | 600 | 0 |

Sentence case everywhere. No all-caps labels.

## Shape, space, motion

- Radii: `--radius-xl` 32px (rail, panel), `--radius-lg` 24px (cards, dialog),
  `--radius-md` 16px (inputs, panel cards), `--radius-pill` 999px.
- Circles: 48px rail buttons, 40px card actions, 36px icon holders.
- Space on a 4px grid: 4, 8, 12, 16, 20, 24, 32, 40, 56.
- Motion answers an action; nothing moves on its own. Four durations
  (`--duration-quick` 140ms, `--duration-base` 200ms, `--duration-slow`
  320ms, `--duration-spring` 520ms) and four curves:
  - `--ease-out` for things arriving or answering a touch (fast start, soft
    landing): hover lifts, the dialog and toasts coming in.
  - `--ease-in` for things leaving (they speed away): the dialog and toasts
    going out, 160ms, a little quicker than they came.
  - `--ease-in-out` for things moving from one place to another: the rail and
    panel folding, the scroll map's blocks re-sorting.
  - `--ease-spring` (a `linear()` curve that overshoots by about 5%) for small
    physical answers: a pressed button springing back, the plus turning on
    New note, the rail's sliding indicator.
- Pressing sinks a control (`scale` 0.88 to 0.95, 80ms); letting go springs
  it back. Cards lift 3px with a deeper shadow while their title or a button
  on them is hovered. The theme switch spreads the new colours out in a circle
  from its button (View Transitions). Under `prefers-reduced-motion` all of it
  turns off, and jumps scroll instantly.
- Hover is a quiet `--hover` wash (ink at 6 to 7% opacity), so it works on any
  fill: page, pastel card or dark surface. Hover styles sit inside
  `@media (hover: hover)`, so a tap on a phone never leaves a button looking
  selected. A filled (pinned or done) button stays filled on hover.

## Layout

```
┌rail┐ ┌──────────── main ──────────────────────┐ ┌map┐ ┌── panel ──┐
│ ■  │ │ Good afternoon,                        │ │▮▮ │ │ Fri 16 Oct│
│    │ │ 2 notes due today                      │ │┌─┐│ │ 6/15 done │
│ ▦  │ ├─ sticks to the top ────────────────────┤ ││▮││ │ ▂▅▃▇▁▄█   │
│ ◷• │ │       [search....] [Sort ▾] [+ New]    │ │└─┘│ │ Due soon  │
│ ☆  │ │ (All)(Work)(Personal)(Ideas)...        │ │▮▮▮│ │ [card]    │
│ ✓  │ ├────────────────────────────────────────┤ │ ─ │ │ [card]    │
│    │ │ Pinned                                 │ │▯▯▯│ │           │
│ ⇤  │ │ [card] [card]                          │ │   │ │           │
│ ☾  │ │ Notes  [card] [card] [card] [card]     │ │   │ │           │
└────┘ └────────────────────────────────────────┘ └───┘ └───────────┘
```

- 1200px and wider: four columns, edge to edge with no maximum width:
  rail 80px (216px widened) | notes | map 40px | panel 340px (72px folded).
  The rail, map and panel stick to the viewport; the toolbar sticks to the
  top of the notes column, and notes fade out as they pass under it. Folding
  either side changes one CSS variable, and the grid eases to the new widths.
- 760 to 1199px: rail, notes and map; the panel moves under the notes and
  doesn't fold.
- Under 760px: the rail becomes a bottom tab bar (without the widen button),
  the map hides (a thumb scroll is the phone's own map), Sort shows only its
  icon, filter pills scroll sideways, cards stack in one column, and the
  editor rises from the bottom edge as a sheet.
- Under 360px: "New note" shows only its plus icon; screen readers still hear
  the words.

## Components

| Component | Notes |
| --- | --- |
| Rail button | 48px circle. Active: one `--ink` shape that slides to the current view with the spring, `--on-ink` icon, `aria-current="page"`. Tooltip on hover and focus. A dot marks Today when something is due or overdue. Widened, the shape stretches into a pill, names show beside the icons, Today gets a count badge, and tooltips turn off. |
| Sticky toolbar | Search, Sort, New note and the filter pills. Sticks to the top; once stuck, a short fade under it softens the notes passing beneath. Publishes its height as `--toolbar-height`, which the notes use as `scroll-margin-top`, so Tab and jumps stop clear of it. Search widens while focused. |
| Sort dropdown | `ui/Select.tsx`: a button with `role="combobox"` and a listbox (ARIA select-only combobox pattern). Focus stays on the button; arrows, Home/End, typed letters, Enter/Space and Escape work as in a native select; a press outside closes it. Open: ring, flipped chevron, `--raised` list with a tick on the current option. Only the list scrolls, never the page. |
| Scroll map | `NoteMap.tsx`: every card as a block in its category's strong colour (outlined when done), laid out like the grid, shrunk to fit the track (at most 1:7 tall). A dash marks each new section; an ink lens shows what's on screen below the toolbar. Hover shows the note's title in an ink pill to the left; click jumps to the card and pulses a ring round it; drag scrubs. Hidden from screen readers and Tab, like a scrollbar: the page itself is the accessible route. |
| Panel strip | The folded panel: weekday and date, a progress ring with the share done, and the due-soon count. Its tooltips open to the left, over the map. |
| Filter pill | `--surface` pill with a 36px `--raised` icon circle. Active: `--ink` pill, `aria-pressed="true"`. |
| Note card | Category fill. Top: icon circle, category label, and a due-date chip when the note has one. Middle: title (opens the editor; the whole card is the hit area), up to three lines, then a preview of up to three lines cut at 280 characters. Bottom: "Edited 2h ago" on its own line, then pin and delete on the left and done on the right, away from delete. Pinned shows as a filled pin button, like a ticked check. Done cards switch to `--surface`, keep the category colour only in the icon circle, and strike through the title. |
| Chip | `--raised` pill, 0.8125rem, icon plus text. Overdue chip uses `--danger` on `--danger-soft`. |
| Primary button | `--ink` pill, `--on-ink` text, 44px tall. |
| Quiet button | Transparent pill, `--ink`, hover fill `--hover`. |
| Outline button | Transparent pill with a 1px `--line` ring, hover fill `--hover`. Used for "Show 48 more". |
| Icon button | 40px `--raised` circle with an `aria-label` and a tooltip. |
| Dialog | Native `<dialog>`, `--raised`, 24px radius, lifted shadow. The title and note sit in a sheet tinted with the chosen category. The title is focused on open and grows to four lines, then scrolls. Length hints appear once a field is 80% full. Quick dates: Today, Tomorrow, Next week, or pick a date. The footer stays in view while the form scrolls. |
| Week chart | Seven stacked bars (last 7 days), one segment per finished note in its category's strong colour, today outlined and labelled in a black pill. Readable by screen readers as a list. |
| Toast | `--ink` pill bottom right, `--on-ink` text, optional action. Rises in; on leaving it sinks and fades (160ms, ease-in) before it's removed. At most three at once. Failed saves are alerts and stay until handled; "Undo" toasts leave after 6 seconds, and the timer pauses while the pointer or keyboard focus is on them. Closing one hands focus back to where it was. |
| Show more | Each section draws 48 cards, then an outline button shows the next 48 and moves focus to the first new card. |
| Log-in screen | `auth/AuthScreen.tsx`: two columns on wide screens, a `--surface` panel with the name, a fan of three note cards (only the front card carries words) and one line on what the app is for; the form on the page beside it. Under 900px the panel becomes a header strip above the form; on phones the fan hides. One form switches between "Log in" and "Create your account", keeping what was typed. Inputs are 48px tall with 1rem text, so phones don't zoom. Mistakes show under their field in `--danger` and focus moves to the first one; server answers show in a `--danger-soft` alert, with "Log in instead" when the email already has an account. A note above the form says when a session has ended. |
| Account menu | Last button in the rail foot: a circle with the person's initial. It opens a `--raised` panel with their name, email and "Log out". Beside the slim rail it opens to the right; in the widened rail it opens upward inside the rail; on phones it is the last tab and the panel sits above the bar. Escape, a press outside or tabbing away closes it, and Escape hands focus back to the button. |
| Empty screen | A new account's first view: "No notes yet", one line on what to write, one on the sample notes, then "New note" (primary) and "Add sample notes" (outline), with the small card fan beside them when there is room. The headline's second line reads "start your first note". |

## Built for many notes

- The server caps a title at 200 characters and a note at 10,000. The editor
  enforces the same limits, so a save never fails on length.
- A card shows at most three title lines and a 280-character preview, cut
  without splitting an emoji, so one huge note can't stretch its row.
- Cards far off screen skip layout and paint (`content-visibility: auto`) and
  hold their last drawn size, so a long list scrolls without the scrollbar
  jumping.

## Accessibility floor

- Text contrast at least 4.5:1 on every fill, including all pastels.
- Visible focus: 2px `--ink` outline, 2px offset, on every control.
- Every icon-only button has a label. Colour is never the only signal (overdue
  also changes the icon and the words; done also strikes through).
- Keyboard: `N` opens a new note, `/` jumps to search, `Esc` closes the
  editor and cancels a delete, which opens with focus on "Keep". Focus never
  falls back to the page body: not when a card leaves its section, not when a
  toast closes, and not when a retried change moves the focused card.

## Feature list

| Id | Feature | Where |
| --- | --- | --- |
| F1 | Add, edit, delete notes through the API | `useNotes.ts`, `NoteFormDialog.tsx`, `NoteCard.tsx` |
| F2 | Mark done and undo, with "done" time kept by the server | `NoteCard.tsx`, `useNotes.ts`, `backend/main.py` |
| F3 | Categories with colour, filter pills | `categories.ts`, `CategoryPills.tsx` |
| F4 | Due dates, overdue and "due today" states | `dates.ts`, `NoteCard.tsx` |
| F5 | Pin to top | `NoteCard.tsx`, `selectNotes.ts` |
| F6 | Views: All, Today, Pinned, Done | `Rail.tsx`, `selectNotes.ts` |
| F7 | Search across title and text | `selectNotes.ts` |
| F8 | Sort: newest, due date, A to Z | `selectNotes.ts` |
| F9 | Progress panel: done count, last-7-days chart, due soon | `SidePanel.tsx`, `WeekChart.tsx` |
| F10 | Light and dark themes, remembered | `useTheme.ts`, `tokens.css` |
| F11 | Keyboard shortcuts | `useShortcuts.ts` |
| F12 | Optimistic saves with rollback and "Try again" | `useNotes.ts` |
| F13 | Thousands of notes, long titles and long notes stay fast | `backend/main.py`, `NotesDashboard.tsx`, `text.ts`, `NotesStates.module.css` |
| F14 | Edge-to-edge layout; search, sort, New note and filters stay pinned while scrolling | `NotesDashboard.module.css`, `useStickyBar.ts` |
| F15 | Custom sort dropdown, usable by mouse, keyboard and screen reader | `ui/Select.tsx` |
| F16 | Scroll map: see every note at a glance, jump or scrub to any of them | `NoteMap.tsx` |
| F17 | Foldable rail and panel, remembered | `Rail.tsx`, `SidePanel.tsx`, `useStoredFlag.ts` |
| F18 | Motion that answers every action, eased in and out, off under reduced motion | `tokens.css`, `*.module.css`, `useTheme.ts`, `ToastProvider.tsx` |
| F19 | Accounts: sign up, log in, log out; each person sees only their notes | `backend/main.py`, `auth/`, `api/auth.ts`, `docs/auth.md` |
| F20 | Account menu in the rail and the phone tab bar | `Rail.tsx` |
| F21 | Empty screen for a new account, with sample notes on request | `NotesStates.tsx`, `POST /notes/samples` |

Done means: every row above works in the browser against the real backend,
in both themes and at phone width, with tests passing.
