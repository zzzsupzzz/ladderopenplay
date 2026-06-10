# Session Insights

Learnings, patterns, and pitfalls discovered during development. Read this at the start of each session.

## Bug Patterns Found

### 1. Leave-soon ghost re-queue (fixed)
**Pattern:** Cleanup code runs before re-queue code in the same function, but the re-queue loop doesn't check the cleanup results. The leave-soon block at the top of `_doSubmitScore` correctly sets `status='left'` and removes from `activePlayers`, but the re-queue loop below only checks `cfPaused` and `cfQueue` — both already cleared by cleanup. Always check the canonical state (`status`, `activePlayers` membership) rather than intermediate structures.

### 2. Replay-based stat recalculation + hard cap = data loss (fixed)
**Pattern:** `recalcAllTimeRatings` resets all stats to zero and replays from archive. If archive has a cap, dropped sessions = dropped stats. ELO survived because `startRating` captures cumulative state, but W/L/games are purely additive. Fix was removing the cap. If a cap is ever re-added, lifetime counters must be stored independently on the player object.

### 3. Two-section rendering gap (fixed)
**Pattern:** `renderLive` renders courts in two DOM sections — active courts and suggestions. A court in `'ready'` state with null suggestion appears in neither. Any rendering system that routes items to different containers based on state must handle every possible state combination, not just the expected ones. Always ask: "What renders this item if none of the conditions match?"

### 4. Remote sync wiping local-only state (fixed)
**Pattern:** `_applyRemote` rebuilds `checkedIn` from `activePlayers`, which doesn't exist pre-session. Pre-session check-ins live only in local `S.checkedIn`. Any sync handler that rebuilds local state from remote data must guard against the remote data being incomplete for the current lifecycle stage.

### 5. Debounced operations leaving stale data windows (fixed)
**Pattern:** `midRemove` deferred rank cleanup to a 200ms debounce. During that window, the removed player's rank entry still existed, skewing band calculations. For data used in real-time calculations, clean up immediately and let the debounce handle the full recalc.

## Code Investigation Methodology

### Agent-assisted bug hunting produces false positives
In this session, agents identified several "bugs" that were actually correct code:
- **MOV calculation "bug"**: agents claimed non-zero-sum ELO — actually correct (team2 delta = -team1 delta scaled by individual K)
- **ptsFor/ptsAgainst "not initialized"**: actually initialized to 0 at line 2338 (startSession) and line 2532 (midAdd)
- **recalcAllTimeRatings "double-counting"**: `S.session` is set to null BEFORE `recalcAllTimeRatings()` runs, so the active-session block never fires

**Lesson:** Always manually verify agent findings by tracing the exact execution path. Check what state mutations happen before the suspicious code runs, not just the code in isolation.

### Tracing execution order matters more than reading individual functions
The ghost re-queue bug and the stats-loss bug both involved code that looked correct in isolation. The bug only appears when you trace the full execution sequence within `_doSubmitScore` or `doEndSession` → `recalcAllTimeRatings`.

## Architecture Notes

### State mutation flow
All state changes go through: `mutate S` → `STORE.save()` → `SYNC.push()` → Firebase → other devices via `_applyRemote()`. The `_applyRemote` handler must handle every possible state shape, including partial/transitional states.

### Render cycle
Render functions (`renderLive`, `renderDB`, etc.) do full innerHTML replacement of their tab. No diffing, no incremental updates. This means any state that doesn't match a render condition simply vanishes from the UI.

### Queue priority system
`cfQueue` entries have a `since` timestamp. Wait time = `now - since`. Stagger offsets (idx * 4000ms) prevent ties. Pinned players get priority. The queue is the source of truth for "who plays next."

### Pair cooldown system
Pair history is tracked at queue re-entry time (`cfPairLastAt`), not at game-end. This is intentional — if recorded at game-end, `gamesSince` would be 0 immediately on re-entry, triggering the cooldown instantly.

### 6. Play count cap bypassed by mid-add outliers (fixed)
**Pattern:** The hard play count cap in `batchGenerateSuggestions` uses `minGames = Math.min(...eligibleCounts)`. When a mid-add player joins at round 6 with 0 games while others have 5+, they pull `minGames` to 0-1. Cap becomes `minGames + 2 = 2-3`, which excludes everyone. Fall-through makes the cap useless. Fix: exclude 0-game players from floor calc when session is past early rounds (`mc >= nc*2`). The `_joinedAtMatch` property tracks mid-add players for downstream systems.

### 7. Simulation hang from stale setTimeout callbacks (investigated, ~2% occurrence)
**Pattern:** In batch simulation runs (50+ consecutive), stale `setTimeout` callbacks from `_doSubmitScore` (100ms `_checkPendingPairs`, 500ms `cfMaybeAutoConfirm`) accumulate across runs. When they fire during a subsequent run, they can corrupt `S.session` state. Root cause confirmed but not fully fixed — clearing all timeouts between runs didn't resolve it, suggesting deeper state accumulation. Hang occurs at ~47th run consistently.

## Performance Optimization Patterns

### Memoization keyed on cfMatchCount
Hot-path functions called thousands of times per suggestion generation (`_compatibleQueuePartners`, `_totalRanked`) must be memoized. Key on `cfMatchCount` (or `cfMatchCount * 1000 + activePlayers.length`) since these values only change between matches, not within a single suggestion search. Cache invalidation happens in `_invalidateMatchmakingCaches()`.

### Avoid array allocations in inner loops
`_ranksCompatible` was called with `.map()` to build ID arrays for each of ~3000 combinations. Replacing with direct property access (`res.t1[0].id` instead of `res.t1.map(p=>p.id)`) provided significant speedup. Similarly, pre-stamp computed values (`.sr`, `.mg`, `.band`, `.pcg`) on pool objects before entering the combinatorial search.

### Inline hot functions
`MM.bestPair` was called per-group in `_scoreGroup` (~3000 calls per court). Replaced with inline sort-by-gap logic using pre-computed `.sr` values. Combined with memoization, this gave 75× speedup (32s → 0.42s for 5 rounds).

## Play Count Balance System

### Priority tiers in _scoreGroup
P1 (skill balance, 0-350) > P2 (play count fairness, -200 to +200) > P3 (avoid repeats, capped 200) > P4 (wait time, capped -120). P1 is hard-capped at 350 so it can't overwhelm the scoring range. P2 is bounded at ±200 so it's a strong second signal without overriding P1.

### Hard cap mechanism
In `batchGenerateSuggestions`: excludes players with `matchesPlayed > minGames + 2` from the queue. Falls back to `minGames + 3` if fewer than 4 players qualify. The floor calc (`minGames`) excludes 0-game players and mid-add players during catch-up.

### Verification nuances
`verifyPlayCountBalance` in simulate.js must exclude disrupted players (mid-add, resumed-from-pause) from the gap check. Mid-add players are excluded entirely (their gap is structurally unavoidable). Resumed players get a grace period of `nc * 4` matches. Without these exclusions, false-positive errors overwhelm real issues.

### Band relaxation for underplayed players
`_ranksCompatible` allows band spread of 2 (instead of 1) when `waitMatches >= nc * 3`. This prevents underplayed players from being stuck indefinitely when no same-band partners are available.

## Testing Strategy

### Browser simulation over unit tests
For this single-file vanilla JS app, a browser simulation script (`simulate.js`) is more effective than unit tests because:
- No module system to import/export functions
- All logic depends on the global `S` state object
- DOM interactions are tightly coupled to logic
- The bugs found were all about state mutation sequences, not individual function correctness

### Simulation capabilities
- `SIM.run()` — full event with mid-session operations and state verification
- `SIM.runBugChecks()` — targeted regression tests for all 5 discovered bugs
- Live sync mode: runs with real `STORE.save()` so Firebase pushes updates in real time
- Speed controls: instant / fast / normal / slow

## Matchmaking Requirements

### Rating system
- **Initial seeding** uses ELO/DUPR/self-rating via `cfRating()` to set starting rank positions in `_initSessionRanks()`
- **After first match**, matchmaking uses `_rankSr()` which converts session rank to a synthetic rating. Session ranks update via `_updateSessionRank()` based on wins/losses, point differential, and opponent rank context — NOT ELO
- ELO still updates during the session but only affects Standings display and end-of-session archive

### Wait-time priority
- `queuePriority()` uses `waitMin` (time since re-queued after last game) as primary factor
- `matchGap()` tracks how many session matches have run since the player last played (game-count based)
- Both contribute to pool ordering and scoring bonuses

### Play count balance (hard cap: 2 games max difference)
- Hard constraint in `batchGenerateSuggestions`: players at `minGames + 2` are excluded from the pool when enough alternatives exist
- Soft incentives via `hungerBoost()`, `pcgBonus`, `playCountBonus`, and `starvationBonus` push underplayed players to the front
- Simulator verifies no >2 gap via `verifyPlayCountBalance()`

### Suggestion deduplication
- When multiple courts have pending suggestions, players in one court's suggestion are excluded from other courts' pools
- Prevents same player appearing in previews for two courts simultaneously

## Firebase Sync Pitfalls

### Shallow update() replaces nested objects (fixed)
**Pattern:** `SYNC.ref.update({meta: {_by, _ts, _v}})` looks like a merge but Firebase `update()` is shallow — it merges top-level keys but replaces entire nested objects. If `meta` is written without `adminPin`, the stored PIN is wiped. Fix: use path-based keys (`'meta/_by'`, `'meta/_ts'`, `'meta/_v'`) so each field is merged individually. Only write `'meta/adminPin'` when explicitly changing it.

**Rule:** Never use `update({nested: {...}})` for objects that have fields managed by other code paths. Always use `update({'nested/field': value})` to avoid clobbering sibling fields.

### clearConfig() kills the Firebase connection
**Pattern:** `SYNC.resetSharedRoom()` originally called `this.clearConfig()` after `ref.set(null)`. `clearConfig` sets `this.ready=false` and `this.ref=null`, which breaks all subsequent renders and syncs. The factory reset should wipe data but keep the connection alive. Fix: removed `clearConfig()` from the reset flow; the app stays connected and can immediately set up new data.

## Admin Reset Features

### Two-tier reset system (Setup tab, bottom)
1. **New Day Reset** (`adminNewDayReset()`) — Soft reset for between tournaments
   - Clears: current session, check-ins, court timers
   - Keeps: player database, ratings, session history/archive, admin PIN
   - Single confirmation dialog
   - Use case: starting a fresh session the next day

2. **Factory Reset** (`adminResetAll()` → `SYNC.resetSharedRoom()`) — Full nuclear wipe
   - Clears: everything — players, sessions, archive, ratings, admin PIN
   - Writes `null` to Firebase, clears localStorage backup
   - Double confirmation dialog (two separate confirms required)
   - Use case: starting completely from scratch or testing

Both buttons are in a card at the bottom of the Setup tab. Both require admin unlock. Both are blocked in observer mode.

## Simulation Guide

### Loading the simulator
Add `?simulate` to the URL: `yourdomain.com/?simulate`
This loads `simulate.js` which injects the `SIM` object.

### Available commands (browser console)
- `SIM.run()` — Full event simulation: creates players, starts session, runs matches with score submissions, mid-session operations (add/remove/pause players), and state verification
- `SIM.runBugChecks()` — Targeted regression tests for all discovered bugs (run after every code change)

### Speed controls
The simulator supports multiple speeds: instant / fast / normal / slow

### Live sync mode
Runs with real `STORE.save()` so Firebase pushes updates in real time — useful for testing multi-device behavior

### After simulation
- The sim runs all matches but does **not** auto-end the session — click "End" button manually to see the session summary
- Check the **Standings tab** for matchmaking quality metrics (OPP Δ, P.GAP, P/G columns)
- Courts will show as "Ready" with pending suggestions after all matches complete — this is expected

### Simulation limitations
- Cannot be run by Claude directly — requires a browser with the full app loaded
- The user must run it and report results
- ~2% hang rate at ~47th consecutive batch run (stale setTimeout accumulation)

## Matchmaking Quality Metrics (Standings Tab)

### Columns added to standings table
| Column | What it shows | Good value |
|--------|--------------|------------|
| **OPP Δ** | Avg opponent rating minus player's rating | Near 0 (green ≤30, orange ≤80, red >80) |
| **P.GAP** | Worst partner rating gap experienced | Low (green ≤100, orange ≤200, red >200) |
| **P/G** | Unique partners / total games played | High partner count = good variety |

### How to evaluate matchmaking quality
- Scan the **OPP Δ** column: if most values are green (within ±30), skill matching is working
- Check **P.GAP** for red values: indicates a player got stuck with a very mismatched partner
- **P/G** shows partner variety — higher unique partner count relative to games means better rotation
- These metrics use current session ratings (sRating), not starting ratings, so they reflect in-session movement

## PowerShell 5.1 Hook Quirks (Windows)

- `Join-Path` only takes 2 args — nest calls for 3+ path segments
- `$()` inside double-quoted strings in try/catch can cause parse errors — compute variables before the try block
- `-Command` with inline PowerShell eats `$` signs — use `-File` with a `.ps1` file instead
- Relative paths in hooks may not resolve from the hook's working directory — use absolute paths
- Always add `-ExecutionPolicy Bypass` when running `.ps1` files from hooks

## Ladder Courts: Static Court-Band Anchoring Is Structurally Infeasible (Sim-Proven)

Attempted: Phase 3 "ladder courts" where court 1 permanently hosts the top rank band, court nc the bottom, via a wait-decaying score penalty (_tierPen) for off-band placement.

**Result across sim runs (19p/3c): court-band adherence stays at the ~33-37% random baseline regardless of penalty strength (55/110/150 per band-step), and strong anchors DEGRADE group cohesion (P3 spread blew up to 9.8 vs ~7 baseline) because the optimizer chases unavailable home-band players.**

Root cause: bench rotation. With ~7 benched of 19, a player rests ~1-2 court-openings and gets seated on whichever court opens when their turn comes. Courts open in near-round-robin, so each band drifts across courts in a cycle (observed: top band cycling court 1 -> 3 -> 2). A static anchor fights this drift every round and loses; only ~2 of a band's 6-7 players are rested when "their" court opens.

What works instead (current design):
- Same-level play = GROUP cohesion, driven by the rank-band spread penalty (rankBandPen) whose soft target now ramps continuously through Phase 2 (60/50%->40/35% of N) and by the phase skill caps. P3 spread lands at ~band width (6.9-7.4 for band size 6.3).
- _tierPen kept at tiebreak strength (40/band-step, wait-decayed): nudges placement when groups are otherwise equal, never overrides cohesion or fairness.
- Joint multi-court path maps formed groups to courts by avg rank when 2+ courts are ready simultaneously (free relabeling, no quality cost).
- UI must follow the players, not promise a court: _courtTierChip labels each live/suggested court by the band ACTUALLY playing on it (TOP/MID/RISING). A static "Court 1 = R1-6" label would lie ~2/3 of the time.

Investigation pattern that caught this: unit tests proved the scoring math correct (top group on court 1 scores 0), yet live sims showed BELOW-random adherence — when statics pass but dynamics fail, look for rotation/availability structure, not scoring bugs.
