# Ladder Live — Timed Rounds Design

**Date:** 2026-10-28
**App:** Pickleball Open Play Manager (`index.html`, single-file vanilla JS, Firebase Realtime DB)
**Changes:** the existing Ladder Live format (`format: 'll'`, the `LL` engine ~line 11372).

## Intent / why

Ladder Live becomes a **timed** format. Every round runs for a fixed number of minutes (default **10**). All courts play at once toward the target score; when the clock hits zero, **every court stops together** and the organiser inputs all the scores in one go — including games that didn't reach the target. Then the ladder re-sorts and the next round begins.

Today LL is synchronized but **untimed**: rounds advance only when the organiser manually hits "Submit scores." This adds the clock and settles how unfinished games count.

## The round model

- A round lasts **X minutes** (configurable; default 10).
- Each court plays **one game toward the target score** (the session's existing Score Target, default 11).
- **A game stops at the target.** If a court reaches 11 before the buzzer, that game is done at `11–x`; they wait out the clock (no second counting game that round). This caps blowouts and keeps standings pace-fair.
- When the **buzzer** sounds, all courts stop. The organiser inputs every court's current score:
  - **Finished** games: reached the target (`11–x`).
  - **Unfinished** games: whatever the score was (e.g. `8–6`).
  - **Ties** are possible on the buzzer (e.g. `6–6`).
- Scores recorded → ratings move → ladder re-sorts → next round built. (All existing LL behaviour.)

## What already works (no change)

- **Submit-all-at-once.** `LL.recordGame(scoresByCourt)` already records every court together.
- **Any score counts.** `recordGame` takes arbitrary `[s1,s2]`; an unfinished `8–6` already records and counts. Ties already map to a half-result (`act = 0.5`).
- **Opponent & partner strength.** The rating move is `delta = K × mov × (act1 − e1)` where `e1 = ELO.exp(avgRating(t1), avgRating(t2))`. Beating a stronger pairing moves you more; your partner's rating is in your team average. This is the "depends who you're matched with / your partner" behaviour, and it stays unchanged.
- **Banding, rest rotation, the climb, cumulative point-diff standings** — all per-round, unchanged.

## Core-mechanic changes

### 1. Round timer (the main addition)

- A per-round **countdown** of X minutes, visible during play (reuse the header/court timer infrastructure — `#htimer`, `.ct-timer`).
- Round duration is **configurable** in the lobby / Ladder Live setup (default 10 min), stored on the session (e.g. `S.session.llRoundMin`).
- At **zero**, the UI flips to a **"Round over — input scores"** state: the score inputs become the focus and a clear "buzzer" cue fires. The organiser can also end the round early (a "Scores in / next round" action) if every court is done before the clock.
- The timer is **display/flow only** — it does not auto-submit. The organiser always confirms the scores. (Keeps it safe across devices and lets a round run a little over while scores are entered.)

### 2. Rating movement — dampen unfinished games

The margin multiplier today is `mov(win,lose) = 0.5 + 0.5·((win−lose)/win)`, normalized by the **winner's** score. For **finished** games the winner is always the target (11), so this is already correct (`11–0 → 1.0`, `11–9 → 0.59`). The problem is **unfinished** games, where a low winner score inflates the multiplier (`2–0 → 1.0`, as dominant as `11–0`).

**Fix:** scale the margin multiplier by an **evidence factor** = how far the game got toward the target:

```
evidence   = clamp(maxScore / targetScore, 0..1)
effMov     = mov(win, lose) × evidence
delta      = round( K × effMov × (act1 − e1) )
```

- Finished (`maxScore = 11`): `evidence = 1` → **unchanged** (`11–3` still moves hard).
- Unfinished (`8–6`): `evidence = 8/11 ≈ 0.73` → dampened.
- Barely played (`2–0`): `evidence = 2/11 ≈ 0.18` → moves almost nothing.

This delivers "big *earned* leads climb faster" while a flukey short game barely counts — and it leaves finished games and the opponent/partner term exactly as they are. `targetScore` is the session's Score Target (fallback 11).

### 3. Standings — no extra change needed

Cumulative point-diff (`pf − pa`) stays. Because every game is capped at the target (stop-at-11), per-round point swings are bounded and a fast court can't out-accumulate a slow one — so the pace-fairness concern resolves itself without normalization.

## Non-goals

- **No auto-submit on the buzzer** — the organiser always confirms scores.
- **No second counting game** for courts that finish early — one game-to-target per round.
- **No change to Continuous Flow**, matchmaking outside LL, ratings persistence, or the archive.
- **No per-court independent timers** — one shared round clock (the format is synchronized).

## Anti-goals (would make this a failure even if it "works")

- A barely-played `2–0` moving the ladder as much as an `11–0` (the current bug) — must be fixed.
- The buzzer **silently discarding** or auto-guessing scores — the organiser must input and confirm every court.
- A finished `11–9` nail-biter moving **less** than it does today (the fix must not touch finished-game behaviour).
- The clock **blocking** score entry — a round may run over while scores are typed; the timer informs, never locks.

## Constraints

- Single file `index.html`; vanilla JS; no framework/build/new dependency. Reuse existing timer infra and `ELO.mov`/`ELO.exp`.
- `node cf-tests.js` must stay green. The existing LL engine tests (rest rotation, banding, climb, standings) must still pass; **add assertions** for the evidence-dampened movement (unfinished moves < finished; finished unchanged) and for any new round-timer state logic that's pure.
- Browser `SIM.runBugChecks()` + a manual timed round are the user's final checks.

## Builder-check resolutions (my calls — flagging so they can be checked)

- **The round clock is synced, not local.** Store a `roundStart` timestamp on the session, set each
  time a round is built (`buildGame`). Every device computes remaining = `llRoundMin·60 − (now −
  roundStart)` from that shared value, so organiser and observers see the same countdown; a local
  interval only repaints, it is never the source of truth.
- **`targetScore` source.** The evidence factor reads `S.session.targetScore` (set at session start,
  fallback 11). `recordGame` gets the target from the session.
- **`evidence` is clamped to ≤ 1.** If a score is entered above target (someone played past 11),
  rating movement stays bounded; point-diff just reflects the entered score (the stop-at-11 rule is a
  real-world instruction, not app-enforced).
- **A `0–0` buzzer game moves nothing** (`evidence = 0`) and banks no points — harmless no-op.

## Left to the builder

- Exact timer UI (where the countdown sits, the buzzer cue, the "next round" control) and the lobby control for round minutes.
- Where `targetScore` is read from for the evidence factor (session Score Target; fallback 11).
- Whether to show "finished / unfinished" tags on each court's score at round end.
- Copy/labels.
