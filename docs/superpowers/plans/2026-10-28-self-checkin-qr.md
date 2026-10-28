# Self Check-In via QR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let players check themselves in by scanning one shared QR, and give the organizer a live "who's not here yet" board.

**Architecture:** A new `?view=checkin` URL mode (same pattern as `?view=player`/`?view=observer`) renders a dedicated mobile check-in screen that writes only to `S.checkedIn` through the existing `SYNC.push()` path. A small set of pure-ish helpers (view detection, present/absent split, self check-in/out) are added so the logic layer is unit-testable headlessly; the roster/QR/board rendering is plain DOM in the existing style. The organizer's "absent first" board lives in the Setup tab and re-renders on the normal sync tick.

**Tech Stack:** Vanilla JS in single-file `index.html`, Firebase Realtime DB (compat v9.23.0), QRCode.js (already loaded). No build step. Headless tests via `node cf-tests.js`.

**Spec:** `docs/superpowers/specs/2026-10-28-self-checkin-qr-design.md`

## Global Constraints

- Single file `index.html`; vanilla JS; no framework, no build, no new dependency. (QRCode.js is already present.)
- Match existing conventions: `gp(id)`/`gsp(id)`, `esc()`, CSS vars (`--gr`,`--or`,`--cy`,`--mu`,`--tx`,`--bd`,`--s2`,`--ra`), render-whole-tab functions.
- All writes go through the existing `toggleCheckIn`/`SYNC.push()` → `_pushWithRetry` → local-backup path; never write Firebase directly.
- Feature is **format-agnostic** — operates on `S.db`/`S.checkedIn`, never on `S.session` format fields.
- `?view=checkin` is **write-capable but scoped to `S.checkedIn` only** — it must not expose roster edit, scoring, or admin actions. URL is hash-obfuscated to `#checkin` like the other views (UX nicety; PIN remains the real gate).
- `node cf-tests.js` must pass after every task. The user runs the browser `SIM.runBugChecks()` once at the end (Claude cannot run it).

## Review Focus

- **Firebase data not yet loaded** when the check-in page opens → must wait for the first remote snapshot before rendering the roster, never show a permanent empty/"ask organizer" screen while data is in flight (owned by Task 4; verified in browser).
- **Offline tap** → the write queues via the existing retry path and the UI shows a pending/confirmed state, never a silent success that isn't synced (owned by Task 4; verified in browser by going offline).
- **Empty roster** (right after a New Day Reset / factory reset) → page shows the search box and "ask the organizer" helper, not a blank screen (owned by Task 2 helper test + Task 4 render).
- **Already-checked-in player taps again** → idempotent, no duplicate, no error; green row stays green (owned by Task 2 `selfCheckIn` idempotency test).
- **Late arrival during an active session** → check-in still writes and appears on the organizer board while a session is live, not only in lobby (owned by Task 5 board + Task 6 end-to-end browser check).

---

### Task 1: `?view=checkin` mode detection + boot wiring

**Files:**
- Modify: `index.html` — add near `isPlayerModeUrl`/`initPlayerMode` (~line 10913–10987) and call site in `init()` (~line 10988).
- Test: `cf-tests.js` — add `isCheckinModeUrl` to `exportSnippet` (~line 71) and a new `section('checkin — view mode')`.

**Interfaces:**
- Produces: `isCheckinModeUrl(): boolean` (true when `location.search` has `view=checkin` or `location.hash === '#checkin'`); `CHECKIN_MODE: boolean` global; `initCheckinMode(): void`.
- Consumes: existing `switchTab`, the chrome-hiding id list used by `initPlayerMode`.

- [ ] **Step 1: Write the failing test** in `cf-tests.js`: a `checkin — view mode` section that sets `ctx.location.search='?view=checkin'` then `ctx.location.search=''; ctx.location.hash='#checkin'` and asserts `APP.isCheckinModeUrl()` is `true`, and `false` for `?view=player` / empty. (Add `isCheckinModeUrl` to `exportSnippet`.) **Note:** the sandbox `ctx` (cf-tests.js ~line 55-67) has no `URLSearchParams`; add `URLSearchParams` (a Node global) to `ctx` so the called function doesn't throw — or implement `isCheckinModeUrl` without it (plain `location.search.includes('view=checkin')`). Prefer adding it to `ctx`, since `isObserverModeUrl` already uses `URLSearchParams` and tests may call it later.
- [ ] **Step 2: Run** `node cf-tests.js` — Expected: FAIL (`isCheckinModeUrl` is null / assertion fails).
- [ ] **Step 3: Implement** `isCheckinModeUrl()` mirroring `isObserverModeUrl` (line 10916), and `initCheckinMode()` modeled on `initPlayerMode` (line 10954): set `CHECKIN_MODE`, `history.replaceState` to `#checkin`, hide the same chrome ids (`share-btn`,`observer-btn`,`lock-btn`,`adv-mode-btn`,`admin-mode-badge`,`hbadge`,`sync-badge`) and all tab buttons, then render the check-in screen (Task 4's `renderCheckin()` — until that exists, call a stub that sets a known container's text). Wire `initCheckinMode()` into `init()` beside `initPlayerMode()`.
- [ ] **Step 4: Run** `node cf-tests.js` — Expected: PASS, and the load line still lists exports.
- [ ] **Step 5: Commit** (`git add index.html cf-tests.js && git commit`).

---

### Task 2: Check-in logic helpers (present/absent split, self check-in/out)

**Files:**
- Modify: `index.html` — add helpers near `toggleCheckIn` (~line 2605).
- Test: `cf-tests.js` — extend the `checkin` section; add the new names to `exportSnippet`.

**Interfaces:**
- Produces:
  - `_absentPlayers(): Array<player>` — players in `S.db` whose `id` is **not** in `S.checkedIn`, sorted by name (case-insensitive).
  - `_presentPlayers(): Array<player>` — the complement, sorted by check-in order if available else name.
  - `selfCheckIn(id): string|null` — adds `id` to `S.checkedIn` (idempotent), persists via the same path `toggleCheckIn` uses (`SYNC.push()`/`STORE.save()`), returns the player's name (via `gp`) or null if unknown id.
  - `selfCheckOut(id): void` — removes `id` from `S.checkedIn` and persists (Undo).
- Consumes: `S.db`, `S.checkedIn` (a `Set`), `gp(id)`, the write path used by `toggleCheckIn`.

- [ ] **Step 1: Write the failing tests** in `cf-tests.js`: with `S.db=[{id:'a',name:'Bea'},{id:'b',name:'Al'}]` and `S.checkedIn=new Set()` — assert `_absentPlayers().map(p=>p.name)` equals `['Al','Bea']` (sorted); after `selfCheckIn('a')` assert `S.checkedIn.has('a')` and `_absentPlayers().map(p=>p.id)` equals `['b']`; assert `selfCheckIn('a')` again keeps `S.checkedIn.size===1` (idempotent) and returns `'Bea'`; assert `selfCheckIn('zzz')` returns `null`; after `selfCheckOut('a')` assert `!S.checkedIn.has('a')`; assert `_absentPlayers()` with empty `S.db` is `[]`.
- [ ] **Step 2: Run** `node cf-tests.js` — Expected: FAIL (helpers null).
- [ ] **Step 3: Implement** the four helpers. Reuse the exact persistence calls `toggleCheckIn` makes (read lines 2605–2630 first) so offline/retry/backup behavior is identical; guard `SYNC`/`STORE` with the same `typeof` checks the file uses so headless load stays clean.
- [ ] **Step 4: Run** `node cf-tests.js` — Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 3: Check-in screen markup + styles

**Files:**
- Modify: `index.html` — add a `#checkin-screen` container (hidden by default) in the body near the other view banners, and its CSS in the `<style>` block.

**Interfaces:**
- Produces: a DOM container `#checkin-screen` and CSS classes the render in Task 4 targets. No JS logic.
- Consumes: existing CSS vars and fonts.

- [ ] **Step 1: Implement** the static container + styles: a centered mobile column (max ~420px), "CHECK IN" header (Bebas Neue, `--gr`), a subtitle, a search input (`#checkin-search`), a list container (`#checkin-list`), a confirmation overlay container (`#checkin-confirm`, hidden), and the "Can't find your name?" helper line. Match the mockup in the spec. No behavior yet.
- [ ] **Step 2: Verify headless load** — Run `node cf-tests.js` — Expected: still PASS (markup/CSS don't break the sandbox).
- [ ] **Step 3: Commit.**

---

### Task 4: Check-in screen behavior (render, search, tap, confirm, undo)

**Files:**
- Modify: `index.html` — add `renderCheckin()`, `_checkinRowsHtml()`, search handler, and confirm/undo handlers; replace Task 1's stub call with `renderCheckin()`; ensure re-render on sync when `CHECKIN_MODE`.

**Interfaces:**
- Consumes: `_absentPlayers`, `_presentPlayers`, `selfCheckIn`, `selfCheckOut` (Task 2); `esc`, `gp`.
- Produces: `renderCheckin()` — builds the list (absent rows tappable, present rows shown green with "✓ Here", non-tappable to remove); `onCheckinTap(id)` — calls `selfCheckIn`, shows the confirmation overlay ("You're checked in, <name>") with **Undo** (→ `selfCheckOut` + back to list) and **Check in someone else** (→ hide overlay, clear search, back to list); search filters by name.

- [ ] **Step 1: Implement** `renderCheckin()` + handlers per the spec and its Builder-check resolutions (one phone can check in several people; green rows not tappable to un-check; empty roster shows search + helper, never blank). Gate rendering on first Firebase snapshot: if no data has arrived yet (reuse the same readiness signal `?view=player` relies on, see line 1153), show a brief "Loading…" instead of the empty roster. Hook a re-render into the sync-apply path (where `renderRoster()` is already called) guarded by `if(CHECKIN_MODE)`.
- [ ] **Step 2: Verify headless load** — Run `node cf-tests.js` — Expected: PASS.
- [ ] **Step 3: Browser verification (user).** Open `index.html?view=checkin`. Confirm, with expected results: roster lists absent players alphabetically + present players green; typing in search filters; tapping a name shows "You're checked in, <name>"; **Undo** returns them to absent; **Check in someone else** returns to the list and a second name can be tapped; with an empty roster the search + helper line show (no blank screen); toggle the browser offline, tap a name — the confirmation still shows and the check-in syncs once back online (not a silent failure).
- [ ] **Step 4: Commit.**

---

### Task 5: Organizer board (Layout B, "absent first") in Setup

**Files:**
- Modify: `index.html` — add a board render (e.g. `renderCheckinBoard()`) and mount it in the Setup roster area; call it from `renderRoster()`/the Setup render so it updates live.

**Interfaces:**
- Consumes: `_absentPlayers`, `_presentPlayers` (Task 2); `toggleCheckIn` (manual ＋Here); `esc`.
- Produces: `renderCheckinBoard()` — count line "`N` here · `M` not yet"; **Still waiting on** = absent rows each with a **＋ Here** button (`toggleCheckIn(id)`); **✓ Here (N)** collapsed to a comma-separated line with a **show all** toggle; a **⬛ Show QR** button (wired in Task 6).

- [ ] **Step 1: Implement** `renderCheckinBoard()` and mount it. Reuse `_absentPlayers`/`_presentPlayers` so counts and the board agree. Live updates come for free from the existing sync→`renderRoster()` tick; add the board call there. (Optional green-flash on transition is a nice-to-have, not required.)
- [ ] **Step 2: Verify headless load** — Run `node cf-tests.js` — Expected: PASS.
- [ ] **Step 3: Browser verification (user).** On Setup: board shows correct here/not-yet counts; ＋Here moves a name to Here; "show all" expands the here list; with a second device open to `?view=checkin`, tapping a name there moves them to Here on the organizer board within the normal sync delay (live); works both in lobby and after a session is started (latecomer).
- [ ] **Step 4: Commit.**

---

### Task 6: Check-in QR, end-to-end verification, regression

**Files:**
- Modify: `index.html` — add `openCheckinQrModal()` and wire the board's **Show QR** button; optionally add a check-in link/QR to `openShareModal` (line 4576).

**Interfaces:**
- Consumes: `QRCode`, the base-URL logic from `openShareModal` (line 4577).
- Produces: `openCheckinQrModal()` — a modal showing a large QR encoding `<base>?view=checkin` (reuse the line 4604 QR pattern), with the raw link and a copy button, sized to print.

- [ ] **Step 1: Implement** `openCheckinQrModal()` and wire **Show QR**; add the check-in link to the share modal if it fits the existing layout.
- [ ] **Step 2: Run** `node cf-tests.js` — Expected: PASS (full suite incl. Task 1–2 checkin assertions).
- [ ] **Step 3: Browser verification (user).** Scan the QR with a phone → lands on the check-in page; full round trip: phone checks in → organizer board updates live. Then the morning→afternoon flow: **End Session** on the first open play → check-ins clear → the same QR/page shows everyone absent again for the second session. Finally run `SIM.runBugChecks()` and confirm no regressions.
- [ ] **Step 4: Commit** (and push to `main`, per the user's standing preference).
