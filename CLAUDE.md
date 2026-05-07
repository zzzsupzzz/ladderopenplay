# Pickleball Ladder — Open Play Manager

## First Steps

Read `insights.md` for session learnings, bug patterns, and investigation methodology. Read `bugs-to-fix.md` for known issue status. Run `SIM.runBugChecks()` in browser console after any code change to verify no regressions.

## Purpose

A single-page web application for organising pickleball open-play sessions. It handles player check-in, skill-based matchmaking, court assignments, ELO ratings, and session archiving — all in real time across multiple devices.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Vanilla HTML/CSS/JS — single `index.html` (~8 000 lines, no framework) |
| Database | Firebase Realtime Database (asia-southeast1), SDK v9.23.0 compat mode |
| Sync | Real-time multi-device sync via Firebase — not a single-device/localStorage app |
| External libs | QRCode.js (CDN), Google Fonts (Bebas Neue, DM Sans) |
| Build | None — serve the HTML file directly |
| Testing | Browser simulation script (`simulate.js`) — no unit test framework |

## Architecture

Everything lives in `index.html`: markup, styles, and all JS. There is no build step, no bundler, and no server-side code.

### Global state

A single mutable object `S` (line 621) holds all runtime state:

```
S.db          – master player array (persisted to Firebase)
S.checkedIn   – Set of player IDs checked in today
S.session     – current session object (or null)
S.archive     – array of past sessions (no cap — all sessions preserved)
S.adminPin    – hashed admin PIN
S.courts      – number of active courts (1–6)
```

### Key modules (all in-file)

| Module | Line | Role |
|--------|------|------|
| `SYNC` | 646 | Firebase connection, read/write, reconnect, conflict handling |
| `STORE` | 1139 | Firebase persistence + localStorage backup |
| `AUDIT` | 1164 | Forensic action logging |
| `ELO` | 1356 | Rating engine (K-factor, expected score, update) |
| `MM` | 1851 | Matchmaking — team balancing, partner compatibility |
| `CF` | 726 | Continuous Flow — queue management, court assignment, suggestions |
| `CT` | 640 | Per-court elapsed timers (local UI state) |

### Tabs / views

Setup · Live · Standings · History · My Stats

Plus two URL-activated modes: **Observer** (`?view=observer`) — read-only; **Player** (`?view=player`) — personal stats only.

## Data flow

1. `init()` (line 7961) boots the app, restores local backup, connects Firebase.
2. `SYNC.autoConnect()` opens a realtime listener; `_applyRemote()` merges incoming data into `S`.
3. Every write goes through `SYNC.push()` → `_pushWithRetry()` with exponential backoff.
4. `_backupToLocal()` mirrors every confirmed write to localStorage as a fallback.
5. All state is synced to Firebase in real time. Multiple devices see the same state via `_applyRemote()`.

## Conventions

- **No frameworks** — DOM manipulation is direct (`document.getElementById`, `innerHTML`).
- **Render functions** re-render entire tab contents (e.g. `renderDB()`, `renderLive()`, `renderRoster()`).
- Helper `gp(id)` gets a player from `S.db`; `gsp(id)` gets one from `S.session.players`.
- HTML escaping via `esc()`. Unique IDs via `uid()`.
- Admin-only actions are gated by `checkAdminAccess()` which prompts for PIN.
- The file uses `let`/`const` throughout; no modules or imports (aside from Firebase CDN).

## Project context

- Hobby project — security is not a concern.
- Repository: `https://github.com/zzzsupzzz/ladderopenplay` — hosted via GitHub Pages.
- Multi-device real-time sync via Firebase Realtime Database.
- Firebase config is hardcoded (line 1100–1107). Room ID is fixed to `'main'`.
- All players share a single room; there is no multi-tenancy.
- Offline resilience is critical — the app must degrade gracefully and auto-recover.

## Admin Reset

Two reset buttons at the bottom of the Setup tab (admin-gated):

1. **New Day Reset** — clears session + check-ins, keeps players/ratings/history. For starting a new tournament.
2. **Factory Reset** — wipes everything (players, sessions, archive, ratings, admin PIN) across all devices. Double confirmation required.

## Testing

### Loading the simulator
Add `?simulate` to the URL (e.g. `zzzsupzzz.github.io/ladderopenplay/?simulate`) to load the `SIM` object.

### Console commands
- `SIM.run()` — full event simulation with mid-session operations and state verification
- `SIM.runBugChecks()` — regression tests for all discovered bugs (run after every code change)

The simulator supports live sync mode and speed controls. After a sim run, the session stays live — click "End" to see the summary. Check the Standings tab for matchmaking quality metrics.

The simulator cannot be run by Claude directly — it requires a browser with the full app loaded. The user must run it and report results.

### Matchmaking quality columns (Standings tab)
- **OPP Δ** — avg opponent rating vs yours (green = well matched)
- **P.GAP** — worst partner rating gap (lower = better)
- **P/G** — unique partners / total games (higher variety = better rotation)

## Code index

See `code-index.md` for a function-level reference of every module and function with line numbers.

## Session insights

See `insights.md` for bug patterns, investigation methodology, and architectural notes from prior sessions.
