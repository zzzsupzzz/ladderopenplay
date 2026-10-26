# Ladder Night — Timed Ladder Format Blueprint

> A new session format alongside Continuous Flow. Everyone plays on the same clock, gets
> mixed by live performance each game, and climbs (or slides) a ladder — with multi-step
> jumps when you over-perform. Seeded by DUPR, driven by tonight's results.

Status: **design locked** (2026-10-27). Not yet built. This doc is the spec.

---

## 1. The concept in one paragraph

Players check in with their **DUPR** (the starting seed). The session runs as a series of
**synchronized timed games** (~12–15 min each, buzzer — everyone starts and finishes together).
Before each game the algorithm ranks everyone by **live performance**, slices them into **courts
by level** (a ladder), and builds **balanced, varied matchups**. After each game, results move
every player's rating — a big win vaults you up **multiple courts at once**, a bad loss slides you
down to where you're competitive again. A **rest rotation** gives everyone ~2–3 games on, 1 off
(never two in a row). The night's winner is decided by **cumulative point differential**. Over
2 hours that's ~8–10 games each.

## 2. Why this format (and why it fits our engine)

- **Synchronized rounds kill the availability problem.** In Continuous Flow we proved court-tiers
  can't hold — when a court frees up only ~6 of the field is benched, so you can never assemble a
  clean band. In a timed format **everyone re-seeds at once**, so banding is *exact* and the
  multi-step jumps work cleanly. This is the format where the ladder idea actually sings.
- **Most of it is the matcher we already have** (rank → band → balanced teams → margin-aware
  rating). The genuinely new pieces are the **rest rotation** and the **synchronized round loop**.
- **Come-and-go friendly.** Every game boundary is a natural re-balance; the bench absorbs late
  arrivals / early leavers; thin fields just re-band into fewer courts.

## 3. Court sizing — the 5.5–6 rule (locked)

Doubles = 4 play per court. **Waiting at any moment = courts × (players-per-court − 4).**

The rest rule — *play 2–3 games, sit 1, never sit back-to-back, ≥2 games before a rest, rest after
3* — mathematically pins the ratio: if you play P games then sit 1, you rest 1 in (P+1) games,
which must equal the waiting share (ratio−4)/ratio.

- Play 2, sit 1 → rest ⅓ → **6.0 / court** (the max)
- Play 3, sit 1 → rest ¼ → **5.33 / court**

**Valid window: 5.33–6.0 players/court.** Below ~5.33 you'd play 4 before a rest (past "rest after
3"); at 6.5–7 you'd have to rest after 1 game or sit twice in a row (rule breaks). **6 is the hard
ceiling.**

| Courts | Headcount (5.33–6/court) | Waiting each game |
|---|---|---|
| 2 | 11–12 | 3–4 |
| 3 | 16–18 | 4–6 |
| 4 | 21–24 | 5–8 |

Low end of each range → "play 3, sit 1"; high end → "play 2, sit 1".

## 4. The game-creation algorithm

Runs before **every** synchronized game.

### Step 1 — Rest rotation (who sits) — THE NEW PIECE
Per player track: **streak** (games in a row since last sit), **sat-last?**, **rests-total**.
Pick **W = players − 4×courts** sitters:
- **Must sit:** streak = 3 (rest after 3).
- **May sit:** streak ≥ 2 AND did not sit last game.
- **Blocked:** sat last game (no back-to-back), or streak < 2 (play ≥2 first).

Fill W slots: forced sitters first → then from the eligible pool by highest streak, ties broken by
**fewest rests-total** (even spread). If forced > W (rare): sit the W most-overdue, let others play
a 4th (soft cap). Update streak / sat-last / rests after selection.

### Step 2 — Rank by performance (the ladder)
Live rating = **DUPR** in game 1, then updated after every game (Step 6). Sort the playing
(non-sitting) players by it.

### Step 3 — Assign courts by band
Slice the ranked players into courts of 4: Court 1 = top 4 available, Court 2 = next 4, … If a top
player is resting this game, the band shifts down one — self-correcting.

### Step 4 — Balanced, varied teams
Within each court's 4 (rated a ≥ b ≥ c ≥ d), default split **a+d vs b+c** (closest expected score).
Variety overrides:
- **Partner-repeat penalty:** recent partners carry a cost; pick the freshest balanced option
  (reuses the CF matcher's partner/opponent variety terms).
- **Split rotation:** if the same four recur across games, cycle the split (A+B, A+C, A+D) so you
  partner each of them in turn — a built-in mini round-robin. (Alternate splits are slightly less
  balanced; only used to break a repeat.)

### Step 5 — Play the timed game, enter scores.

### Step 6 — Update the ladder
Each player's rating moves on **win/loss × margin × opponent strength** (margin-aware — the same
engine as Continuous Flow). Big win vs a strong court → big jump → higher court next game. Also bank
each player's **point differential** for the night-total ranking. Loop to Step 1.

## 5. Partner / opponent variety — honest expectations

- **Partners:** strongly varied (repeat penalty + split rotation). Expect **~5–7 different
  partners** over ~8 games.
- **Opponents:** more repetition is *inherent* — your opponents are your band. Expect to face a
  given peer **2–4 times**, spread out, never back-to-back, in different configurations.
- **The truth:** you get a **fresh matchup every round**, but the **people** are your level-pool
  (~6–8). As the ladder converges you settle among your true peers — that's the ladder working, not
  a bug. "Play your level" + a finite field *means* peers recur. Variety logic guarantees you're
  never *stuck* with anyone; it can't (and shouldn't) guarantee you never meet a peer twice.
- **Lever:** jump aggressiveness + band width. More aggressive/wider → more fresh faces, looser
  ladder. Tighter → converges faster, more peer overlap, better level-matching. Default: **moderate
  overlap** (ladder is clearly sorting).

## 6. Scoring, movement, winner

- **Court movement:** emerges from the Step-6 re-rank — multi-step jumps are automatic and
  conservation is automatic (we re-sort & re-band, we don't hand-move people). Narrate the jump
  ("🚀 Court 3 → Court 1").
- **Night winner:** **cumulative point differential** (points won − conceded). Pace-fair across
  courts (a timed format means faster courts play more points; differential neutralizes that).
  Every game for the full 2 hours counts.
- **Secondary drama:** final court reached; biggest climber (courts jumped); hot hand; etc. (reuse
  existing awards).

## 7. Edge cases

- **Late arrival:** slot into the bottom band at the next game's re-seed; starts with their DUPR.
- **Early leave:** bench just re-counts W next game; if a court would thin below 4, re-band into
  fewer courts at the next boundary.
- **Odd headcount:** fine — waiting count flexes; rest rotation handles it.
- **Thin field mid-session:** close a court; the re-band folds its players into the rest.

## 8. Tunable knobs (set from the first real night)

1. **Game length** — fixed time/buzzer (keeps courts synced) vs race to 11. Default: **timed**.
2. **Re-seed cadence** — re-band every game (responsive) vs every 2 games (calmer). Default: **every game**.
3. **Jump aggressiveness** — how much one game moves your rating. Default: **generous** (real leaps).
4. **Rest rule** — 2–3 play / sit 1 (locked); ratio 5.33–6.0/court.
5. **Variety weight** — variety vs tightest level-match. Default: **moderate**.
6. **Night-winner metric** — point differential (default).

## 9. Phased build plan

- **Phase 1 — Engine:** the rest-rotation scheduler + the synchronized round loop (reuse
  rank/band/balanced-teams/margin-aware rating from CF). Headless-testable (cf-tests): rest rule
  invariants (play 2–3, sit 1, no back-to-back), band correctness, conservation, variety.
- **Phase 2 — Live UI:** round timer/buzzer, per-court matchups, "who's resting", enter scores,
  the climb/jump animation, live ladder.
- **Phase 3 — Standings & recap:** cumulative point-diff board, final court, awards, come-and-go
  handling polish.
- **Phase 4 — Format toggle:** choose "Continuous Flow" vs "Ladder Night" at session setup; DUPR
  entry field for seeding.

## 10. Open questions (decide before Phase 1)

- Game length in minutes (12? 15?) → sets rounds (~8–10).
- Exact rating-move size per game (the jump feel) — tune in sim.
- Does the night-winner board show live during play, or reveal at the end?
- Score entry: per-court self-report on a device, or organizer-entered?
