# Ladder Live → All-Time & Monthly Ladders — Design

**Date:** 2026-10-28
**App:** Pickleball Open Play Manager (`index.html`, single-file vanilla JS, Firebase Realtime DB)
**Builds on:** the timed Ladder Live format (`format: 'll'`, the `LL` engine).

## Intent / why

The app has two ranks, by design:
1. **Tonight's performance** — the open play's result, ranked by **point differential** (the Live Ladder). Resets each session. *Already works for Ladder Live.*
2. **All-time skill** — the **Season Ladder** (Standings tab), ranked by ELO rating across sessions, with week-over-week ▲/▼. *Ladder Live does NOT feed this today.*

Ladder Live keeps its rating/points inside its own engine (`ll.players`) and never writes them into the session record, so on **End Session** an LL night archives with **zero wins, zero points, no rating change** — it doesn't move the all-time ladder and shows empty in History. This feature fixes that and adds a **monthly leaderboard** alongside the all-time one.

**Decisions (from the user):**
- **Aggressive:** a Ladder Live night folds its **full** rating movement into the all-time rating (no dampening — it already uses a high K; big nights = big climbs/drops).
- **Add monthly:** a separate monthly leaderboard (same skill-rating method, current-month sessions only), alongside the all-time Season Ladder.

## Part A — Wire Ladder Live into the session record

The whole all-time/History machinery already reads `S.session.players` (and the archive built from it): `recalcAllTimeRatings` folds in each session's net `sRating − startRating` delta plus W/L; `_seasonLadderHtml` ranks `S.db` ratings with rank snapshots; History renders the archived session. So the fix is to **make Ladder Live write its results into `session.players`**, and everything downstream works unchanged.

### A1. Track W/L/points in the LL engine

`recordGame` already banks `pf/pa` into `ll.players`. The log stores scores per court but **not the teams**, so W/L can't be reconstructed later — track it as games are recorded:
- `LL.init`: add `wins:0, losses:0, ties:0` to each `ll.players[id]`.
- `recordGame`: for each court, the higher-scoring team gets a win for each of its players, the other a loss; equal scores → a tie for all four. (`pf/pa/games` already accrue.)

### A2. Sync `ll.players` → `session.players`

A `_syncLlToSession()` that, for each `ll.players[id]`, writes into the matching `session.players` entry:
- `sRating = ll.players[id].rating` (the evolved skill rating — the aggressive, full-delta value),
- `ptsFor = pf`, `ptsAgainst = pa`, `matchesPlayed = games`,
- `wins/losses/ties` from A1.

Call it **after every `recordGame`** (in `submitAndAdvance`, so `session.players` stays current across refreshes/devices and an abnormal end still has data) **and defensively at the top of `doEndSession`** before the archive is built. The sync is a write-over (idempotent), not additive.

### A3. Downstream — unchanged

Once `session.players` carries the LL results:
- `doEndSession` archives them (already reads `session.players`), `recalcAllTimeRatings` folds the net `sRating` delta into `S.db` ratings, the rank snapshot is taken → **the LL night now moves the all-time Season Ladder**.
- History shows the night's standings (W/L, points, rating) like any session.

## Part B — Monthly leaderboard

A new leaderboard ranking by **skill-rating gained this calendar month** — "who climbed the most this month" — shown alongside the all-time Season Ladder on the Standings tab.

- **Metric:** for each player, sum the net `sRating − startRating` deltas across archived sessions whose `date` falls in the **current month** (plus the active session if any). Rank by that monthly delta (descending); show the player's current rating as a secondary column.
- **Scope:** only players with ≥1 session this month appear.
- **Why delta, not absolute rating:** absolute rating is the all-time ladder's job; a monthly board that shows *movement this month* is the distinct, motivating view and reuses the same per-session deltas the all-time recalc already computes.
- **Render:** a `_monthlyLadderHtml()` beside `_seasonLadderHtml()`, same visual language, labeled e.g. "📅 THIS MONTH — rating gained (<Month Year>)".

## Non-goals

- **No match-by-match History detail for LL** (mapping `ll.log` → `cfLog`) — the night's standings/summary are enough for now; the per-game list can come later.
- **No change to Continuous Flow**, to the within-night point-diff ladder (rank #1), or to the existing all-time Season Ladder's method.
- **No dampening** of the LL→all-time contribution (the user chose aggressive).

## Anti-goals (would make this a failure even if it "works")

- An LL night still archiving as **zeros** / not moving the all-time ladder (the bug being fixed).
- **Double-counting** a night's results (sync must overwrite `session.players`, never add on top).
- The monthly board showing **stale** numbers mid-session, or counting a session in the **wrong month** (use the session `date`).
- W/L totals that **disagree** with the points/rating (A1 and A2 must come from the same recorded games).

## Constraints

- Single file `index.html`; vanilla JS; no framework/build/new dependency. Reuse the existing archive / `recalcAllTimeRatings` / Season Ladder machinery.
- `node cf-tests.js` must stay green; **add assertions**: `recordGame` tallies W/L/ties correctly; `_syncLlToSession` writes rating/points/W-L into `session.players` and is idempotent; the monthly delta sums only current-month sessions. Browser `SIM.runLadder` + a manual night are the final checks.

## Builder-check resolutions (my calls — flagging so they can be checked)

- **Sync frequency:** each `recordGame` **and** at `doEndSession` start — robust to mid-round ends; idempotent overwrite means no double-count.
- **Tie handling:** equal scores → a tie for all four players (matches the existing `act=0.5` in the rating math).
- **A player who left mid-night:** still in `ll.players`, so they sync normally; their partial record archives like any CF leaver.
- **Monthly boundary:** by the session's stored `date` (local month), not "last 30 days".

## Left to the builder

- Exact placement/labels of the monthly board on the Standings tab (above/below the Season Ladder).
- Whether the monthly board also shows a small rank number vs all-time.
- Copy/labels.
