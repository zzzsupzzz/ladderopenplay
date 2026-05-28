# Matchmaking Scheduler — Redesign Spec

**Status:** Proposal for dev team
**Goal:** Guarantee a bounded max wait between games while keeping matches skill-balanced.
**Scope:** Replaces the current per-court greedy + "nuclear fallback" + "safety pass" logic in `CF.batchGenerateSuggestions` / `_generateSingleSuggestion`.

---

## 1. Problem statement

The current engine builds matches **court-by-court, skill-first**, then reactively rescues
players who have been skipped. There is no global accounting of who is overdue, so skill
outliers get repeatedly excluded by the balance scorer and rot on the bench (observed max
waits of 11–13 matches in a 20-player / 3-court session where the fair floor is ~3).

We are replacing this with a **two-tier scheduler**:

- **Tier 1 — Fairness (hard constraint):** decide *who must play* before deciding matchups.
- **Tier 2 — Quality (soft objective):** among arrangements that respect Tier 1, pick the
  most skill-balanced one.

A wait-cap breach must be **structurally impossible**, not patched after the fact.

---

## 2. Definitions

| Term | Meaning |
|------|---------|
| `N` | number of checked-in, available players |
| `nc` | number of active courts |
| `seatsPerCourt` | 4 |
| `B` | bench depth = `N − 4·nc` |
| **seat-event** | one court finishing a game and freeing 4 seats |
| **wait counter** | per-player count of seat-events since that player last started a game |
| **WAIT (display)** | max matches completed on *other* courts during any one bench period (existing UI metric — keep for display) |
| **cap** | hard upper bound on a player's wait counter |
| **fair floor** | `ceil(B / 4)` — the minimum achievable max-wait under perfect aging |
| **must-play set** | benched players whose wait counter has reached `cap − 1` (seating them now keeps them at/under `cap`) |

> **Important:** drive scheduling off the **wait counter** (clean, monotonic), not off the
> noisy display WAIT metric. The display metric stays for UX; the counter is the control signal.

---

## 3. Feasibility — set the cap correctly

The achievable wait bound is dictated by bench depth, **not** by the algorithm.

```
fair_floor = ceil( (N − 4·nc) / 4 )
cap        = max(nc + 1, fair_floor + 1)
```

- `nc + 1` is the **target** (4 for 3 courts, 5 for 4 courts).
- It is only feasible while the bench is shallow enough. Rough ceiling: `N ≤ 8·nc + 4`
  (28 players for 3 courts, 36 for 4). Staggered game lengths lower this in practice.
- When `fair_floor + 1 > nc + 1`, the room is too full to honor the target. The app MUST
  surface this (e.g. "Add a court to keep waits under N") rather than silently producing
  long waits.

| N | nc | B | fair_floor | cap (nc+1) | feasible? |
|---|----|----|-----------|-----------|-----------|
| 20 | 3 | 8 | 2 | 4 | ✅ comfortable |
| 20 | 4 | 4 | 1 | 5 | ✅ very comfortable |
| 24 | 3 | 12 | 3 | 4 | ⚠️ tight |
| 28 | 3 | 16 | 4 | 4 | ❌ at floor — breaches unavoidable |

**Expose `cap` as a single named config value.** It is the one fairness/quality dial:
`slack = cap − fair_floor` is the skill-optimization budget. Raise `cap` if skill quality
suffers; lower it for stricter fairness.

---

## 4. Data structures

### 4.1 Wait ledger (new)

Maintain a per-player record, updated on every seat-event:

```js
// keyed by player id
S.session.waitLedger = {
  [playerId]: {
    waitCounter: 0,      // seat-events since this player last STARTED a game
    lastPlayedEvent: 0,  // seat-event index when they last started
    gamesToday: 0,       // tiebreak for overall fairness
    benched: true        // currently on bench (not on a court)
  }
}
S.session.seatEventSeq = 0; // global monotonic seat-event counter
```

**Update rules:**

- On **session start / player check-in**: initialize `waitCounter = 0`, `benched = true`.
  For a **late joiner**, initialize `waitCounter = 0` (they have not been waiting) and
  `lastPlayedEvent = seatEventSeq` so they join the back of the queue, not the front.
- On **seat-event** (a court finishes, before assigning the freed seats):
  `seatEventSeq++`; for every player with `benched === true`, `waitCounter++`.
- On **assigning a player to a court** (they start a game):
  `waitCounter = 0`, `lastPlayedEvent = seatEventSeq`, `benched = false`.
- On **a player finishing a game** (returning to bench):
  `benched = true`, `gamesToday++`. Their `waitCounter` starts incrementing on the *next*
  seat-event (so a player seated immediately again records waitCounter 0).
- On **voluntary sit-out / break**: set a `paused` flag and **exclude from `waitCounter`
  increments and from the must-play set**. Resume clears it.

> This ledger must be derivable from `cfLog` on reconnect/replay, mirroring how
> `lastPlayedAtMatch` is rebuilt today in `rebuildCFDerivedState`.

### 4.2 Priority (derived, not stored)

```js
function priority(p) {
  // higher = more urgent to seat
  return p.waitCounter * 1000 + p.gamesToday * -1; // wait dominates; fewer games breaks ties
}
```

---

## 5. The scheduler

Triggered whenever **one or more** courts need filling. **Always solve all open seats
jointly** — never one court at a time (simultaneous finishes are where outliers get
double-skipped today).

```
function schedule(openCourts, benchPool):
    seats = openCourts.length * 4

    # --- TIER 1: fairness (hard) ---
    mustPlay = benchPool.filter(p => p.waitCounter >= cap - 1)
    sort mustPlay by priority desc

    if mustPlay.length > seats:
        # Infeasible: more overdue players than seats this event.
        # Seat the top `seats` by priority; the rest WILL breach next event.
        # Emit a feasibility warning (room too full for cap).
        seatTopAndWarn(mustPlay, seats)
        return

    # --- TIER 2: quality (soft), constrained ---
    # Build candidate pool = mustPlay + next-priority players, capped to a window.
    window = mustPlay ∪ topByPriority(benchPool \ mustPlay, seats + MARGIN)
    # MARGIN ~ seats (gives the optimizer room without blowing up search)

    best = optimizeArrangement(
        seats        = seats,
        mustInclude  = mustPlay,        # HARD: every one of these is seated
        candidates   = window,
        objective    = skillCost        # see §6
    )
    assignToCourts(best, openCourts)
```

### 5.1 `optimizeArrangement` (bounded enumeration — no solver needed)

Scale is tiny: choosing 4 from ~12–16 candidates is ~1,800 combos × 3 team splits.

```
function optimizeArrangement(seats, mustInclude, candidates, objective):
    courts = seats / 4
    bestAlloc = null; bestScore = +Inf

    # Enumerate ways to partition `candidates` into `courts` foursomes such that
    # every mustInclude player appears in exactly one foursome.
    # Use branch-and-bound: fill court 1, then 2, ... ; prune partial allocations
    # whose running score already exceeds bestScore.
    for each valid partition:
        if not all(mustInclude assigned): skip
        score = sum over foursomes of bestTeamSplitCost(foursome)   # see §6
        if score < bestScore: bestScore = score; bestAlloc = partition

    return bestAlloc
```

- For a single open court this collapses to: enumerate foursomes containing all must-plays
  on that court, score each, take the min.
- **Pruning keeps it fast.** Restricting `candidates` to the priority window (not the whole
  bench) bounds the combinatorics regardless of `N`.

---

## 6. Objective function (Tier 2, soft)

Minimize a weighted cost. **The cap is a hard constraint handled in Tier 1 — it is NOT a
term here.** All terms below are about match *quality*.

For a foursome, evaluate all 3 ways to split into 2v2 and take the best:

```
bestTeamSplitCost(foursome):
    min over the 3 splits {t1, t2} of:
        W_partner * (partnerGap(t1) + partnerGap(t2))   # |rating diff within each team|
      + W_team    * abs(sum(t1) - sum(t2))               # team-vs-team imbalance
      + W_variety * repeatPartnerPenalty(t1, t2)         # discourage repeat partners
```

Then the allocation-level objective adds an aging-quality nudge:

```
allocationScore = sum(bestTeamSplitCost over foursomes)
                + W_aging * sum over seated players of (cap - waitCounter)
                # rewards seating longer-waiters EARLY so the hard cap rarely binds
```

### Suggested starting weights (tune against real sessions)

| Weight | Purpose | Start |
|--------|---------|-------|
| `W_partner` | teammate skill closeness (P.GAP) | 1.0 |
| `W_team` | team-vs-team balance (OPP Δ) | 1.0 |
| `W_variety` | partner rotation (P/G) | 0.5 |
| `W_aging` | proactive aging — seat waiters early | 0.3 |
| `MARGIN` | extra candidates beyond must-plays | `= seats` |

> **Proactive aging is the key to quality.** Because `W_aging` makes the optimizer prefer
> seating longer-waiters *before* they become mandatory, the hard cap almost never binds,
> so you rarely get the "outlier forced into a terrible match at the buzzer" outcome.

### Outlier handling

When `mustPlay` contains a rating outlier, the optimizer is forced to include them. To give
them the least-bad partners, ensure the priority **window** pulls in the next-closest-rated
benched players (not just the next-overdue). Implement as a small re-rank: after selecting
the window by priority, if a must-play outlier exists, add the K nearest-rated benched
players to the candidate set even if below the priority cutoff.

---

## 7. Edge cases (must be specified before coding)

| Case | Rule |
|------|------|
| **Simultaneous court finishes** | Solve all freed seats in one `schedule()` call. |
| **Late joiner** | `waitCounter = 0`, `lastPlayedEvent = seatEventSeq` → joins back of queue. |
| **Pool not divisible by 4** | The lowest-priority `B mod 4`-ish players sit; sitting accrues `waitCounter` normally so they rise next event. |
| **Voluntary sit-out / break** | `paused = true`: excluded from `waitCounter` increments AND must-play set. |
| **More must-plays than seats** | Seat top `seats` by priority; emit feasibility warning; do not crash. |
| **`nc = 1`** | Same algorithm, `seats = 4`; this is the most common path — make sure it goes through the unified scheduler, not a separate branch. |
| **Reconnect / replay** | Rebuild `waitLedger` from `cfLog` deterministically. |

---

## 8. Acceptance tests (simulator)

The simulator already prints per-player gap sequences (e.g. `Frankie gaps: 1-3-1-[6]-1-[11]`).

1. **Hard bound:** across **every** run (not just average), every per-player **max gap ≤ cap**.
   No `[bracketed long-wait]` markers above `cap`. This is the primary gate.
2. **Feasibility honesty:** in over-full rooms (e.g. 28 players / 3 courts) the app emits the
   feasibility warning instead of silently breaching.
3. **Quality not regressed:** average OPP Δ, P.GAP, and P/G should be **no worse** than the
   current engine on feasible scenarios (20/3, 20/4, 24/3). Capture before/after.
4. **No starvation by skill:** seed a deliberate rating outlier; confirm their max gap ≤ cap.
5. **Gate is implemented** in `simulate.js` `run()` (the "WAIT CAP gate" block in the wait
   report) — every `SIM.run()` computes `cap = max(nc+1, ceil(B/4)+1)` and pushes any
   `maxGap > cap` to `_errs`, so the run reports `passed: false`. (It lives in `run()` rather
   than `runBugChecks()` because only the full session tracks per-player gaps;
   `runBugChecks()` runs instant micro-scenarios with no wait tracking.) Expect this gate to
   **FAIL on the current engine** — that is the target the rewrite must turn green.

---

## 9. Migration notes

- Keep the existing display WAIT metric and the OPP Δ / P.GAP / P/G columns unchanged.
- Remove (do not keep alongside) the `_starvTCrit` / `_hmwT_sg` / `_hwmTN` nuclear blocks,
  the "Phase 2 forced-other" additions, and the "hard WAIT bound safety pass". They are
  superseded by Tier 1 and would conflict.
- Land behind a flag or in the worktree first; validate with §8 before merging to `main`.

---

## 10. TL;DR

1. Decide **who must play first** (global must-play set), then optimize matchups around them.
2. Wait cap is a **hard constraint** in Tier 1; skill is a **soft objective** in Tier 2.
3. Cap is physically bounded by bench depth: `cap = max(nc+1, ceil(B/4)+1)`; warn when the
   room is too full to honor it.
4. **Proactive aging** (`W_aging`) keeps the cap from binding, preserving skill quality.
5. Bounded enumeration over a priority-windowed candidate pool — no heavy solver needed.
6. Gate on the simulator: **max per-player gap ≤ cap in every run.**
