# Ladder Live — Timed Ladder Format Blueprint

> A new session format alongside Continuous Flow. Everyone plays on the same clock, gets
> mixed by live performance each game, and climbs (or slides) a ladder — with multi-step
> jumps when you over-perform. Seeded by DUPR, driven by tonight's results.

**Name candidates:** **Ladder Live** (recommended — 2 words, texts clean, "Live" = the
differentiator) · Ladder Night Live · Ranked Night · Climb. Working title in this doc: *Ladder Live*.

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

## 3. Positioning vs Reclub — the moat and the bridge

Reclub (the registration app the club uses) already does **RSVP + check-in, round-robin generation,
sort-by-skill, court-by-skill, DUPR verification + score submission, and standings**. So we must be
clear why anyone runs *this* on top of Reclub:

- **Reclub's matching is STATIC** — it sorts once and runs a fixed round-robin schedule.
- **Ladder Live is DYNAMIC** — it re-seeds everyone *every game*; you climb or leap courts in real
  time; the rest rotation is built in. **That "live" re-laddering is the entire differentiator** —
  and the marketing line: *"Not a fixed round robin. A live ladder that re-seeds you every game."*

**The bridge (who does what):**
- **Reclub:** discovery, RSVP, payment, the official DUPR record (verify + submit scores).
- **Ladder Live (this app):** runs the live night — matchmaking, the climbing ladder, standings,
  recap.
- **Handoff:** the checked-in RSVP name list → into this app (manual add today; QR self-check-in
  below removes the manual step but still checks in *against* an imported roster).
- **Same names:** Reclub keeps accounts unique; this app tracks by unique internal ID with a **tag**
  field for display (e.g., "Eric VN" vs "Eric TH"). Just tag duplicates when they're both present.

## 4. Court sizing — the 5.5–6 rule (locked)

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

## 5. The game-creation algorithm

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

## 6. Partner / opponent variety — honest expectations

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
  overlap**.

## 7. Scoring, movement, winner

- **Court movement:** emerges from the Step-6 re-rank — multi-step jumps are automatic and
  conservation is automatic (we re-sort & re-band, we don't hand-move people). Narrate the jump
  ("🚀 Court 3 → Court 1").
- **Night winner:** **cumulative point differential** (points won − conceded). Pace-fair across
  courts. Every game for the full 2 hours counts.
- **Secondary drama:** final court reached; biggest climber (courts jumped); hot hand; etc. (reuse
  existing awards).

## 8. QR self-check-in + live arrival board

The single entry point for players, and a friction-killer for the organizer.

**Flow:** one QR (printed at the venue / on the flyer / in the Reclub listing) → player scans →
opens their page → **taps their name → "I'm here"** → checked in → lands on their **live ranking /
stats**. The organizer sees a **live arrival board** (who's here / who's still missing) and starts
on time without tapping anyone in.

**Three wins in one scan:**
1. **Self check-in** — no organizer tapping 18 people in.
2. **Live arrival board** — see who hasn't shown; chase stragglers.
3. **Onboarding + hook** — no re-explaining the app each week; the scan drops them into *their* rank
   ("you're #6, climb tonight"), which bootstraps the retention loop. Doubles as a marketing asset
   (post the QR → "scan to see the live ladder" → FOMO).

**Build (we're halfway there):**
- The app **already generates a QR to the player-view URL**, and the **player stats page already
  exists** (read-only today).
- *New:* make the player page **writable for check-in** (tap name → "I'm here" → writes
  `checkedIn` via Firebase sync).
- *New:* a **live arrival board** for the organizer (checked-in vs not-yet-here).
- *New (nice-to-have):* **walk-up self-add** (name + DUPR) so first-timers not on the roster can
  add themselves.

**Caveats:** players check in *against an imported roster*, so the Reclub RSVP name list is still
loaded once up front. No auth (anyone could check in as anyone) — a non-issue for a club. Same-names
disambiguated by tag.

## 9. Monthly / season recap

Build the ladder to **carry across sessions** (cumulative season standings). Then the recap writes
itself — month's champion, biggest climbers, attendance streaks, top movers — auto-generated, one
tap, shareable. This is the **retention engine** (come back weekly to defend/climb) *and* the recap
content, from one build. Don't build a standalone recap feature; build the season ladder and the
recap falls out of it.

## 10. Edge cases

- **Late arrival:** slot into the bottom band at the next game's re-seed; starts with their DUPR.
- **Early leave:** bench just re-counts W next game; if a court would thin below 4, re-band into
  fewer courts at the next boundary.
- **Odd headcount:** fine — waiting count flexes; rest rotation handles it.
- **Thin field mid-session:** close a court; the re-band folds its players into the rest.

## 11. Tunable knobs (set from the first real night)

1. **Game length** — fixed time/buzzer (keeps courts synced) vs race to 11. Default: **timed**.
2. **Re-seed cadence** — re-band every game (responsive) vs every 2 games (calmer). Default: **every game**.
3. **Jump aggressiveness** — how much one game moves your rating. Default: `LL.K = 64` (high vs a
   normal ELO 20–40, so a short night sorts fast). **Finding from Phase 1:** smooth ELO drift climbs
   ~⅓ court/game — you surge up over a *few* dominant games, but a single result won't vault you 2+
   courts. For true single-game *leaps*, use a **provisional high-early-K** (first ~3 games move you
   hard, then settle — like "find your level tonight") or a **margin-direct jump**. Decide the feel
   in sim (Phase 2).
4. **Rest rule** — 2–3 play / sit 1 (locked); ratio 5.33–6.0/court.
5. **Variety weight** — variety vs tightest level-match. Default: **moderate**.
6. **Night-winner metric** — point differential (default).

## 12. Phased build plan

- **Phase 1 — Engine:** ✅ **BUILT** — the `LL` module in index.html (rest-rotation scheduler +
  synchronized round loop: `init` / `buildGame` / `recordGame` / `standings`; reuses `ELO.exp`/`mov`
  for margin-aware rating). 126 cf-tests pass: no back-to-back sits, rest-after-3, ≥2-before-rest in
  steady state, even rest spread, banding by live rating, no double-booking, climb (bottom player
  winning big rises and moves up courts), standings by point differential. Partner-repeat avoidance
  in team selection. No UI yet.
- **Phase 2 — Live UI + QR check-in:** round timer/buzzer, per-court matchups, "who's resting",
  score entry, the climb/jump animation, the live ladder — **plus QR self-check-in + live arrival
  board** (§8).
- **Phase 3 — Standings, recap & season:** cumulative point-diff board, final court, awards,
  **season/monthly recap** (§9), come-and-go polish.
- **Phase 4 — Format toggle:** choose "Continuous Flow" vs "Ladder Live" at session setup; DUPR
  entry field for seeding; Reclub roster import.

## 13. Open questions (decide before Phase 1)

- Final name: Ladder Live vs Ladder Night Live vs Ranked Night vs Climb.
- Game length in minutes (12? 15?) → sets rounds (~8–10).
- Exact rating-move size per game (the jump feel) — tune in sim.
- Does the night-winner board show live during play, or reveal at the end?
- Score entry: per-court self-report on a device, or organizer-entered?
- Reclub roster import: manual add, CSV/paste, or QR self-check-in as the primary path.
