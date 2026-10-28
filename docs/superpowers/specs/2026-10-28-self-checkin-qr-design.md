# Self Check-In via QR — Design

**Date:** 2026-10-28
**App:** Pickleball Open Play Manager (`index.html`, single-file vanilla JS, Firebase Realtime DB)

## Intent / why

The organizer currently checks everyone in by hand. The goal is to let players
check *themselves* in by scanning one printed QR code, so the organizer can see
at a glance **who's here and who's not** without tapping through the roster.

This is explicitly the first slice of a bigger idea (players later seeing their
own score / ranking). For now it does one thing: "I'm here."

This feature is **format-agnostic** — it is used for *all* open plays, not just
ladder sessions. It operates on the roster (`S.db` / `S.checkedIn`), which sits
below any session format.

## Goals

- A player scans a shared QR, lands on a mobile page, finds their name, taps it,
  and is checked in — reflected in real time on the organizer's device via the
  existing Firebase sync.
- The organizer gets a clear, live "who's not here yet" board.
- Players who arrive late can still check in at any time (page stays live during
  an active session, not just the lobby).

## Non-goals (for now)

- **No per-player stats / score / ranking** on the check-in page. That's a later
  slice. The check-in page is check-in only.
- **No adding, renaming, or removing players** from the check-in page. If someone
  can't find their name, the page tells them to ask the organizer, who adds them
  through the existing roster flow.
- **No picking between multiple simultaneous check-in lists.** The organizer runs
  at most one open play at a time; two open plays on the same day are sequential.
  Ending the morning session (**End Session**) archives it as its own History
  entry *and* clears check-ins (`S.checkedIn.clear()`, index.html:5211), so the
  afternoon starts with a fresh, empty roster and the same QR/check-in page works
  unchanged. (New Day Reset also clears check-ins but without archiving — it's for
  abandoning a session, not for the morning→afternoon handoff.) The check-in page
  always reflects the single current roster.

## Anti-goals (would make this a failure even if it "works")

- A player taps their name, sees nothing happen (or can't tell if it worked), and
  double-taps or gives up. Confirmation must be unmistakable.
- A player checks in while offline, believes they're in, and isn't. Must degrade
  the same way the rest of the app does (queued write + visible pending state),
  never a silent success.
- The check-in link accidentally exposing organizer/admin controls beyond what
  the existing player/observer views already allow.

## The two surfaces

### 1. Player check-in page — new view mode `?view=checkin`

Follows the existing `?view=player` / `?view=observer` pattern (see
`initPlayerMode` / `initObserverMode` around line 10913, and `isPlayerModeUrl`).
A new `?view=checkin` (hash-obfuscated to `#checkin` in the address bar, same as
the others) renders a **dedicated minimal check-in screen**, not the full app.

Behavior:

- Shows the full roster from `S.db`, each player a tappable row.
- **Search box** at the top filters the list by name (long rosters stay quick on
  a phone).
- **Already-checked-in names stay visible**, marked green with a "✓ Here" tag, so
  nobody double-checks-in or worries it didn't register.
- Tapping a *not-yet-here* name checks that player in: `S.checkedIn.add(id)` →
  `SYNC.push()` (reuse the existing `toggleCheckIn` write path / retry+backup so
  offline resilience is automatic), then shows a full-screen **confirmation**:
  "You're checked in, <name>" with an **Undo** button (removes from `S.checkedIn`)
  for wrong taps — no organizer needed.
- "Can't find your name? Ask the organizer to add you." helper line at the bottom.
- Waits for Firebase data before rendering (the `?view=player` one-render-before-
  data-lands issue noted at line 1153 applies here too).
- Works during both lobby and an active session.

This view **can write** (unlike observer/player read-only views) but only to
`S.checkedIn`. Per project context, security is not a concern; URL obfuscation is
a UX nicety and the admin PIN remains the real gate, consistent with existing
views.

### 2. Organizer board — Layout B ("absent first")

Chosen layout: the people still missing are large and up top; the crowd already
here collapses to a quiet summary line.

- Header with a **"Show QR"** button.
- A count line: "**12** here · **5** not yet".
- **Still waiting on** — the absent players, each a row with a "＋ Here" button so
  the organizer can check someone in manually (late arrival who just tells them).
- **✓ Here (N)** — collapsed to a comma-separated line with a "show all" expander.
- **Live:** a name moves from "not here" to "here" the moment that player taps, via
  the normal re-render-on-sync path, ideally with a brief green flash.

Placement: in the **Setup tab**, in/near the existing roster area (the app already
has an "absent only" filter at line 3327 — this board supersedes/augments that for
the at-a-glance view). Builder to choose the exact insertion point to fit the
existing Setup layout.

### 3. The QR itself

A **"Show QR"** action (on the organizer board, and/or added to the existing
`openShareModal` at line 4576) opens a modal with a QR encoding
`<base>?view=checkin`, large enough to print, reusing QRCode.js exactly as the
existing player-link QR does (line 4604). One shared code; the organizer decides
when to display it.

## Constraints

- Single file `index.html`, vanilla JS, no build step, no framework. Match
  existing conventions (`gp`/`gsp`, `esc`, render-whole-tab functions, CSS vars).
- All state via `S` and Firebase; writes go through the existing `SYNC.push()` /
  `_pushWithRetry` / local-backup path.
- Must run `SIM.runBugChecks()` clean after the change (per CLAUDE.md); add a
  `cf-tests.js` assertion only if engine behavior is touched (it isn't expected to
  be — this is roster/UI, not matchmaking).

## Builder-check resolutions (my calls — flagging so they can be checked)

A read-through as the implementing builder surfaced three small gaps; none change
scope, so they're settled here:

- **One phone, several people.** After the confirmation, offer "Check in someone
  else" that returns to the list — so a parent/kid or a group sharing one phone
  can check in more than one name. (Serves the "make it easy" goal.)
- **Un-checking from the list.** Green "✓ Here" rows are *not* tappable to remove
  on the roster list; the only self-serve removal is **Undo** on the fresh
  confirmation. Prevents accidental un-check; a later change of mind is handled by
  the organizer.
- **Empty / no-roster state** (e.g. right after a reset): the page shows the
  search box and the "ask the organizer" helper line, never a blank screen.

## Left to the builder

- Exact DOM insertion point and markup for the Setup board, and whether the board
  replaces or sits above the current absent-filter UI.
- Whether "Show QR" lives only on the board, only in the share modal, or both.
- The green-flash live-transition detail (nice-to-have, not required).
- Copy/labels wording.
