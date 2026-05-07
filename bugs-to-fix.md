# Bugs To Fix

## Critical

### 1. ~~"Leave Soon" players get re-queued as ghosts~~ FIXED
**Location:** `_doSubmitScore` lines 6181–6199  
**Trigger:** Player flagged with "Leave Soon" finishes their match.  
**What happens:** The leave-soon block correctly removes the player from `cfQueue`, `cfPaused`, `cfPinnedIds`, `activePlayers` and sets `status='left'`. But the re-queue loop iterates all four match players — its only guards checked cfPaused and cfQueue, both already cleared. The player got pushed back into the queue.  
**Fix applied:** Added guard `if(sp?.status==='left'||!(S.session.activePlayers||[]).includes(id))return;` at the top of the re-queue loop.

### 2. ~~Archive cap (30) silently destroys lifetime W/L/games stats~~ FIXED
**Location:** `doEndSession` line 3985  
**Trigger:** 31st session is archived.  
**What happens:** `S.archive.pop()` dropped the oldest session. `recalcAllTimeRatings()` replays only surviving sessions, so stats from dropped sessions were permanently lost.  
**Fix applied:** Removed the archive cap entirely. Sessions accumulate without limit.

### 3. ~~Disappearing court component~~ FIXED
**Location:** `CF.renderLive` lines 6698–6709  
**Trigger:** Mid-tournament, after score submission / player swap / pause / reshuffle, an entire court card vanishes from the Live tab.  
**Root cause:** `renderLive` renders courts in TWO separate sections — active courts (`status==='playing'`) go into `cf-courts-wrap`, and suggestions go into `cf-suggestions-wrap`. A court that is `status==='ready'` with a **null suggestion** appeared in neither section.  
**Fix applied:** Added rendering for `'ready'` courts with no suggestion as a "Waiting for players..." card in the courts wrap.

## Moderate

### 4. ~~`_applyRemote` wipes pre-session check-ins~~ FIXED
**Location:** `_applyRemote` lines 964-967  
**Trigger:** Firebase update arrives before session is started (e.g. WiFi reconnect during check-in).  
**What happens:** `checkedIn` was cleared and rebuilt from `S.session.activePlayers`, which only exists after `startSession()`. Pre-session check-ins (Setup tab toggles) are local-only.  
**Fix applied:** Only clear and rebuild `checkedIn` from `activePlayers` when `activePlayers` has entries (i.e., session has been started).

### 5. ~~`midRemove` doesn't immediately clear `cfRanks` for removed player~~ FIXED
**Location:** `midRemove` lines 2564-2593  
**What happens:** Removed player kept their rank entry until debounced `_initSessionRanks` fires 200ms later. During that window, band percentile calculations included a phantom player.  
**Fix applied:** Added `delete S.session.cfRanks[id]` immediately on removal, before the debounced full recalc.

### 6. ~~Admin PIN wiped on every save~~ FIXED
**Location:** `SYNC.push()` meta object construction  
**Trigger:** Any `STORE.save()` call when `S.adminPin` is empty (before Firebase loads, or on a fresh device).  
**What happens:** `update({meta: {_by, _ts, _v}})` replaces the entire `meta` object in Firebase. When `S.adminPin` is empty, `adminPin` is omitted from meta, wiping it from Firebase for all devices.  
**Fix applied:** Switched to path-based Firebase keys (`'meta/_by'`, `'meta/_ts'`, `'meta/_v'`) so `update()` merges individual fields without touching `meta/adminPin`.

### 7. ~~Factory reset crashes app (clearConfig kills Firebase)~~ FIXED
**Location:** `SYNC.resetSharedRoom()`  
**Trigger:** Clicking Factory Reset button.  
**What happens:** `clearConfig()` set `this.ready=false` and `this.ref=null`, breaking all subsequent render calls and sync operations.  
**Fix applied:** Removed `clearConfig()` call from `resetSharedRoom()`. Connection stays alive after data wipe.
