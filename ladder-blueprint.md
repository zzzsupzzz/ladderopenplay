# Pickleball Open-Play Ladder — Build Blueprint

**Audience:** developers implementing/extending the app.
**Status:** living spec. Sections 1–5 describe what EXISTS today; Section 6 is the backlog to build.
**Companion doc:** `matchmaking-spec.md` (scheduler internals — read it for the two-tier model).

---

## 1. Operating envelope (tune everything to this)

| Dimension | Value |
|-----------|-------|
| Players per session | **14–26** (design for the whole range, not one point) |
| Courts | **2, 3, or 4** — chosen by headcount at ≈ **6–7 players/court** |
| Bench depth (N − 4·courts) | **6–10** |
| Duration | **3 hours** (~40–60 matches total) |
| Crowd | **Mixed** (some competitive, some social) |
| Devices | **Organizer admins on their own device; players get a read-only player view** |
| Initial ratings | **DUPR or self-rating, entered by admin** at player creation |

**The app must self-scale across court counts.** Court count is a function of headcount; everything
downstream (wait cap, phase slack, bench math) derives from `courts` and `N` at runtime — never
hard-code "3". The three canonical configurations to design and test against:

| Config | Players (N) | Courts (nc) | On court (4·nc) | Bench (N−4·nc) | Wait cap (default = nc·2+1) |
|--------|-------------|-------------|-----------------|----------------|------------------------------|
| Small  | ~14 | **2** | 8  | ~6  | **5** |
| Mid    | ~20 | **3** | 12 | ~8  | **7** |
| Large  | ~26 | **4** | 16 | ~10 | **9** |

> The default cap `nc·2+1` is **constant in "rounds"** (~2–2.25 rounds of play) regardless of court
> count, so the *wall-clock* wait feels similar at 2, 3, or 4 courts even though the match-count number
> differs (5 vs 7 vs 9). More courts = matches complete faster, so a bigger number is the same wait.

**Priority order (the north star):** **bounded WAIT > tight SKILL > equal GAMES**, with a hard rule:
*skill may relax under wait pressure but must never go egregiously loose.* Equal-games is a soft
fairness floor, not a hard guarantee.

---

## 2. Design principles

1. **Rank-based, not points-based.** All matchmaking uses session *rank position* (`_rankSr` maps rank→a 700–1200 scale). Raw ELO points never gate matches. All player-facing skill indicators show **ranks**, not points.
2. **Two-tier scheduler.** Tier 1 (fairness) decides *who must play* via a hard wait cap; Tier 2 (quality) optimizes *the matchup* within that constraint. See `matchmaking-spec.md`.
3. **Ladder arc.** Matching **loosens early, tightens late** — driven by *games played* (rank confidence), not the clock. A player with few games is matched loosely (their rank is a guess); a calibrated player is matched tightly.
4. **Wait is a hard bound; skill is a graduated soft objective.** The wait cap is guaranteed by force-seating. Skill is expressed as an *uncapped graduated penalty* so the engine always takes the **tightest available** match, relaxing only when nothing tighter exists.
5. **Tight partners.** Teammates should be similar level (play *with* a peer), not strong+weak carry splits.
6. **No framework, single `index.html`, Firebase realtime sync, offline-resilient.** Keep it.

---

## 3. Current architecture (implemented)

All logic lives in `index.html`. Key pieces:

| Concern | Function / state | Notes |
|---------|------------------|-------|
| Match generation entry | `CF.batchGenerateSuggestions` (~6188) | called when ≥1 court is ready |
| **Tier-1 mandatory seating** | `CF._scheduleMandatory` | computes wait cap + must-play set, force-seats overdue/first-game/pinned, distributes across ready courts |
| Forced-group builder | `CF._bestGroupForcing` | best fill around forced players |
| Single-court builder | `CF._generateSingleSuggestion` | common path when nobody overdue |
| Multi-court joint search | inside `batchGenerateSuggestions` | branch-and-bound over partitions |
| General optimizer | `CF._findBestGroup` | 3-pass (tight → loose → unfiltered) |
| **Scoring** | `CF._scoreGroup` | team balance, partner gap, repeats, wait, play-count, NR, hot/cold, **phaseGapPen**, tight-partner split |
| Phase skill targets | `CF._phaseSkillCaps` | rank-based, tightens by phase (A/B/C) |
| Loose outer guard | `CF._looseGuardCap` | ~11 ranks, blocks only egregious carries |
| Wait counter | `CF.matchGap(id)` | submits since last game; late joiners accrue from join (`_joinedAtMatch`) |
| Ratings/ranks | `CF.cfRating`, `_rankSr`, `_sessionRank`, `_totalRanked` | rank from session performance |
| Wait cap config | `S.session.cfWaitCapMult` | default 2 → cap = nc·2+1; UI selector in live view |
| Reserve handling | `reservedIds` in `batchGenerateSuggestions` | overdue players (≥cap−1) are NOT held reserved on slow courts |
| Quality chips | `renderLive` (~8290+) | rank-based partner/team/quality chips |
| Player/observer views | `?view=player`, `?view=observer` | read-only modes |
| **Sim** | `simulate.js` | `SIM.run()` full sim; WAIT CAP gate + per-phase Skill-Quality report; `SIM.runBugChecks()` |

**What already works well:** wait is bounded (~7, configurable), team balance is excellent,
late-joiners handled, tight-partner split + graduated penalty landed. Validate each release with
`SIM.run()` ×3.

---

## 4. Configuration parameters (single source of truth)

Expose these as named constants/session settings. **Recommended** column spans the 14–26p / 2–4c
envelope. Everything rank-based scales with `N` automatically; everything wait-based scales with `nc`.

| Param | Location | Current | Recommended | Meaning |
|-------|----------|---------|-------------|---------|
| `cfWaitCapMult` | session | 2 | **2** → cap = nc·2+1 = **5 @2c / 7 @3c / 9 @4c** | wait/skill dial; 1 = short wait (nc+1) |
| Phase **partner** targets (ranks) | `_phaseSkillCaps` | A8 / B6 / C4 | **A7 / B5 / C3** | teammate rank gap target by phase |
| Phase **team** targets (ranks) | `_phaseSkillCaps` | A5 / B4 / C3 | **A5 / B3 / C2** | opponent-pair rank gap target |
| Small-field slack | `_phaseSkillCaps` | +1 rank @ ≤2 courts | keep | widen targets when the bench is thin |
| `phaseGapPen` weights | `_scoreGroup` | partner 1.2 / team 1.0 | keep | graduated skill penalty strength |
| Split weights | `_scoreGroup` split sort | team 0.5 / partner 1.0 | keep | tight-partner bias |
| `_looseGuardCap` | helper | `min(11, max(6, N·0.55))` ranks | keep | hard outer carry block (scales with N) |
| Phase boundaries (games) | `_playerPhase` | A<2, B<6, C≥6 | **A≤2, B 3–6, C≥7** | per-player phase by games played |
| Calibration games | NEW | — | **5** | games before a player is "calibrated" |
| ELO K (calibrating) | ELO engine | — | **~2× normal** | faster convergence for first 5 games |
| Court auto-suggest | NEW | manual | `clamp(round(N/6.5), 2, 4)` → 14→2, 20→3, 26→4 | suggest courts from headcount |

**Rank targets are absolute ranks (not % of field) on purpose:** a 3-rank partner gap is *easier* to
satisfy with 26 players (more peers within 3 ranks) than with 14, so Phase 3 naturally gets closer to
"true competitive" as the field grows. The small-field slack (+1 rank at ≤2 courts) covers the thin-bench
case so a 14p/2c session doesn't deadlock on tight targets.

> **Phase 3 = true competitive.** With the graduated *soft* penalty (not a hard gate), Phase C targets of
> 3 partner / 2 team ranks are safe to aim for — the engine pushes toward them and relaxes only when the
> bench can't supply it. Combined with buddy-seating (§6.1), this is the realistic path to "true competitive."

---

## 5. Validation (must pass before any matchmaking release)

Run `SIM.run()` ×3 at **each of the three canonical corners — 14p/2c, 20p/3c, 26p/4c** (the matchmaking
must hold at all court counts, not just 3). Check the console report:

1. **WAIT CAP gate:** `✅ PASS` — no player's max gap exceeds `cap` (5 / 7 / 9 respectively). (`err()` fails the suite.)
2. **Skill Quality by phase:** Partner gap and Team gap **decrease P1 → P2 → P3** (the ladder arc) at every corner.
3. **Play-count:** `verifyPlayCountBalance` within tolerance (see §6.2).
4. **No regressions:** `SIM.runBugChecks()` green.
5. **Quality bar (mixed crowd):** Phase-3 avg partner gap **≤ ~3 ranks**, Phase-1 **≤ ~7**. Worst-case single P.GAP should be rare and only on rank extremes / forced matches. (Larger fields should hit Phase-3 tightness more easily than the 14p/2c corner.)

The sim is the gate. The simulator can't be run by the agent — a human runs it in-browser and reports.

---

## 6. Backlog — what to build (priority order)

### 6.1 Buddy seating for rank extremes  ·  *priority: HIGH*
**Problem:** top/bottom-ranked players have no nearby peer when their neighbors are mid-game, so they get a far-rank partner (P.GAP spikes) — unavoidable with the current "fill from whoever's left" approach.

**Behavior:** when a court is being built around an extreme-ranked or forced player, *proactively pull that player's nearest-rank available peer onto the same court*, even if the peer isn't overdue. Only borrow a non-overdue peer if doing so doesn't push the peer toward a wait-cap breach.

**Spec:**
- In `_scheduleMandatory` / `_bestGroupForcing`, after a forced/anchor player `P` is placed, compute `nearestPeer = argmin |rank(q) − rank(P)|` over the available pool.
- If `|rank(nearestPeer) − rank(P)| ≤ Phase-A partner target` and `matchGap(nearestPeer) < cap−2`, include the peer as preferred fill.
- Never override an overdue player's seat to make room.

**Acceptance:** Phase-3 worst-case P.GAP for rank 1–3 and rank N−2…N players drops materially; no new WAIT breaches.

---

### 6.2 Play-count fairness floor  ·  *priority: HIGH*
**Problem:** "wait wins" lets games drift — some players finish a 3-hour night with 10 games, others 6. Players notice and resent it.

**Behavior:** soft floor — no eligible (non-late, non-paused) player should end more than **2 games** behind the session median. Late joiners are exempt (can't catch up).

**Spec:**
- The pool builder already protects waiting players from play-count exclusion. Add the inverse: a **catch-up boost** in `_scoreGroup` (`playFairness`) strong enough that a player ≥2 games behind the median is strongly preferred for fill — but still bounded so it never overrides the wait cap.
- Cap the boost so it can't create a wait breach for others (wait > games).

**Acceptance:** `verifyPlayCountBalance` tolerance can tighten to `max(2, nc−1)` and still pass across 3 runs; per-player games spread ≤ 2 for non-late players.

---

### 6.3 New-player calibration + DUPR/self-rating seeding  ·  *priority: HIGH*
**Problem:** new players are seeded by a guess; matching them tightly too early creates mismatches.

**Behavior:**
1. **Admin inputs DUPR or self-rating** when adding a player. Map to an initial `sRating`/`baseRating`.
2. For the first **5 games**, the player is **calibrating**: matched at **Phase-A (loose)** tolerance regardless of session phase, and rated with a **higher K-factor** so their rank converges fast.
3. After 5 games, they graduate to normal phase progression.

**Spec:**
- **DUPR → rating map** (linear, dev-calibratable): `rating = 1000 + (DUPR − 3.5) × 200` → DUPR 2.5≈800, 3.5≈1000, 4.5≈1200, 5.5≈1400. Clamp to [600, 1500].
- **Self-rating** (e.g. 2.0–5.0 scale) uses the same map.
- Add fields to the player record: `dupr` (number|null), `selfRating` (number|null), `ratingSource` ('dupr'|'self'|'seed'). Initial `baseRating` derives from whichever is provided.
- Calibration flag is derived: `matchesPlayed < 5`. Already partly handled by `_playerPhase` (A for <2 games) — extend the "treat as Phase A" window to `< calibrationGames (5)` for skill tolerance.
- ELO: in the rating engine, use `K_calibration ≈ 2× K_normal` while `matchesPlayed < 5`.
- UI: add DUPR / self-rating inputs to the add-player form (admin only).

**Acceptance:** a player seeded at the wrong level converges to a sensible rank within ~5 games; no early-session blowouts caused by miscalibrated newcomers.

---

### 6.4 Eliminate the last wait breach (cluster-aware force)  ·  *priority: MEDIUM*
**Problem:** rare residual breaches (e.g. wait 8 vs cap 7) when a cluster of hard-to-match players all hit the must-play threshold at once and one court can't seat them all.

**Behavior:** when the count of players at `matchGap ≥ cap−1` exceeds the seats available on ready courts, **start force-seating one event earlier** (lower the must-play trigger to `cap−2` for the overflow) so the cluster drains before anyone breaches.

**Acceptance:** WAIT CAP gate `✅ PASS` in all 3 runs at **all three corners (14p/2c, 20p/3c, 26p/4c)**.

---

### 6.5 Organizer presets  ·  *priority: MEDIUM*
**Behavior:** one control — **Competitive / Balanced / Social** — that sets the wait/skill/variety knobs together, instead of separate dials.

| Preset | `cfWaitCapMult` | Phase C target | Variety (repeat penalty) |
|--------|------------------|----------------|--------------------------|
| Competitive | 2 (wait ≤7) | 3 / 2 ranks (tight) | lower (repeats OK for level) |
| Balanced (default) | 2 | 4 / 3 | medium |
| Social | 1 (wait ≤4) | 6 / 4 (loose) | higher (variety) |

Store `S.session.cfPreset`; applying it sets the underlying params. Keep advanced per-knob overrides.

---

### 6.6 Player view mode — wait transparency & trust  ·  *priority: MEDIUM (players have a view)*
Players use the read-only **player view** (`?view=player`). Make waiting feel fair:

1. **"You're up next" / "1 game until you play"** — derive from the player's position in the must-play/priority ordering and pending suggestions.
2. **Estimated wait** — rough minutes from average game length × games-ahead.
3. **Why-this-match** (tap a suggestion): "Matched on rank · you waited 4 · fresh partners." Reuse the rank-based quality chips.
4. **Your stats arc** — show the player their matches getting tighter as they accumulate games (mirrors the sim's per-phase metric, per player).

**Acceptance:** a player can always answer "am I playing soon and why am I waiting?" from their own view.

---

### 6.7 Court auto-suggest from headcount  ·  *priority: LOW*
The number of courts is the main thing that changes between sessions, so make it effortless. When the
admin sets up / as players check in, suggest `courts = clamp(round(N / 6.5), 2, 4)`:

| Headcount N | Suggested courts |
|-------------|------------------|
| ≤ 16 | 2 |
| 17–22 | 3 |
| 23–26 | 4 |

Admin can always override (engine supports 1–6). Re-suggest if headcount crosses a boundary mid-session
(late arrivals / leavers). When the room is too full for the wait target (`fairFloor+1 > cap`, e.g. 26
players on only 3 courts), surface a hint to add a court. Changing court count mid-session must recompute
the wait cap and bench math live (no restart).

---

## 7. Data model additions

```js
// Player record (S.db[] and session.players[])
{
  // ... existing ...
  dupr: 3.5 | null,            // NEW: DUPR if known
  selfRating: 3.5 | null,      // NEW: self-assessed level
  ratingSource: 'dupr'|'self'|'seed', // NEW: provenance of baseRating
  // calibration is derived: matchesPlayed < CALIBRATION_GAMES (5)
}

// Session
S.session.cfWaitCapMult   // EXISTS: 2 default
S.session.cfPreset        // NEW: 'competitive'|'balanced'|'social'
```

No schema migration needed for old sessions — treat missing fields as null/defaults.

---

## 8. Edge cases (must hold)

- **Late join:** seed via DUPR/self-rating; `matchGap` accrues from `_joinedAtMatch`; calibration window applies; exempt from play-count floor.
- **Leave / leave-soon:** removed from pool and reservations; no ghost re-queue (regression-tested).
- **Pause / break:** excluded from wait counter and must-play set; resumes cleanly.
- **Perm pairs / pinned:** force-seated together; never split across teams; honored even when mandatory fires.
- **Pool not divisible by 4:** lowest-priority players sit; sitting accrues wait priority; rotate fairly.
- **Reconnect / offline:** state rebuilds from `cfLog`; localStorage backup; degrade gracefully.
- **Court count change mid-session:** cap and bench recompute from current `courts`.

---

## 9. Non-goals / constraints

- No build step, no framework, single `index.html`. Vanilla DOM.
- Firebase realtime DB (asia-southeast1), room id `'main'`, multi-device sync.
- Security is not a concern (hobby project).
- Bounded enumeration only — no heavy solver; keep generation fast (called hundreds of times per session).

---

## 10. Suggested implementation order

1. **6.3** calibration + DUPR/self seeding (foundational — affects all matching quality).
2. **6.1** buddy seating (closes the last skill gap for extremes).
3. **6.2** play-count floor (fairness players feel).
4. **6.4** cluster-aware force (makes wait cap truly hard).
5. **6.5** presets (ties the knobs together for a mixed crowd).
6. **6.6** player-view transparency (trust & feel).
7. **6.7** court auto-suggest (polish).

After each: `SIM.run()` ×3 + `SIM.runBugChecks()`, confirm WAIT gate passes and the per-phase arc trends down.
