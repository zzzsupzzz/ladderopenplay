# Timed Ladder Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ladder Live run in fixed-time rounds — a synced countdown, all courts stop together, and unfinished games count but move the ladder less than finished ones.

**Architecture:** Two pure-logic changes to the `LL` engine plus a UI layer. (1) `recordGame` scales the margin multiplier by an "evidence" factor (`maxScore/targetScore`, clamped ≤1) so unfinished games are dampened while finished ones (winner = target) are unchanged. (2) A synced round clock: `buildGame` stamps `ll.roundStart`, each device derives the countdown from it via a pure `LL.roundRemaining(now)`. (3) The live view renders the countdown + a buzzer/round-over state and a lobby control for round minutes.

**Tech Stack:** Vanilla JS in single-file `index.html`, Firebase Realtime DB. No build. Headless tests via `node cf-tests.js`.

**Spec:** `docs/superpowers/specs/2026-10-28-ladder-live-timed-design.md`

## Global Constraints

- Single file `index.html`; vanilla JS; no framework/build/new dependency. Reuse `ELO.mov`/`ELO.exp` and the existing timer infra (`#htimer`, `.ct-timer`).
- The round clock's source of truth is a **synced** `ll.roundStart` timestamp (written with the session), never a local interval — all devices must agree.
- The evidence fix must leave **finished** games (winner = target) and the **opponent/partner** term (`act1 − e1`) exactly as they are today.
- `node cf-tests.js` must pass after every task; the existing LL tests (rest rotation, banding, climb, standings) must stay green. The user runs `SIM.runBugChecks()` + a manual timed round at the end.

## Review Focus

- **Finished game unchanged** — an `11–9` (or `11–0`) must produce the same rating delta as before the fix (evidence = 1) — owned by Task 1, tested.
- **Unfinished dampened** — an `8–6` must move less than an `11–6`, and a `2–0` far less than an `11–0` — owned by Task 1, tested.
- **Zero-score buzzer** — a `0–0` court moves no rating and banks no points (no NaN/throw) — owned by Task 1, tested.
- **Clock agreement across devices** — remaining time is derived from the synced `roundStart`, so two devices show the same countdown; a round that runs over clamps at 0, never negative — owned by Task 2, tested (pure `roundRemaining`) + browser.
- **New round resets the clock** — building the next round stamps a fresh `roundStart` so the countdown restarts — owned by Task 2, tested.

---

### Task 1: Evidence-dampened rating movement in `LL.recordGame`

**Files:**
- Modify: `index.html` — `LL.recordGame` (~line 11474).
- Test: `cf-tests.js` — extend the existing `Ladder Live` section (or a new `section('Ladder Live — timed: evidence-dampened movement')`).

**Interfaces:**
- Consumes: `S.session.targetScore` (fallback 11), `ELO.mov`, `ELO.exp`, `this.K`.
- Produces: unchanged `recordGame(scoresByCourt)` signature; rating delta now `round(K × mov(win,lose) × evidence × (act1 − e1))` where `evidence = clamp(max(s1,s2)/target, 0..1)`.

- [ ] **Step 1: Write the failing tests** in `cf-tests.js`: build a known LL game (two teams, record a result, read a player's rating delta). Assert: a **finished** `11–0` produces the **same** delta as the pre-fix formula for that matchup (compute expected from `K·mov(11,0)·(act−e)`); an **unfinished** `8–6` produces a **smaller** magnitude delta than the same teams at `11–6`; a `2–0` delta magnitude is roughly `2/11` of the `11–0` delta (within rounding); a `0–0` yields **delta 0** and no rating change and no throw. (Seed two different-rated teams so `act−e ≠ 0`.)
- [ ] **Step 2: Run** `node cf-tests.js` — Expected: FAIL (current `recordGame` has no evidence factor; `8–6` moves same-or-more than `11–6`).
- [ ] **Step 3: Implement** in `recordGame`: `const target=(S.session?.targetScore)||11;` then per court `const mx=Math.max(s1,s2); const evidence=Math.max(0,Math.min(1,mx/target)); const effMov=mov*evidence; const delta=Math.round(this.K*effMov*(act1-e1));`. Leave `act1`, `e1`, `pf/pa` accumulation as-is.
- [ ] **Step 4: Run** `node cf-tests.js` — Expected: PASS (new assertions + all existing LL tests).
- [ ] **Step 5: Commit.**

---

### Task 2: Synced round clock — duration, `roundStart`, `roundRemaining`

**Files:**
- Modify: `index.html` — `LL.init` (~line 11381, store `roundMin`), `LL.buildGame` (~line 11442, stamp `roundStart`), add `LL.roundRemaining(now)`; ensure `roundStart`/`roundMin`/`llRoundMin` ride along in the session write (they live under `S.session.ll`, already serialized with the session).
- Test: `cf-tests.js` — new `section('Ladder Live — timed: round clock')`.

**Interfaces:**
- Consumes: `S.session.llRoundMin` (fallback 10) at init; `Date.now()` passed in as `now` for testability.
- Produces:
  - `ll.roundMin` (minutes), `ll.roundStart` (ms timestamp, set each `buildGame`).
  - `LL.roundRemaining(now): number|null` — seconds left = `max(0, roundMin·60 − floor((now − roundStart)/1000))`; `null` if no `roundStart`.

- [ ] **Step 1: Write the failing tests**: after `LL.init(3)` (with `S.session.llRoundMin=10`) and `LL.buildGame()`, assert `ll.roundMin===10` and `ll.roundStart` is a number; `LL.roundRemaining(ll.roundStart)===600`; `LL.roundRemaining(ll.roundStart+60000)===540`; `LL.roundRemaining(ll.roundStart+999000)===0` (clamped, never negative); building the next round (`recordGame({})` then `buildGame()`) **resets the clock to full** — assert `LL.roundRemaining(ll.roundStart)===600` again against the new `roundStart` (robust to same-ms timestamps; don't compare the two timestamps directly). Also assert `roundRemaining` is `null` before any `roundStart`.
- [ ] **Step 2: Run** `node cf-tests.js` — Expected: FAIL (`roundRemaining` undefined; `roundStart`/`roundMin` not set).
- [ ] **Step 3: Implement**: in `init`, `S.session.ll.roundMin = (S.session.llRoundMin)||10;` in `buildGame`, set `ll.roundStart = Date.now();` (after `ll.gameNum++`); add `roundRemaining(now){const ll=this._ll(); if(!ll||!ll.roundStart)return null; const total=(ll.roundMin||10)*60; return Math.max(0, total-Math.floor((now-ll.roundStart)/1000));}`.
- [ ] **Step 4: Run** `node cf-tests.js` — Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 3: Timer UI — countdown, round-over state, round-minutes control

**Files:**
- Modify: `index.html` — `LL.renderLive`/`_paint` (~line 11503) for the countdown + round-over cue; a repaint interval (reuse/add an LL tick) driven by `roundRemaining`; the LL lobby/setup for a round-minutes input bound to `S.session.llRoundMin`; the submit handler (`submitAndAdvance`, ~line 11556) already records + builds (which now resets the clock).

**Interfaces:**
- Consumes: `LL.roundRemaining(Date.now())` (Task 2), the existing submit/advance handler.
- Produces: a visible mm:ss countdown in the LL live view; at 0, a "⏰ Round over — enter scores" state emphasising the inputs (no auto-submit); a lobby control to set round minutes before `beginPlay('ll')`.

- [ ] **Step 1: Implement** the countdown render (format `roundRemaining` as mm:ss; warn/blink under ~1 min using existing `.warn`/`.urg` styles), a lightweight interval that repaints the LL view (or just the timer node) each second while a round is live, the round-over cue at 0, and a round-minutes input in the LL lobby that sets `S.session.llRoundMin` (default 10) before start. The buzzer never auto-submits — the organiser uses the existing "Submit scores → next round" control, which resets the clock via `buildGame`.
- [ ] **Step 2: Verify headless load** — Run `node cf-tests.js` — Expected: PASS (UI doesn't break the sandbox; Tasks 1–2 assertions green).
- [ ] **Step 3: Browser verification (user/Claude, read-mostly).** Start a timed Ladder Live (set e.g. 1 min for a quick check): the countdown ticks down and shows the same value on a second (observer) view; at 0 it flips to the round-over cue without submitting; entering scores and hitting submit records the round and **restarts** the clock for the next round; an unfinished score entered at the buzzer is accepted. Then `SIM.runBugChecks()`.
- [ ] **Step 4: Commit** (and push to `main`, per the user's standing preference).
