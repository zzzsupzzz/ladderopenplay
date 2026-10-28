# Per-Event Registered List — Design

**Date:** 2026-10-28
**App:** Pickleball Open Play Manager (`index.html`, single-file vanilla JS, Firebase Realtime DB)
**Builds on:** the Self Check-In via QR feature (`2026-10-28-self-checkin-qr-design.md`), already shipped.

## Intent / why

Different events have different people. Registration happens on **Reclub** (external), and the organiser manually marks which of their existing database players registered for a given event. Today the self check-in QR page lists the **entire** player database, so a registered player wading in sees everyone who has ever played. This feature scopes everything for one event down to just that event's **registered** people.

## The core idea — two layers

Today "Today's Roster" (the ticked players, `S.checkedIn`) conflates two different things: *who's playing tonight* and *who has arrived*. This feature splits them:

- **Registered** — who the organiser *expects* this event, set from Reclub by ticking names out of the player database. A new per-event list.
- **Here** (the existing `S.checkedIn`) — who has *actually arrived*, set by the players themselves on the QR page (or by the organiser's ＋Here).

The QR check-in page and the organiser board both **scope to the registered list** — a registered player opens the QR, finds their name among just this event's people, and taps "I'm here". "Here" is always a subset of "Registered".

## Goals

- The organiser marks who registered for an event by ticking database players (fast, from the Reclub list).
- The registered list is **editable any time** — add or remove names for replacements and drop-outs, including adding a brand-new person to the database and registering them in one step.
- The self check-in QR page shows **only the registered players**, not the whole database.
- The organiser board shows the **registered list split into here / not-here**, so it's obvious who hasn't arrived.
- No-shows stay visible in "not here"; a **Remove** control takes a confirmed drop-out off the registered list.

## Non-goals

- **No Reclub integration / import.** Registration is entered manually by ticking the database. (A future CSV/paste import could help, but is out of scope here.)
- **No separate "no-show" status or flag.** A registered player who never arrives simply stays in "not here". Removal is a deliberate organiser action, not an automatic state.
- **No change to matchmaking, scoring, ratings, or session formats.** This is purely about who appears for check-in.

## Anti-goals (would make this a failure even if it "works")

- A registered player opens the QR and **can't find their name** because the scoping dropped them — the registered list must be exactly what the organiser set, synced reliably.
- A replacement arrives, the organiser adds them, and they **still can't self-check-in** — adding to registered must immediately reflect on the QR page.
- The organiser **loses the registered list** on a reload or across devices — it must sync and survive like check-ins do.
- Scoping makes the **plain walk-up-and-check-everyone-in** workflow impossible for organisers who don't use Reclub — the full-roster behaviour must remain available (see "Empty registered list" below).

## Data model

- Add **`S.registered`** — a `Set` of player ids, paralleling `S.checkedIn`. A first-class **synced node** (same treatment `checkedIn` got: written in `SYNC.push`, read in `_applyRemote`, mirrored to local backup). Represents this event's registered players.
- `S.checkedIn` stays as the "here" set, and remains a subset the organiser/players populate.
- **Lifecycle:** `S.registered` is set in the Setup window (before or during check-in), carries through the event, and is **cleared alongside `S.checkedIn`** on End Session and New Day Reset (so the next event starts with an empty registered list). Factory reset wipes it too.

## Behaviour

### Scoping rule (the one switch)

- **If `S.registered` is non-empty**, the check-in QR page and the organiser board operate on the **registered** players only (`_absentPlayers`/`_presentPlayers` become "registered not-here" / "registered here").
- **If `S.registered` is empty**, everything falls back to **today's behaviour** — the QR page and board show the whole database. This preserves the no-Reclub / walk-up workflow and means the feature is opt-in per event (an organiser who never registers anyone sees no change).

### Setting the registered list (Setup)

- In the **Player Database** card, each player row gets a **register toggle** (e.g. a checkbox / "Register" chip) that adds/removes them from `S.registered`. Ticking from the database is the primary input.
- A header control shows the registered count and offers **Clear registered**.
- Adding a new player (existing **+ Add**) can optionally register them immediately (a "register on add" default when a registered list is already in progress), so a last-minute Reclub name is one action.
- Builder to choose whether this lives inline on the database rows or as a dedicated "Registered for this event" panel — whichever fits the existing Setup layout best.

### The QR check-in page (`?view=checkin`)

- Renders from the **registered** list when non-empty (else the whole database, as today).
- Everything else unchanged: search, tap to check in, confirmation + Undo + "Check in someone else", green "✓ Here" rows, "ask the organiser" helper for anyone not listed.

### The organiser board (Setup, Layout B)

- "`N` here · `M` not yet" counts are **of the registered list** when non-empty.
- "Still waiting on" = registered players not yet here, each with **＋ Here** (as today) **and a small ✕ Remove** control that takes them off the registered list (the drop-out / replacement action).
- "✓ Here (N)" = registered players who've arrived.
- When `S.registered` is empty, the board behaves exactly as it does today (whole database).

### Begin play

- Starting the session continues to build from **who's *here*** (`S.checkedIn`), not from registered — you play with who showed up, not who was expected. (Unchanged from today; registered is an expectation layer above check-in.)

## Constraints

- Single file `index.html`; vanilla JS; no framework/build/new dependency. Match existing conventions and the self-check-in code already added (`_absentPlayers`/`_presentPlayers`, `selfCheckIn`, `renderCheckin`, `renderCheckinBoard`, the `checkedIn` synced-node pattern).
- `S.registered` must sync and back up exactly like `S.checkedIn` (reuse that pattern end to end).
- `node cf-tests.js` must stay green; add assertions for the scoping rule and the registered synced-node/reset behaviour. Full browser `SIM.runBugChecks()` is the user's final check.

## Builder-check resolutions (my calls — flagging so they can be checked)

A read-through as the implementing builder surfaced four gaps; none change the shape of the
feature, so they're settled here:

- **"Here" is always ⊆ "Registered".** When a registered list is active, checking anyone in (self
  check-in, or an organiser toggle) also adds them to `S.registered`. This keeps a checked-in
  person from ever being hidden by the scoping, and means a walk-up the organiser checks in is
  registered automatically. (When `S.registered` is empty, no invariant is needed — the whole
  database shows.)
- **The scoping is one switch in the pool.** `_absentPlayers`/`_presentPlayers` draw from
  `registered` players when `S.registered` is non-empty, else from all of `S.db`. Every surface
  (QR page, board) inherits the scope from these helpers — no per-surface branching.
- **Remove-from-registered also checks them out.** Taking a registered player off the list (the
  drop-out/replacement action) removes them from `S.checkedIn` too — they're no longer part of
  the event.
- **`S.registered` persists and resets exactly like `S.checkedIn`.** Synced node + local backup;
  cleared *and saved* on End Session, New Day Reset, and Factory reset, so the next event starts
  empty.

## Left to the builder

- Exact Setup UI for the register toggle (inline row control vs dedicated panel) and the Remove control's placement on the board.
- Whether "register on add" is on by default while a registered list is in progress.
- Copy/labels.
- The green-flash / live-transition polish (nice-to-have).
