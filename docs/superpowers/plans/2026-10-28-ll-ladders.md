# Ladder Live → All-Time & Monthly Ladders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ladder Live nights feed the all-time Season Ladder (and History), and add a monthly "climbed this month" leaderboard.

**Architecture:** Ladder Live already evolves rating/points inside `ll.players`. (1) Track W/L/ties there as games are recorded. (2) Sync `ll.players` → `session.players` (rating, points, W/L, games) each round and on End, so the existing archive / `recalcAllTimeRatings` / Season Ladder / History pick it up unchanged (aggressive — full LL delta). (3) Add `_monthlyLadderHtml()` ranking by net `sRating−startRating` summed over the current month's sessions, rendered beside the Season Ladder.

**Tech Stack:** Vanilla JS in single-file `index.html`, Firebase Realtime DB. No build. Headless tests via `node cf-tests.js`.

**Spec:** `docs/superpowers/specs/2026-10-28-ll-ladders-design.md`

## Global Constraints

- Single file `index.html`; vanilla JS; no framework/build/new dependency. Reuse the existing archive / `recalcAllTimeRatings` / `_seasonLadderHtml` machinery.
- The LL→all-time contribution is the **full** LL rating delta (aggressive; no dampening).
- The `_syncToSession` write is an **overwrite** (idempotent), never additive — no double-counting.
- `node cf-tests.js` must pass after every task; existing LL tests stay green. Browser `SIM.runLadder` + a manual night are the user's final checks.

## Review Focus

- **Idempotent sync** — calling the sync twice (each round + on End) yields the same `session.players`, never doubled points/W-L — owned by Task 2, tested.
- **Tie counts for all four** — a `6–6` game gives each of the four a tie, not a win/loss — owned by Task 1, tested.
- **Monthly scoping** — a session dated last month is excluded; only current-month sessions sum into the monthly delta — owned by Task 3, tested.
- **W/L agrees with points/rating** — the W/L tallied in Task 1 comes from the same recorded games as `pf/pa` and the rating move — owned by Task 1 (tally in `recordGame`), checked by Task 2's sync test.
- **A player who left mid-night** still syncs (they stay in `ll.players`) and archives with their partial record — owned by Task 2; browser-verified.

---

### Task 1: Track W/L/ties in the LL engine

**Files:**
- Modify: `index.html` — `LL.init` (add `wins/losses/ties` to each `ll.players[id]`), `LL.recordGame` (tally per court).
- Test: `cf-tests.js` — new `section('Ladder Live — timed: W/L tally')`.

**Interfaces:**
- Produces: `ll.players[id].wins/losses/ties` (ints), accrued in `recordGame` alongside the existing `pf/pa`.

- [ ] **Step 1: Write the failing tests**: build an LL game with known teams/ratings (as in the evidence test), `recordGame({1:[11,5]})` → each of the winning team's two players has `wins` +1 and `losses` 0; each loser has `losses` +1, `wins` 0; then `recordGame` a `6–6` on a fresh game → all four get `ties` +1, no win/loss. Assert `wins+losses+ties === games` for a player after two recorded games.
- [ ] **Step 2: Run** `node cf-tests.js` — Expected: FAIL (`ll.players[id].wins` undefined / not tallied).
- [ ] **Step 3: Implement**: in `init`, add `wins:0, losses:0, ties:0` to each player object; in `recordGame`, after reading `[s1,s2]`, bump `g.t1`/`g.t2` players: `s1>s2` → t1 win / t2 loss; `s1<s2` → t2 win / t1 loss; equal → tie for all four.
- [ ] **Step 4: Run** `node cf-tests.js` — Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 2: Sync LL results into `session.players` (each round + on End)

**Files:**
- Modify: `index.html` — add `LL._syncToSession()`; call it in `LL.submitAndAdvance` (after `recordGame`) and at the top of the `doEndSession` confirm handler when `S.session.format==='ll'` (before the archive is built).
- Test: `cf-tests.js` — new `section('Ladder Live — timed: sync to session.players')`.

**Interfaces:**
- Consumes: `ll.players[id]` (`rating/pf/pa/games/wins/losses/ties` from Task 1), `S.session.players`.
- Produces: `LL._syncToSession()` — for each `ll.players[id]`, overwrite the matching `S.session.players` entry's `sRating=rating`, `ptsFor=pf`, `ptsAgainst=pa`, `matchesPlayed=games`, `wins/losses/ties`.

- [ ] **Step 1: Write the failing tests**: build an LL session (`makeSession` + `LL.init` + `buildGame`), record a couple of games with known scores, call `LL._syncToSession()`; assert a player's `S.session.players` entry now has `sRating === ll.players[id].rating`, `ptsFor/ptsAgainst/matchesPlayed` matching `ll.players[id]`, and `wins/losses` matching the tally. **Idempotency:** capture `S.session.players` W-L/points, call `_syncToSession()` again, assert unchanged (overwrite, not additive). Assert `startRating` is untouched (so the net delta is the night's movement).
- [ ] **Step 2: Run** `node cf-tests.js` — Expected: FAIL (`_syncToSession` undefined).
- [ ] **Step 3: Implement** `_syncToSession()` (map `ll.players` onto `session.players` by id; skip ids not in the session). Call it in `submitAndAdvance` right after `this.recordGame(scores)`, and in `doEndSession` (LL branch) before building `arch`.
- [ ] **Step 4: Run** `node cf-tests.js` — Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 3: Monthly leaderboard ("climbed this month")

**Files:**
- Modify: `index.html` — add `_monthlyLadderHtml()` near `_seasonLadderHtml` (~line 4457); render it in the Standings tab beside the Season Ladder (where `_seasonLadderHtml()` is used, ~line 4498).
- Test: `cf-tests.js` — new `section('monthly ladder — current-month deltas only')`.

**Interfaces:**
- Produces: `_monthlyLadderHtml(): string` — ranks players by **sum of `sRating−startRating`** across archived sessions whose `date` is in the current calendar month (plus the active session if its date is this month), descending; shows gained and current rating; returns `''` with <2 qualifying players.
- Consumes: `S.archive`, `S.session`, `gp`.

- [ ] **Step 1: Write the failing tests**: set `S.archive` with two sessions — one dated **this month** where player A gained +40 (`startRating 1000 → sRating 1040`) and B +10, and one dated **last month** where A gained +100 — plus `S.db` entries for A/B. Assert `_monthlyLadderHtml()` contains A ranked above B, A's monthly gain shows **+40** (not +140 — last month excluded), and the "THIS MONTH" header. Assert it returns `''` when no session is in the current month.
- [ ] **Step 2: Run** `node cf-tests.js` — Expected: FAIL (`_monthlyLadderHtml` undefined; add it to `exportSnippet`).
- [ ] **Step 3: Implement** `_monthlyLadderHtml()`: current year/month from `new Date()`; `inMonth(date)` via `new Date(date)`; sum net deltas per non-NR player over in-month archived sessions (+ active session if in-month); rank desc by gained; render a `stbl` with a "📅 THIS MONTH — rating climbed (<Month Year>)" header, columns # / PLAYER / ▲ GAINED / RTG. Render it in `renderStandings`/the standings HTML right above or below `_seasonLadderHtml()`.
- [ ] **Step 4: Run** `node cf-tests.js` — Expected: PASS.
- [ ] **Step 5: Browser verification (user/Claude).** In the Standings tab, with archived sessions present, the "This Month" board shows players ranked by rating climbed this month, excludes prior-month sessions, and sits beside the Season Ladder. Then run `SIM.runLadder` and End the session: confirm the LL night now appears in History with real W/L/points and moves the all-time Season Ladder. Finally `SIM.runBugChecks()`.
- [ ] **Step 6: Commit** (and push to `main`, per the user's standing preference).
