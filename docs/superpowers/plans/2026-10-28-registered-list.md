# Per-Event Registered List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the organiser mark who registered for an event (from Reclub) so the check-in QR page and board scope to just those people, with the full-roster behaviour kept when no one is registered.

**Architecture:** Add `S.registered` — a `Set` of player ids — as a first-class synced node, exactly mirroring the `S.checkedIn` pattern already in place (SYNC.push / _applyRemote / _backupToLocal / reset-clears). The *waiting* list (`_absentPlayers`) scopes to registered players when `S.registered` is non-empty; `_presentPlayers` stays unscoped so a checked-in person is never hidden. The QR page and board inherit the scope through those helpers; the Setup Player-Database rows gain a register toggle, and the board's waiting rows gain a Remove control.

**Tech Stack:** Vanilla JS in single-file `index.html`, Firebase Realtime DB (compat v9.23.0). No build. Headless tests via `node cf-tests.js`.

**Spec:** `docs/superpowers/specs/2026-10-28-registered-list-design.md`

## Global Constraints

- Single file `index.html`; vanilla JS; no framework/build/new dependency.
- `S.registered` syncs and backs up exactly like `S.checkedIn` (reuse that end-to-end pattern: SYNC.push segments `all`/`session`/`checkin`, `_applyRemote` read, `_backupToLocal` + both local restores, cleared *and saved* in every reset path).
- Match existing conventions and the shipped self-check-in code (`_absentPlayers`/`_presentPlayers`, `selfCheckIn`, `renderCheckin`, `renderCheckinBoard`, `esc`, CSS vars).
- `node cf-tests.js` must pass after every task; the user runs `SIM.runBugChecks()` at the end.

## Scoping refinement (deviation from the spec's builder-resolutions — noted here)

The spec said both `_absentPlayers` and `_presentPlayers` scope to registered, with a "here ⊆ registered" invariant enforced by auto-registering on check-in. This plan scopes **only `_absentPlayers`** (the waiting list) and leaves `_presentPlayers` = everyone currently checked in. This better serves the spec's anti-goal ("never hide a checked-in person") without the auto-register side effect: the board's "not yet" list is registered-minus-here, while "here" always shows everyone present. Net behaviour matches the spec's intent; the auto-register-on-check-in resolution is dropped as unnecessary.

## Review Focus

- **Organiser registers people *after* some are already checked in** → those already-here players must still show under "here" (because `_presentPlayers` is unscoped) — owned by Task 1, tested.
- **No one registered (`S.registered` empty)** → QR page and board show the whole database exactly as today — owned by Task 1, tested.
- **A registered player is removed (drop-out)** → they disappear from the waiting list and the QR page, and are also removed from `checkedIn` if somehow present — owned by Task 1, tested.
- **Reload / second device** → the registered list survives and matches across devices (synced node) — owned by Task 2, browser-verified.
- **End Session / New Day Reset** → `S.registered` clears *and the clear persists*, so the next event starts empty — owned by Task 2 (tested where the clear is pure) and browser-verified.

---

### Task 1: `S.registered` state, register/unregister helpers, and `_absentPlayers` scoping

**Files:**
- Modify: `index.html` — add `registered` to the `S` object (line ~685), add helpers near the self-check-in helpers (after `selfCheckOut`), change `_absentPlayers`.
- Test: `cf-tests.js` — add `registered`/helpers to `exportSnippet`; new `section('registered — scoping + register/unregister')`.

**Interfaces:**
- Produces:
  - `S.registered: Set<string>` — event's registered player ids.
  - `isRegistered(id): boolean`.
  - `_registerPlayer(id): void` — adds id to `S.registered`, persists (segment `checkin` — same node group as checkedIn, or a dedicated `registered` segment; must be written by `SYNC.push`, wired in Task 2).
  - `_unregisterPlayer(id): void` — removes id from `S.registered` **and** from `S.checkedIn`, persists.
  - `_absentPlayers(): Array<player>` — now: pool = `S.registered.size ? (S.db players whose id ∈ registered) : all S.db`, then **minus** those in `S.checkedIn`, sorted by name.
- Consumes: `S.db`, `S.checkedIn`, `gp`, the persistence path.
- Unchanged: `_presentPlayers()` stays "S.db players in checkedIn".

- [ ] **Step 1: Write the failing tests** in `cf-tests.js` (add `registered`, `isRegistered`, `_registerPlayer`, `_unregisterPlayer` to `exportSnippet`). With `S.db=[{id:'a',name:'Al'},{id:'b',name:'Bo'},{id:'c',name:'Cy'}]`, `S.checkedIn=new Set()`, `S.registered=new Set()`: assert `_absentPlayers().length===3` (empty registered → whole db). Then `_registerPlayer('a'); _registerPlayer('b')` and assert `_absentPlayers().map(p=>p.id)` equals `['a','b']` (scoped to registered, Cy excluded). Then `S.checkedIn.add('a')` and assert `_absentPlayers().map(p=>p.id)` equals `['b']` (here removed from waiting) while `_presentPlayers().map(p=>p.id)` equals `['a']`. Register-after-checkin: with `S.registered=new Set()`, `S.checkedIn=new Set(['c'])`, assert `_presentPlayers().map(p=>p.id)` equals `['c']` and stays `['c']` after `_registerPlayer('a')` (present never scoped). `_unregisterPlayer`: `S.checkedIn.add('a')`; `_unregisterPlayer('a')`; assert `!S.registered.has('a') && !S.checkedIn.has('a')`. `isRegistered` true/false.
- [ ] **Step 2: Run** `node cf-tests.js` — Expected: FAIL (`_registerPlayer`/`isRegistered` null; `_absentPlayers` not scoped).
- [ ] **Step 3: Implement** `S.registered=new Set()` on `S`; `isRegistered`, `_registerPlayer`, `_unregisterPlayer` (reuse `_persistCheckin`-style save; unregister deletes from both sets); update `_absentPlayers` to the scoped pool. Leave `_presentPlayers` as is.
- [ ] **Step 4: Run** `node cf-tests.js` — Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 2: Sync, local backup, and reset wiring for `S.registered`

**Files:**
- Modify: `index.html` — `SYNC.push` (add `registered` to the written node group, line ~900), `_applyRemote` (read `remote.registered`, beside the checkedIn block), `_backupToLocal` + both local-restore readers (serialize/read `registered`), and every reset path that clears `S.checkedIn` (`doEndSession`, `adminNewDayReset`, `resetSharedRoom`/factory local, `selectNone`, the `_applyRemote` no-session branch) to also clear `S.registered` and persist it.

**Interfaces:**
- Consumes: the `S.checkedIn` sync/backup/reset sites (each one gains a parallel `registered` line).
- Produces: `S.registered` round-trips through Firebase and local backup, and is empty after any reset.

- [ ] **Step 1: Implement** the parallel `registered` lines at each `checkedIn` site: push writes `updates.registered=[...S.registered]`; `_applyRemote` does `S.registered.clear(); (remote.registered||[]).forEach(id=>S.registered.add(id))` in both the session and no-session branches; `_backupToLocal` adds `registered:[...S.registered]` and the restores read `b.registered`/`d.registered`; each reset clears `S.registered` before/with its save (mirror the `checkedIn.clear()` ordering fixed for selectNone).
- [ ] **Step 2: Verify headless load** — Run `node cf-tests.js` — Expected: PASS (wiring doesn't break the sandbox; Task 1 assertions still green).
- [ ] **Step 3: Browser verification (user/Claude, read-mostly).** Register a few players, reload → registered list persists. With a second view open, a change on one reflects on the other. End Session → registered (and check-ins) clear; New Day Reset → same. (Writes go to the shared room, so do this against a test roster or accept the writes.)
- [ ] **Step 4: Commit.**

---

### Task 3: Setup UI — register toggle on the Player Database + registered count / Clear

**Files:**
- Modify: `index.html` — `renderDB()` (the `#db-list` rows) to add a per-row register control; the Player-Database card header (line ~508) for a registered count + "Clear registered".

**Interfaces:**
- Consumes: `isRegistered`, `_registerPlayer`, `_unregisterPlayer` (Task 1), `S.registered`.
- Produces: `toggleRegister(id)` (register/unregister + re-render), `clearRegistered()` (empties `S.registered`, persists, re-render); a visible registered count.

- [ ] **Step 1: Implement** a register toggle on each database row (e.g. a ☑/＋ "Register" control calling `toggleRegister(id)`, showing registered rows marked), a header `N registered` badge, and a `Clear registered` button (guarded like other destructive-ish actions). `toggleRegister` flips `isRegistered` via `_register/_unregisterPlayer` then `renderDB();renderRoster()`.
- [ ] **Step 2: Verify headless load** — Run `node cf-tests.js` — Expected: PASS.
- [ ] **Step 3: Browser verification.** On Setup: ticking a database player marks them registered and bumps the count; the Today's-Roster board's "not yet" list immediately scopes to registered; un-ticking / Clear registered reverts; with no one registered the board shows the whole database again.
- [ ] **Step 4: Commit.**

---

### Task 4: Scope the QR page + board, add the Remove control, end-to-end

**Files:**
- Modify: `index.html` — `renderCheckinBoard()` to add a Remove (✕) control on each waiting row; confirm `renderCheckin()` + `renderCheckinBoard()` scope correctly through `_absentPlayers` (they already call it, so scoping comes for free).

**Interfaces:**
- Consumes: `_absentPlayers` (scoped, Task 1), `_unregisterPlayer`, `boardCheckIn`.
- Produces: a `✕`/Remove control on each board waiting row calling `_unregisterPlayer(id)` then `renderRoster()`.

- [ ] **Step 1: Implement** the Remove control on each `renderCheckinBoard` waiting row (alongside ＋Here), calling `_unregisterPlayer(id)` + re-render. Verify `renderCheckin` (QR page) now lists only registered-not-here (tappable) + checked-in (green) when a registered list is active, and the whole database when not.
- [ ] **Step 2: Verify headless load** — Run `node cf-tests.js` — Expected: PASS (full suite incl. Task 1 registered assertions).
- [ ] **Step 3: Browser verification (user).** Register 3 of your database players → open `?view=checkin`: only those 3 (minus any already here) are listed; a non-registered name does not appear. Tap one → moves to here. On the board: "not yet" shows the registered no-shows, each with ＋Here and ✕ Remove; Remove drops a player off and they vanish from the QR page. Clear registered → QR page shows the whole database again. Then `SIM.runBugChecks()` for regressions.
- [ ] **Step 4: Commit** (and push to `main`, per the user's standing preference).
