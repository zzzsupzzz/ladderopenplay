# Ladder Live Roster Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Ladder Live correct, synced mid-session roster handling — swap a seated player with the pool, pause/resume, and reconcile late arrivals — all from the organizer screen.

**Architecture:** Add `paused`/`pausePending` to each `ll.players` entry and a `syncRoster()` reconcile at the top of `buildGame`, so the engine schedules off the *live* roster instead of a frozen snapshot. Keep all new engine logic as pure methods on the `LL` object (headless-testable); do DOM/score-reset/sync side-effects in thin global `ll*` click handlers.

**Tech Stack:** Single-file vanilla JS (`index.html`), Firebase Realtime DB sync via `STORE.save('session')`, headless tests in `cf-tests.js` (`node cf-tests.js`).

**Spec:** `docs/superpowers/specs/2026-10-29-ll-roster-changes-design.md`

## Global Constraints

- No framework/build step; direct DOM via `innerHTML`, `document.getElementById`. (spec: Constraints)
- All state under `S.session.ll`; every organizer mutation persists via `STORE.save('session')` and repaints. (spec: Constraints)
- Engine methods on `LL` stay pure and headless-testable; DOM side-effects live in separate handlers. (spec: Goals)
- Organizer-screen only — no player-phone controls. (spec: Non-goals)
- Late arrival seed rating = `sp.sRating ?? gp(id)?.rating ?? 1000`, `games:0`, banded by rating immediately. (spec: Late arrival + Defaults)
- Ladder Live (`format:'ll'`) only; do not touch or revive Continuous Flow. (spec: Non-goals)

## Review Focus

- **Too many paused to fill one court** (`eligible < 4`): `buildGame` returns null; the live view must show the "can't fill a court" state, not crash. → Task 1 test.
- **Swap target invalid** (inId paused, already seated, or unknown): `swap` must reject and leave state unchanged. → Task 2 test.
- **Entered scores on *other* courts** must survive a swap repaint — only the swapped court clears. → Task 3 handler + browser verify.
- **A player who left mid-session** (`status:'left'`) stays on the night ladder (frozen `games`) rather than vanishing or being rescheduled. → Task 1 test.
- **Resume after pause** re-enters next round banded by *current* rating, not the seed. → Task 1 test.

---

### Task 1: Pause/resume state + roster reconcile + buildGame eligibility

**Files:**
- Modify: `index.html` — `LL.init` (~11479), `LL._pickSitters` (~11508), `LL.buildGame` (~11542); add `LL.syncRoster`, `LL._isSeated`, `LL.pause`, `LL.resume`.
- Test: `cf-tests.js` — new section "Ladder Live — roster: pause / resume / reconcile".

**Interfaces:**
- Produces:
  - `LL.syncRoster(): void` — adds any `S.session.players` entry (status≠'left') missing from `ll.players` as a fresh pooled player (`games:0`, clean counters, `paused:false, pausePending:false`, rating `sp.sRating ?? gp(id)?.rating ?? 1000`); sets `paused:true` on any `ll.players` entry whose player is no longer active.
  - `LL._isSeated(id): boolean` — is `id` in any `ll.current.games[].t1/t2`.
  - `LL.pause(id): void` — if seated → `pausePending=true`; else → `paused=true`.
  - `LL.resume(id): void` — clears `paused` and `pausePending`.
  - `LL._pickSitters(W, pool?)` — `pool` optional array of eligible ids (defaults to all).
  - `ll.players[id]` gains `paused:boolean`, `pausePending:boolean`.

- [ ] **Step 1: Write the failing tests** in `cf-tests.js`

```javascript
section('Ladder Live — roster: pause / resume / reconcile');
try {
  makeSession(10, 2); S.session.players.forEach((sp,i)=>sp.sRating=1200-i*10); APP.LL.init(2);
  const P = S.session.ll.players; const ids = Object.keys(P);
  APP.LL.buildGame();
  const seated = () => S.session.ll.current.games.flatMap(g=>[...g.t1,...g.t2]);
  // pooled player paused → excluded immediately next build
  const pooled = ids.find(id => !seated().includes(id));
  APP.LL.pause(pooled);
  ok(P[pooled].paused === true, 'pause on a resting/pooled player is immediate');
  APP.LL.buildGame();
  ok(!seated().includes(pooled), 'paused pooled player is not scheduled');
  // seated player paused → pending, finishes this game, excluded the one after
  const onCourt = seated()[0];
  APP.LL.pause(onCourt);
  ok(P[onCourt].pausePending === true && P[onCourt].paused === false, 'pause on a seated player is pending (finishes current game)');
  APP.LL.buildGame();
  ok(P[onCourt].paused === true && !seated().includes(onCourt), 'pending pause activates next build');
  // resume → back in next build, banded by current rating
  APP.LL.resume(pooled);
  ok(P[pooled].paused === false, 'resume clears paused');
  // eligibility math: N counts only non-paused
  const elig = ids.filter(id => !P[id].paused).length;
  ok(elig === 8, `two paused of ten → eight eligible (got ${elig})`);
  // left player stays on ladder (frozen), not rescheduled
  const leaver = ids.find(id => id !== onCourt && id !== pooled);
  const lg = P[leaver].games;
  const sp = S.session.players.find(s => s.id === leaver); sp.status = 'left';
  APP.LL.syncRoster();
  ok(P[leaver].paused === true, 'a left player is paused by reconcile');
  ok(P[leaver].games === lg, 'left player keeps their games (stays on the ladder)');
  // late arrival reconcile: a newly checked-in player enters the pool games:0
  const nid = 'late1'; S.session.players.push({ id:nid, name:'Late', status:'active', sRating:1150 });
  APP.LL.syncRoster();
  ok(P[nid] && P[nid].games === 0 && Math.round(P[nid].rating) === 1150, 'late arrival reconciled into pool at games:0 seeded by sRating');
  // can't fill a court → buildGame returns null
  makeSession(6, 2); APP.LL.init(2); const P2 = S.session.ll.players; const i2 = Object.keys(P2);
  i2.slice(0,3).forEach(id => P2[id].paused = true); // 3 eligible < 4
  ok(APP.LL.buildGame() === null, 'buildGame returns null when fewer than 4 are eligible');
} catch (e) { fail++; console.error('  ❌ LL roster pause/resume test threw: ' + (e && e.message)); }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node cf-tests.js`
Expected: FAIL (`pause is not a function` / assertions fail).

- [ ] **Step 3: Implement the engine changes in `index.html`**

- `init`: add `paused:false, pausePending:false` to the per-player object literal.
- `_pickSitters(W, pool)`: build `cands` from `(pool||Object.keys(P)).map(id=>P[id])` instead of `Object.values(P)`.
- Add `syncRoster()`, `_isSeated(id)`, `pause(id)`, `resume(id)` per the Interfaces block (`syncRoster` mirrors `init`'s `status!=='left'` filter).
- `buildGame` top: call `this.syncRoster()`; promote pending (`forEach id: if pausePending → paused=true, pausePending=false`); compute `const eligible=this._ids().filter(id=>!ll.players[id].paused)`; use `eligible.length` for `N`; `_pickSitters(Math.max(0,W), eligible)`; `playing=eligible.filter(...)`. Change the final bookkeeping loop and `reallyResting` from `this._ids()` to `eligible`.

- [ ] **Step 4: Run to verify it passes**

Run: `node cf-tests.js`
Expected: PASS (all sections, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add index.html cf-tests.js
git commit -m "feat(ll): pause/resume + roster reconcile; schedule off the live roster"
```

---

### Task 2: Swap a seated player with the pool

**Files:**
- Modify: `index.html` — add `LL.swap`.
- Test: `cf-tests.js` — new section "Ladder Live — roster: swap".

**Interfaces:**
- Consumes: `LL._isSeated` (Task 1).
- Produces: `LL.swap(court, outId, inId): boolean` — replaces `outId` with `inId` in `ll.current.games[court]`; returns `false` (no change) if there is no current game, no such court, `inId` is unknown/paused/already seated, or `outId` isn't on that court. On success: swaps the team slot, reverts `outId`'s round credit (`games--`, `streak--`, `satLast=false`) and adds it to `ll.current.resting`, gives `inId` the credit (`games++`, `satLast=false`) and removes it from `resting`, and refreshes `lastPartner` for both teams on that court.

- [ ] **Step 1: Write the failing tests** in `cf-tests.js`

```javascript
section('Ladder Live — roster: swap');
try {
  makeSession(10, 2); S.session.players.forEach((sp,i)=>sp.sRating=1200-i*10); APP.LL.init(2);
  const P = S.session.ll.players; const ids = Object.keys(P);
  APP.LL.buildGame();
  const g = S.session.ll.current.games[0];
  const outId = g.t1[0];
  const inId = S.session.ll.current.resting[0];
  const inGames0 = P[inId].games, outGames0 = P[outId].games;
  ok(APP.LL.swap(g.court, outId, inId) === true, 'swap succeeds for a pooled replacement');
  const g2 = S.session.ll.current.games.find(x=>x.court===g.court);
  const lineup = [...g2.t1, ...g2.t2];
  ok(lineup.includes(inId) && !lineup.includes(outId), 'lineup now has the replacement, not the pulled player');
  ok(P[inId].games === inGames0 + 1 && P[outId].games === outGames0 - 1, 'games credit moves from pulled to replacement');
  ok(S.session.ll.current.resting.includes(outId) && !S.session.ll.current.resting.includes(inId), 'pulled player returns to the pool');
  // result follows the replacement, not the pulled player
  const inR0 = P[inId].rating, outR0 = P[outId].rating;
  const scores = {}; S.session.ll.current.games.forEach(x => scores[x.court] = g2.t1.includes(inId) ? [11,2] : [2,11]);
  APP.LL.recordGame(scores);
  ok(P[inId].rating !== inR0, 'recordGame moves the replacement rating');
  ok(P[outId].rating === outR0, 'pulled player rating untouched for the reset game');
  // invalid swaps rejected
  APP.LL.buildGame();
  const g3 = S.session.ll.current.games[0]; const seatedOther = S.session.ll.current.games[1].t1[0];
  ok(APP.LL.swap(g3.court, g3.t1[0], seatedOther) === false, 'cannot swap in a player already seated on another court');
  const restId = S.session.ll.current.resting[0]; P[restId].paused = true;
  ok(APP.LL.swap(g3.court, g3.t1[0], restId) === false, 'cannot swap in a paused player');
  ok(APP.LL.swap(g3.court, g3.t1[0], 'nope') === false, 'cannot swap in an unknown id');
} catch (e) { fail++; console.error('  ❌ LL swap test threw: ' + (e && e.message)); }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node cf-tests.js`
Expected: FAIL (`swap is not a function`).

- [ ] **Step 3: Implement `LL.swap(court, outId, inId)` in `index.html`** per the Interfaces block. Guard clauses first (return `false`); then slot replacement via `indexOf`; then the bookkeeping and `lastPartner` refresh described above. Score reset is a UI concern (Task 3), not part of this method.

- [ ] **Step 4: Run to verify it passes**

Run: `node cf-tests.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html cf-tests.js
git commit -m "feat(ll): swap a seated player with the resting pool (result follows the sub)"
```

---

### Task 3: Live-view controls + handlers + late-arrival sync

**Files:**
- Modify: `index.html` — `LL.renderLive` (court cards + resting list + add a Paused section), add global handlers `llPause(id)`, `llResume(id)`, `llOpenSwap(court, outId)`, `llDoSwap(court, outId, inId)`; in the check-in / `midAdd` path, when `S.session.format==='ll'` call `LL.syncRoster()` then `LL._paint()` + `STORE.save('session')`.
- Test: `cf-tests.js` — extend the "Ladder Live UI — live render output" section.

**Interfaces:**
- Consumes: `LL.pause/resume/swap/syncRoster/_isSeated` (Tasks 1–2), existing `openModal`/`closeModal`, `STORE.save`, `LL._paint`, `LL._syncToSession`.
- Produces: organizer-facing controls; no new engine API.

- [ ] **Step 1: Write the failing render assertions** in `cf-tests.js` (append to the existing UI section)

```javascript
// roster controls present on the live view
ok(/llPause\(/.test(html), 'each player has a pause control');
ok(/llOpenSwap\(/.test(html), 'each court exposes a swap control');
// Paused section appears once someone is paused
APP.LL.pause(S.session.ll.current.games[0].t1[0]); // pending (seated) — build to activate
APP.LL.buildGame();
const html2 = APP.LL.renderLive();
ok(/Paused/.test(html2) && /llResume\(/.test(html2), 'a Paused section with resume controls shows when someone is paused');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node cf-tests.js`
Expected: FAIL (`llPause(` not found in `html`).

- [ ] **Step 3: Implement the UI**

- In `renderLive`, render each seated player's name with a `⏸` button calling `llPause('<id>')`, and give each court card a `⇄` control calling `llOpenSwap(court, '<id>')` (or one per seat). Render resting players with a `⏸` too. Add a **Paused** card listing `ll.players` entries where `paused` (or `pausePending`), each with a `▶` `llResume('<id>')`.
- `llPause/llResume`: call the `LL` method, then `LL._syncToSession(); STORE.save('session'); LL._paint();`.
- `llOpenSwap(court, outId)`: `openModal` listing pool candidates (`ll.current.resting` filtered to not-paused), each calling `llDoSwap(court, outId, '<id>')`.
- `llDoSwap(court, outId, inId)`: **capture every court's current score inputs** (`ll-s1-{c}`/`ll-s2-{c}`), call `LL.swap(...)`, `STORE.save('session')`, `LL._paint()`, then **restore the captured scores for every court except `court`** (the swapped court stays blank), `closeModal()`.
- In the check-in path that adds a player to `activePlayers` (and `midAdd`), when `S.session.format==='ll'` and `S.session.ll` exists, call `LL.syncRoster(); LL._syncToSession(); STORE.save('session'); LL._paint();` so the late arrival appears in the pool immediately.

- [ ] **Step 4: Run to verify render assertions pass**

Run: `node cf-tests.js`
Expected: PASS.

- [ ] **Step 5: Browser verify (offline, save-stubbed)**

Serve `index.html?simulate`, `STORE.save=async()=>{}`, run a short `SIM.runLadder`, then exercise `llDoSwap` on one court with another court's score typed in, and confirm: swapped court clears, other court's score persists, Paused section renders on `llPause`+advance, no console errors. Screenshot for the user.

- [ ] **Step 6: Commit + push**

```bash
git add index.html cf-tests.js
git commit -m "feat(ll): organizer live-view controls for swap, pause/resume, late arrivals"
git push origin main
```

---

## Self-Review

1. **Spec coverage:** Swap → Task 2 + Task 3 UI. Pause/resume (seated=pending, pooled=immediate) → Task 1. Late arrival reconcile (games:0, banded by rating) → Task 1 + Task 3 sync hook. Keep-on-ladder for leavers → Task 1. Organizer-only, sync, pure engine → Global Constraints + Task 3 handlers. All covered.
2. **Step scan:** Engine bodies are left to the implementer from signatures + tests; the one non-obvious algorithm (swap bookkeeping) is specified in prose in the Interfaces block rather than transcribed. No "handle edge cases" lines.
3. **Type consistency:** `syncRoster`, `_isSeated`, `pause`, `resume`, `swap(court,outId,inId)`, `_pickSitters(W,pool)`, `paused`/`pausePending` used identically across tasks and handlers.
4. **Review Focus:** each of the five lines has an owning test (Task 1: eligible<4, leaver-on-ladder, resume; Task 2: invalid swap; Task 3 Step 5: other-court score survival).
5. **Proportion:** plan is close to the spec in length; code blocks are test assertions (the decisions), not implementation bodies.
