# Ladder Live — mid-session roster changes (swap · pause · late arrivals)

**Date:** 2026-10-29
**Format affected:** Ladder Live (`format:'ll'`, the `LL` engine) only.

## Intent / why

Open play is fluid: people show up late, need a longer breather, or leave early,
and sometimes the organizer just needs to change who's on a court *right now*.
Today the live roster controls (`renderRosterModal`, `midAdd`/`midRemove`/`midRejoin`)
were built for the decommissioned Continuous Flow engine — they mutate
`S.session.activePlayers` and `sp.status` but **never touch `S.session.ll.players`**,
which is the frozen snapshot Ladder Live schedules from (built once in `LL.init`).
So in Ladder Live those actions don't actually reach the engine: a late arrival
never joins the rotation, a leaver keeps getting scheduled.

This feature gives Ladder Live its own, correct roster handling, driven entirely
from the **organizer screen** (the live view with the court cards).

## What success looks like

The organizer can, without ending the session:
- **Swap** a player on a court for someone in the resting pool, immediately.
- **Pause** a player (longer rest or heading home); they finish their current game
  and are then left out of scheduling until resumed.
- **Resume** a paused player back into the rotation.
- Have a **late arrival** who checks in appear in the resting pool and get scheduled
  (banded by rating) from the next round, with warm-up dampening on their first games.

All changes sync across devices (they live under `S.session.ll`, pushed as `session`).

## The model (approved with the user)

Each Ladder Live player is in one of:
- **In rotation** — eligible to be seated or to rest via the normal rotation.
- **Resting this round** — the normal forced-rest rotation (`_pickSitters`); still in rotation.
- **Paused** — explicitly out; not scheduled at all until resumed.

### Swap (immediate, per court)
- Organizer taps a seated player on a court card, picks a replacement from the **resting pool**
  (someone not currently seated and not paused).
- That court's game **resets**: its entered score (the `ll-s1-{court}`/`ll-s2-{court}` inputs) clears.
- The two trade places in `ll.current`. Because scores are entered *after*, `recordGame`
  reads the updated lineup, so **the replacement's rating moves, not the pulled player's**.
- Bookkeeping is corrected so the reset is honest: the pulled player's `games` credit for this
  round is reverted and they return to the pool; the replacement gets the `games` credit (so the
  warm-up ramp keys off *their* count) and is now seated. `lastPartner` is updated for both teams
  on that court.

### Pause (takes effect next round)
- Organizer hits pause on a player.
  - If the player is **seated in the current game**: they **finish it** (pause is *pending*),
    then are excluded from the next `buildGame`.
  - If the player is **resting / pooled**: paused immediately (just excluded from the next build).
- At the next `buildGame`, any pending pause becomes active; paused players are removed from the
  eligible set entirely — not counted toward court/sitter math, not forced to rest, counters frozen.
- Covers both "needs a longer rest" and "going home" — the only difference is whether they're resumed.

### Resume
- Clears paused/pending; the player is eligible again from the next `buildGame`, banded by current rating.
- A player who is never resumed simply stays off the courts; they remain on the night ladder for the
  games they did play (the avg-point-diff-per-game ranking, shipped separately, keeps that fair).

### Late arrival
- A checked-in player (in `activePlayers`, not `status:'left'`) who isn't yet in `ll.players` is
  reconciled **into** `ll.players` as a fresh pooled player: `games:0`, clean counters, `paused:false`,
  rating seeded from `sRating ?? gp(id).rating ?? 1000`.
- They are banded by that rating like everyone else from their next round; `games:0` means the
  warm-up K ramp dampens their first 1–2 games.

## Decisions the user made
- Swap pulls from the existing pool; the pulled player returns to the pool (both stay in the session).
- Mid-game swap **resets** the court; the game's result counts for the incoming player.
- Pause while on a court lets them **finish the current game**, effective next round.
- All controls on the **organizer screen**, not player phones.
- Check-in alone puts a late arrival in the resting pool; **banded by rating immediately**, first game = 0.

## Defaults chosen by the implementer (not the user's call)
- Late arrival seed rating = `sRating ?? all-time rating ?? 1000`; no special "start on the bottom court" rule.
- Paused players keep their standings row with frozen `games` (they don't vanish from the ladder).
- Reconciliation of `ll.players` against the roster runs at the top of `buildGame` (and on explicit
  roster actions) rather than via a live Firebase watcher, to stay with the app's existing
  render-on-action model.

## Goals
- Correct, synced Ladder Live rotation under add / remove / rest / swap.
- Engine logic kept pure and headless-testable in `LL` (DOM side-effects separate), per existing conventions.

## Non-goals / anti-goals
- No per-player controls on player phones (organizer-only).
- No mid-game score **splitting** between the two swapped players — the court resets instead.
- No special late-arrival banding or calibration beyond the existing warm-up ramp.
- No change to the timed synchronized round model itself.
- Not reviving or depending on the Continuous Flow engine.

## Constraints
- Single-file vanilla JS (`index.html`), no framework/build step.
- State lives under `S.session.ll`; every mutation persists via `STORE.save('session')` and repaints.
- Must degrade/sync across devices via Firebase (the existing `session` push path).

## Left to the builder
- Exact `LL` method surface (e.g. `syncRoster`, `pause`, `resume`, `swap`) and where they hook into
  `buildGame` / `renderLive` / `submitAndAdvance`.
- Live-view UI layout for the swap picker, pause/resume buttons, and a "Paused" section (a mockup
  can be offered during planning if useful).
- Headless test cases covering: pause (seated → pending, pooled → immediate), resume, swap
  (lineup change, score reset, attribution to incoming player, games bookkeeping), late-add reconcile.
