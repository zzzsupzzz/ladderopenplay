# Code Index — Pickleball Ladder (`index.html`)

All code lives in a single `index.html` file. Line numbers are approximate and may drift after edits.

---

## Global State & Constants

| Line | Symbol | Description |
|------|--------|-------------|
| 621 | `S` | Master state object: `db`, `checkedIn`, `session`, `archive`, `adminPin`, `courts`, `extendedMin`, timer fields, `editId` |
| 622 | `_pageFirstLoad` | Guards against reconnection forcing a tab switch on first load |
| 623 | `HAS_REMOTE_HYDRATED` | True after first `_applyRemote` — blocks writes until Firebase has loaded |
| 640 | `CT` | Per-court elapsed timers (local UI state, not persisted) |
| 642 | `DEVICE_ID` | Random 8-char ID to prevent echoing own Firebase writes back |
| 1236–1240 | Cache vars | `_sessionTogetherCache`, `_boostKCache`, `_staleCacheKey`, `_allMatchesCache` — memoized matchmaking data |
| 1482 | `BAND_COLORS` | CSS colour map for skill bands A/B/C/D |
| 1483 | `PENDING_PAIR_THRESHOLD` | Matches sat out (4) before pending-pair lock activates |
| 4324 | `ADMIN_UNLOCKED` | Whether the current device has passed admin PIN check |
| 4472 | `_LOCK_KEY` | localStorage key for device-level session lock |
| 7885–7886 | `PLAYER_MODE`, `OBSERVER_MODE` | URL-activated read-only view modes |

---

## SYNC Module (line 646)

Firebase Realtime Database connection, read/write, reconnection, and conflict handling.

| Line | Method | Description |
|------|--------|-------------|
| 652 | `clearConfig()` | Resets SYNC state (ref, roomId, listener) |
| 667 | `resetSharedRoom()` | Disconnects current room, clears local storage, reloads |
| 684 | `_loadScript(src)` | Dynamically injects a `<script>` tag and returns a promise |
| 698 | `connect(cfg, roomId)` | Loads Firebase SDK, initialises app and DB ref, attaches realtime listener via `onValue` |
| 771 | `push(segment, onComplete)` | Writes state to Firebase — segments: `'db'`, `'session'`, `'archive'`, `'all'` |
| 801 | `_applyRemote(data, isFirstLoad)` | Merges incoming Firebase snapshot into `S`, reconciles checkedIn set, re-renders active tab |
| 1060 | `_updateBadge(st)` | Updates the sync status badge in the header (connected/offline/error) |
| 1089 | `autoConnect()` | Entry point — hardcoded Firebase config, room `'main'`, calls `connect()` |

---

## STORE Module (line 1139)

| Line | Method | Description |
|------|--------|-------------|
| 1140 | `save(segment)` | Calls `SYNC.push(segment)` — thin wrapper that is the standard write entry point |

---

## AUDIT Module (line 1164)

Forensic action logging for admin accountability.

| Line | Method | Description |
|------|--------|-------------|
| 1166 | `log(action, detail, courtNum)` | Appends timestamped entry to `S.session.auditLog` |
| 1182 | `_ts(ts)` | Formats a timestamp for display |
| 1189 | `_icon(action)` | Returns emoji icon for each audit action type |
| 1207 | `open()` | Opens a modal showing the full audit trail |

---

## Utility Functions (lines 1159–1338)

| Line | Function | Description |
|------|----------|-------------|
| 1159 | `uid()` | Generates a short unique ID (timestamp + random) |
| 1160 | `gp(id)` | Gets player from `S.db` by ID |
| 1161 | `gsp(id)` | Gets session player from `S.session.players` by ID |
| 1309 | `plainName(p)` | Returns `"Name Tag"` string for a player |
| 1310 | `tagHtml(p)` | Returns HTML `<span>` for the player's tag, or empty string |
| 1311 | `fmtDate(d)` | Formats date as `"Wed, May 3"` |
| 1312 | `fmtTime(s)` | Formats seconds as `MM:SS` |
| 1313 | `toast(msg, type, dur)` | Shows a temporary notification. Types: `'ok'`, `'err'`, `'warn'` |
| 1321 | `showCfm(msg, yesLabel, yesCls, onYes)` | Shows a confirmation dialog with a callback |
| 1333 | `openModal(html)` | Opens the generic modal with given HTML content |
| 1334 | `closeModal()` | Closes the modal |
| 1337 | `esc(s)` | HTML-escapes a string |
| 1338 | `isActiveTab(t)` | Returns true if tab `t` is currently selected |
| 1338 | `getArchiveName(id, sessPlayers)` | Resolves a player name from session players or DB |

---

## Matchmaking Caches (lines 1244–1298)

| Line | Function | Description |
|------|----------|-------------|
| 1244 | `_getSessionMatches()` | Returns memoized list of all matches in current session (CF log or rounds) |
| 1254 | `_invalidateMatchmakingCaches()` | Clears all caches — call after any state mutation that affects matchmaking |
| 1262 | `_buildSessionTogetherCache()` | Pre-computes how many past sessions each pair of players have played together |
| 1275 | `_getSessionsTogether(a, b)` | Returns co-session count for a pair of player IDs |
| 1280 | `sessionsSinceLastPlayed(id)` | How many sessions since this player last appeared (999 if never) |
| 1288 | `isRinger(p)` | True if player has a "ringer" flag set |
| 1294 | `shouldBoostK(id)` | Whether this player's ELO K-factor should be boosted (experienced but underrated) |

---

## ELO Module (line 1356)

Rating calculation engine.

| Line | Method | Description |
|------|--------|-------------|
| 1357 | `K(id)` | Returns K-factor for a player (32 base, 48 for boosted, 40 for NR seeding) |
| 1369 | `exp(a, b)` | Expected score of rating `a` vs rating `b` |
| 1370 | `expTeam(t1ids, t2ids)` | Expected score for a team (average of pairwise expectations) |
| 1376 | `mov(sWin, sLose)` | Margin-of-victory multiplier (0.5–1.0 scale) |
| 1377 | `calcIds(t1ids, t2ids, s1, s2)` | Calculates ELO deltas for two teams given scores, using player IDs |
| 1388 | `calc(t1, t2, s1, s2)` | Same as `calcIds` but takes player objects directly |

### ELO Helpers

| Line | Function | Description |
|------|----------|-------------|
| 1413 | `effectiveRating(id, round)` | Context-aware rating blending all-time ELO with session performance |
| 4146 | `recalcSessionCFELO()` | Replays all CF matches to recalculate session ELO from scratch |
| 3221 | `recalcAllTimeRatings()` | Rebuilds every player's all-time rating from the full archive + current session |
| 4649 | `duprToElo(dupr)` | Converts DUPR rating (2.0–8.0) to the app's internal ELO scale |

---

## Session Ranking System (lines 1487–1845)

Maintains live skill rankings within a session for balanced matchmaking.

| Line | Function | Description |
|------|----------|-------------|
| 1487 | `_sessionRank(id)` | Returns a player's current session rank (1 = best) |
| 1501 | `_totalRanked()` | Count of ranked players in the session |
| 1513 | `_bandFromRank(rank)` | Maps rank percentile to band: A (top 25%) / B / C / D |
| 1524 | `playerBand(id)` | Returns skill band letter for a player |
| 1526 | `bandBadge(id)` | HTML badge with coloured band letter |
| 1532 | `_rankBadge(id)` | HTML badge showing `#rank band` |
| 1541 | `_rankThresholds(waitMatches)` | Returns partner/team-avg thresholds — relaxes as wait time increases |
| 1556 | `_ranksCompatible(t1ids, t2ids, waitMatches)` | Validates two teams are skill-compatible (within band + avg thresholds) |
| 1605 | `_initSessionRanks()` | Seeds initial ranks from all-time ELO when session begins |
| 1659 | `_insertLateArrival(id)` | Inserts a mid-session joiner at the correct rank position |
| 1698 | `_updateSessionRank(id, won, pd, opponentIds)` | Adjusts a player's rank after a match result |
| 1751 | `_compatibleQueuePartners(id)` | Returns queue players whose rank is compatible as a partner |
| 1767 | `_checkPendingPairs()` | Creates pending-pair locks for players who've sat out too long |
| 1794 | `_isPendingPairMember(id)` | Whether this player is in a pending pair |
| 1795 | `_getPendingPartner(id)` | Returns the other player in a pending pair |
| 1796 | `_clearPendingPair(id)` | Removes a pending pair containing this player |
| 1799 | `openRankOverride(id)` | Opens modal to manually set a player's rank |
| 1816 | `applyRankOverride(id)` | Applies the manual rank change |
| 1842 | `_rankToScore(id)` | Converts session rank to a synthetic score for matchmaking |

---

## MM Module — Matchmaking (line 1851)

Team balancing, partner selection, court assignment.

| Line | Method | Description |
|------|--------|-------------|
| 1852 | `pc(a, b)` | Partner count — times `a` and `b` partnered this session |
| 1857 | `oc(a, b)` | Opponent count — times `a` and `b` opposed this session |
| 1869 | `matchScore(t1, t2)` | Composite quality score for a potential match (rating gap, partner/opponent history, streaks) |
| 1931 | `bestPair(four)` | Given 4 players, finds optimal 2v2 split |
| 1952 | `courtQuality(t1ids, t2ids)` | Quick quality metric for a court matchup |
| 1960 | `middleOrder(n)` | Returns indices in middle-out order (e.g. for 6: 3,2,4,1,5,0) |
| 1968 | `assignCourts(matches)` | Distributes generated matches to physical courts |
| 1990 | `_pickSitOuts(subpool, excess)` | Selects players to sit out fairly based on consecutive-sit and total-sit stats |
| 2044 | `calcSitOuts(pool, courts)` | Determines how many players sit out given pool size and courts |
| 2051 | `updateStreaks(sitOutIds, allIds)` | Updates sit-out streak counters |
| 2057 | `generate(courts)` | Main round-robin matchmaking — generates a full round of matches |
| 2088 | `_groupForCourts(playing, nc)` | Groups players into court-sized groups for match generation |
| 2139 | `recHx(matches)` | Records partner/opponent history after matches are confirmed |

---

## Player Management (lines 2155–2240)

| Line | Function | Description |
|------|----------|-------------|
| 2155 | `addPlayer()` | Adds a new player from the form inputs. Handles NR (New Recruit) detection |
| 2187 | `deletePlayer(id)` | Removes a player from the database after confirmation |
| 2196 | `toggleEdit(id)` | Toggles inline edit mode for a player row |
| 2198 | `updateDuprPreviewEdit(id)` | Updates the DUPR→ELO preview while editing |
| 2206 | `savePlayerEdit(id)` | Saves edited name, tag, rating, DUPR for a player |
| 2241 | `toggleCheckIn(id)` | Toggles a player's check-in status for the session |
| 2268 | `selectAll()` | Checks in all players |
| 2286 | `selectNone()` | Unchecks all players |

---

## Session Lifecycle (lines 2297–3102)

| Line | Function | Description |
|------|----------|-------------|
| 2297 | `startSession()` | Creates a new session in lobby status, populates players from checked-in list |
| 2356 | `beginPlay()` | Transitions session from lobby to active, initialises CF mode, generates first suggestions |
| 2399 | `openRosterModal()` | Opens the roster management modal |
| 2401 | `renderRosterModal()` | Renders the mid-session roster modal content |
| 2441 | `openOvrModal(id)` | Opens the rating override modal for a player |
| 2455 | `saveOvr(id, clear)` | Saves or clears a rating override |
| 2464 | `openNeverPairModal(id)` | Opens the never-partner exclusion modal |
| 2483 | `saveNeverPair(id)` | Saves never-partner exclusions |
| 3085 | `discardLobby()` | Discards a lobby-status session without archiving |
| 3971 | `doEndSession()` | Ends active session — archives results, updates all-time ratings, resets state |

---

## Mid-Session Player Operations (lines 2500–2789)

| Line | Function | Description |
|------|----------|-------------|
| 2500 | `midAddWarm(id)` | Adds player mid-session and immediately generates a suggestion if a court is free |
| 2510 | `filterMidAdd(q)` | Filters the mid-add player list by search query |
| 2522 | `midAdd(id)` | Adds a player to the active session mid-game |
| 2564 | `midRemove(id)` | Removes a player from the active session |
| 2597 | `cfPinPlayer(id)` | Pins a player to the front of the CF queue (max 4) |
| 2611 | `cfUnpinPlayer(id)` | Removes a player's queue pin |
| 2622 | `cfLockPair(idA, idB)` | Locks two players as permanent partners for this session (max 3 pairs) |
| 2634 | `cfUnlockPair(idA, idB)` | Removes a partner lock |
| 2643 | `cfClearLockedPairs()` | Clears all partner locks |
| 2650 | `cfAddSoftPair(idA, idB)` | Sets a soft partner preference (max 3) |
| 2663 | `cfLeaveSoon(id)` | Marks a player as leaving soon — prioritises their next match |
| 2701 | `cfSchedulePauseAfter(id)` | Queues a player to auto-pause after their current game |
| 2709 | `cfCancelPauseAfter(id)` | Cancels a scheduled pause-after |
| 2717 | `cfPausePlayer(id)` | Moves a player from queue to paused list |
| 2746 | `cfResumePlayer(id)` | Moves a player from paused back to queue |
| 2761 | `midRejoin(id)` | Re-adds a previously removed player |

---

## CF Module — Continuous Flow Engine (line 4726)

The core matchmaking and court management system. Manages queue, generates balanced suggestions, handles scoring.

### CF State & Helpers

| Line | Method | Description |
|------|--------|-------------|
| 4730 | `pairKey(a, b)` | Canonical pair key (`"id1|id2"` sorted) |
| 4731 | `matchupKey(t1, t2)` | Canonical 4-player matchup key |
| 4747 | `isPairOnCooldown(a, b)` | Whether a pair partnered too recently (cooldown period) |
| 4764 | `isRoundPairOnCooldown(a, b)` | Whether a pair were opponents too recently |
| 4783 | `_rankSr(id)` | Session rank-based synthetic rating for matchmaking |
| 4804 | `cfRating(id)` | Blended rating used by CF — mixes ELO and session rank |

### CF Queue & Priority

| Line | Method | Description |
|------|--------|-------------|
| 4948 | `matchGap(id)` | How many matches a player has sat out consecutively |
| 4958 | `waitDebt(id)` | Alias for `matchGap` — used in priority calculations |
| 4963 | `hungerBoost(id)` | Priority boost for players who've waited longest |
| 4981 | `queuePriority(qEntry, courtAvg)` | Computes a player's overall queue priority score |
| 5015 | `initQueue()` | Initialises the CF queue from active players at session start |
| 5043 | `enqueue(ids)` | Adds player IDs to the back of the queue |
| 5051 | `dequeue(ids)` | Removes player IDs from the queue |

### CF Match Generation

| Line | Method | Description |
|------|--------|-------------|
| 5054 | `_scoreGroup(group, mustSplitPair)` | Scores a candidate 4-player group on quality, fairness, history, wait debt |
| 5322 | `batchGenerateSuggestions(readyCourts, finishedMatchByCourtNum)` | Generates suggestions for multiple courts at once, avoiding player conflicts |
| 5587 | `_groupQuality(best)` | Quick quality check on a generated group |
| 5595 | `_withinTeamGapOk(t1, t2, cap)` | Validates the rating gap within each team is acceptable |
| 5609 | `_playerPhase(id)` | Classifies a player's session phase (early/mid/late) based on games played |
| 5617 | `_sessionPhase(groupIds)` | Determines the session phase for a group of players |
| 5632 | `_phaseGapCap(groupIds)` | Returns the max rating gap allowed based on session phase |
| 5638 | `_phaseOverlapWindow(activePlCount)` | Returns overlap window based on active player count |
| 5645 | `_findBestGroup(candidates, mustSplit, nrIds, totalQueue, lastMatchupKey)` | Core search — finds the best 4-player group from candidates |
| 5691 | `_storeSuggestion(courtNum, best, finishedMatch)` | Stores a generated suggestion in session state |
| 5709 | `_generateSingleSuggestion(courtNum, pool, mustSplit, nrIds, finishedMatch)` | Generates a suggestion for one court |
| 5895 | `generateSuggestion(courtNum, finishedMatch)` | Public wrapper — generates a suggestion for a single court |

### CF Court Actions

| Line | Method | Description |
|------|--------|-------------|
| 5918 | `confirmSuggestion(courtNum)` | Confirms a suggestion — moves players onto court, starts timer |
| 6000 | `submitScore(courtNum)` | Opens score input for a court |
| 6051 | `_doSubmitScore(courtNum, s1, s2, noElo)` | Processes submitted score — updates ELO, ranks, queues returning players, generates next suggestion |
| 6247 | `openPartialReshuffle(courtNum)` | Opens a reshuffle modal keeping some players, replacing others |
| 6262 | `_reserveAndRefreshOtherCourts(courtNum, newIds)` | After a swap, regenerates suggestions for other courts that lost a player |
| 6283 | `confirmPartialReshuffle(courtNum)` | Applies a partial reshuffle |
| 6341 | `reshuffleSuggestion(courtNum)` | Generates a completely new suggestion for a court |
| 6406 | `cancelActiveMatch(courtNum)` | Cancels an in-progress match and returns players to queue |
| 6451 | `openActiveMatchSwap(courtNum)` | Opens a player swap modal for an active court |
| 6483 | `confirmActiveMatchSwap(courtNum)` | Applies a player swap on an active court |
| 6522 | `reshuffleQualityFirst(courtNum)` | Reshuffles prioritising match quality over wait time |
| 6560 | `openSwapPlayer(courtNum)` | Opens a swap-one-player modal for a suggested court |
| 6584 | `confirmSwap(courtNum)` | Applies a single-player swap on a suggestion |
| 6621 | `openManual(courtNum)` | Opens manual 4-player selection for a court |
| 6633 | `confirmManual(courtNum)` | Confirms a manually selected court |

### CF Rendering

| Line | Method | Description |
|------|--------|-------------|
| 6650 | `renderLive()` | Main CF live view — renders courts, suggestions, queue, health panel |
| 6708 | `confirmAll()` | Confirms all pending suggestions at once |
| 6774 | `_renderSug(courtNum, sug)` | Renders a single court suggestion card |
| 6927 | `_renderActiveCourt(courtNum, court)` | Renders an active court with players, timer, score buttons |
| 6973 | `_renderHealthPanel()` | Renders session health metrics (games played, avg wait, fairness) |
| 7042 | `_renderQueue()` | Renders the queue list with priority, wait time, form indicators |

---

## Timer & Auto-Confirm (lines 7165–7251)

| Line | Function | Description |
|------|----------|-------------|
| 7167 | `cancelAutoConfirm(courtNum)` | Cancels auto-confirm countdown for a court |
| 7175 | `startAutoConfirm(courtNum)` | Starts a 30s auto-confirm countdown (pauses when tab hidden) |
| 7195 | `startCFTick()` | Main 1-second background timer — updates court elapsed times, detects overdue scores |
| 7236 | `toggleCFAutoConfirm()` | Toggles auto-confirm on/off |
| 7248 | `cfMaybeAutoConfirm(courtNum)` | Starts auto-confirm if the feature is enabled |

---

## Offline Resilience (lines 7264–7515)

| Line | Function | Description |
|------|----------|-------------|
| 7264 | `_backupToLocal()` | Writes full state to localStorage on every confirmed Firebase write |
| 7279 | `_getLocalBackup()` | Retrieves and parses the local backup |
| 7285 | `_showRestoreButtonIfAvailable()` | Shows offline restore button during loading if a backup exists |
| 7296 | `_restoreFromLocal()` | Loads backup into `S`, re-renders everything, schedules reconnect |
| 7317 | `_startLoadingProgressTimer()` | Progressive loading messages — auto-falls back to cached data after 6s |
| 7353 | `_stopLoadingProgressTimer()` | Clears loading timer on successful connect |
| 7360 | `_autoRestoreFromLocal()` | Called on boot — validates and applies local backup (age <48h, same room) |
| 7460 | `_trackConnection(db)` | Monitors `.info/connected` — flushes pending writes on reconnect |
| 7489 | `_pushWithRetry(updates, attempt, onComplete)` | Firebase write with exponential backoff (max 2 retries, 4s delay) |
| 7518 | `_setSaveStatus(state)` | Updates save status indicator: saving/saved/offline/retrying/error |

---

## Score Editing (lines 4018–4225)

| Line | Function | Description |
|------|----------|-------------|
| 4018 | `openEditScoreCF(matchIdx)` | Opens score edit modal for a current-session CF match |
| 4038 | `_saveCFScore(matchIdx)` | Saves edited score, triggers full ELO recalc |
| 4065 | `rebuildCFDerivedState()` | Rebuilds partner/matchup history from CF log after an edit |
| 4139 | `isValidFinal(a, b, target)` | Validates a score is a legal final (e.g. 11-X or deuce 13-11) |
| 4172 | `openEditScoreArchiveCF(matchIdx, sessId)` | Opens score edit for an archived session match |
| 4191 | `_saveArchiveCFScore(matchIdx, sessId)` | Saves edited archive score, recalculates all-time ratings |

---

## Rendering Functions

| Line | Function | Description |
|------|----------|-------------|
| 2821 | `renderDB()` | Renders the player database list (Setup tab) with search, filter, inline edit |
| 2894 | `renderRoster()` | Renders today's check-in roster |
| 2938 | `renderLive()` | Entry point for Live tab — delegates to `_renderLiveInternal` |
| 2951 | `_renderLiveInternal()` | Renders lobby or active CF view |
| 2976 | `_renderLobby()` | Renders the lobby (check-in) view |
| 3102 | `renderSessStd()` | Renders session standings with ELO, wins/losses, band badges |
| 3344 | `renderArchive()` | Renders archived sessions list |
| 3298 | `flashLatestMatch()` | Flashes the most recent match in the history tab |
| 3320 | `_updateLastSavedBanner()` | Updates the "last saved" timestamp banner |
| 3333 | `_updateLiveSavedBadge()` | Updates the live tab's save-status badge |
| 7625 | `renderHistory()` | Renders match log for active CF session |
| 7693 | `renderStandings()` | Wrapper calling `renderSessStd()` |
| 7698 | `renderPlayerView()` | Renders individual player stats and match history |

---

## UI & Navigation (lines 4229–4292)

| Line | Function | Description |
|------|----------|-------------|
| 4229 | `updateHeader()` | Updates header with session name, timer, badges |
| 4248 | `switchTab(id)` | Switches to a tab and renders its content |
| 4273 | `_activeTabId()` | Returns the currently active tab ID |
| 4276 | `_renderTab(id)` | Renders a specific tab's content |
| 4283 | `_renderActiveTab()` | Re-renders the currently active tab |
| 4288 | `syncCourtPills(containerId, val)` | Highlights the selected court-count pill |
| 4289 | `initCourtPills(containerId, onSel)` | Sets up court-count pill click handlers |

---

## Admin & PIN System (lines 4324–4606)

| Line | Function | Description |
|------|----------|-------------|
| 4331 | `getAdminPin()` | Returns current admin PIN hash |
| 4335 | `_clearAdminPinRemote()` | Clears admin PIN from Firebase |
| 4425 | `_showAdminLockOverlay()` | Shows the admin lock screen |
| 4433 | `_hideAdminLockOverlay()` | Hides the admin lock screen |
| 4437 | `_doUnlock()` | Unlocks admin mode, updates UI |
| 4460 | `lockAdmin()` | Locks admin mode |
| 4473 | `_setDeviceLocked(locked)` | Sets device-level lock in localStorage |
| 4476 | `_isDeviceLocked()` | Checks if device is locked |
| 4485 | `checkAdminAccess()` | Main access gate — shows lock overlay if PIN is set and not unlocked |
| 4505 | `updatePinStatus()` | Updates PIN status display in Setup tab |
| 4526 | `openPinSetupModal()` | Opens PIN create/change modal |
| 4589 | `_resetPinAllDevices()` | Removes admin PIN from all devices |

---

## NR (New Recruit) System (lines 4617–4719)

| Line | Function | Description |
|------|----------|-------------|
| 4617 | `toggleNRInput(checked)` | Shows/hides NR level selector when adding a player |
| 4649 | `duprToElo(dupr)` | Maps DUPR rating (2.0–8.0) to internal ELO (700–1400) |
| 4664 | `updateDuprPreview()` | Updates the DUPR→ELO preview in the add-player form |
| 4675 | `calcNRLevelRatings()` | Calculates beginner/intermediate/advanced starting ratings from current DB |
| 4688 | `updateNRLevelLabels()` | Updates NR level labels in the UI |
| 4699 | `setNRLevel(level)` | Sets the selected NR level |
| 4708 | `checkNRPromotion(id)` | Checks if an NR should be promoted (after 5 games) or start seeding (after 3) |

---

## Import / Export (lines 3762–3963)

| Line | Function | Description |
|------|----------|-------------|
| 3762 | `openImportModal()` | Opens the import data modal |
| 3786 | `previewImport(input)` | Parses JSON input and shows preview |
| 3811 | `runImport()` | Replaces all data with imported JSON |
| 3828 | `previewCsvImport(input)` | Parses CSV player list and shows preview |
| 3856 | `runCsvImport()` | Adds CSV players to database |
| 3872 | `openExportModal()` | Opens the export modal |
| 3884 | `runExport(fmt)` | Exports data as JSON or CSV |
| 3907 | `buildSessionReport()` | Generates a human-readable session summary |
| 3941 | `showExportText(content)` | Displays exported text in a modal for copying |
| 3949 | `doCopyEl(id)` | Copies an element's text content to clipboard |

---

## Modals & Misc UI (lines 3452–3676)

| Line | Function | Description |
|------|----------|-------------|
| 3452 | `changeCourtsMidSession()` | Opens mid-session court count change modal |
| 3484 | `_applySessionCourts()` | Applies new court count — handles merging active courts |
| 3534 | `_swapSelectOut/In(courtNum, id, btn)` | Suggestion swap dropdowns |
| 3546 | `_sugPickerToggle(evt, courtNum, outId)` | Opens inline player picker for suggestion swaps |
| 3581 | `_sugPickerApply(courtNum, outId, inId)` | Applies a suggestion swap |
| 3621 | `openWipeConfirmModal()` | Opens the data wipe confirmation modal |
| 3636 | `openSyncModal()` | Opens Firebase sync status modal |
| 3676 | `openShareModal()` | Opens share links modal with QR codes |
| 3713 | `copyUrl(inputId, btn)` | Copies a URL to clipboard |
| 3723 | `copyObserverLink(btn)` | Copies the observer-mode URL |
| 7539 | `openLockPairModal()` | Opens partner lock management modal |
| 7581 | `openQueueRulesModal()` | Opens info modal explaining queue fairness rules |
| 7662 | `deleteMatchFromHistory(idx)` | Deletes a match and recalculates all subsequent ratings |

---

## Timer Functions

| Line | Function | Description |
|------|----------|-------------|
| 2789 | `startTimer()` | Starts the session countdown timer |
| 2801 | `stopTimer()` | Stops and resets the timer |
| 3738 | `startElapsed()` | Starts the elapsed-time display |
| 3749 | `stopElapsed()` | Stops elapsed-time tracking |
| 3755 | `updateProgress()` | Updates the session progress bar |

---

## Player View

| Line | Function | Description |
|------|----------|-------------|
| 3401 | `updatePvSelect()` | Rebuilds the player-view dropdown with optional search filter |
| 3417 | `updatePvSessFilter()` | Rebuilds the session filter dropdown in player view |
| 3434 | `filterPvSearch()` | Filters player-view dropdown by search text |
| 3441 | `clearPvSearch()` | Clears the player-view search |
| 3447 | `onPvSelectChange()` | Handles player selection change |
| 4637 | `toggleAdvMode()` | Toggles advanced settings panel visibility |

---

## DB Maintenance

| Line | Function | Description |
|------|----------|-------------|
| 3185 | `rebuildDbFromArchive()` | Rebuilds the player database from archived sessions (disaster recovery) |
| 3276 | `deleteArchiveSess(sessId)` | Deletes an archived session |
| 2808 | `toggleDbAbsent()` | Toggles the "show absent only" filter in the player list |

---

## Boot & Mode Initialization (lines 7885–8010)

| Line | Function | Description |
|------|----------|-------------|
| 7888 | `isObserverModeUrl()` | Checks URL for observer mode params |
| 7893 | `initObserverMode()` | Activates observer mode — hides write controls, disables buttons |
| 7926 | `initPlayerMode()` | Activates player mode — shows only the player stats tab |
| 7961 | `init()` | Main bootstrap — cleans up legacy localStorage, initialises UI, connects Firebase |
| 8010 | `DOMContentLoaded` | Fires `init()` |
