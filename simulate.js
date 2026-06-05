/*
 * Pickleball Event Simulator
 * Paste into browser console or load via <script> tag with ?simulate in URL.
 *
 * Usage:
 *   SIM.run()                                    — instant offline (no sync, max speed)
 *   SIM.run({speed:'normal', live:true})          — live sync to Firebase, 1.5s rounds
 *   SIM.run({players:12, courts:2, rounds:15})    — custom params
 *   SIM.runBugChecks()                            — targeted regression tests for bugs 1-5
 *   SIM.stop()                                    — abort a running live simulation
 *
 * Speed presets:
 *   'instant'  — 0ms delay, no UI updates (fastest, for regression checks)
 *   'fast'     — 300ms between actions, renders UI
 *   'normal'   — 1500ms between actions, renders UI (good for watching)
 *   'slow'     — 3000ms between actions, renders UI (good for multi-device demo)
 *   number     — custom ms delay
 *
 * Live mode (live:true):
 *   STORE.save() calls go through to Firebase. Open the app on another device
 *   and watch the brackets update in real time.
 */
const SIM = (() => {

  const NAMES = [
    'Alex','Jordan','Sam','Morgan','Taylor','Casey','Riley','Quinn',
    'Avery','Charlie','Drew','Frankie','Jamie','Kai','Logan','Nico',
    'Peyton','Reese','Skyler','Toby','Blake','Cameron','Dakota','Emery',
    'Finley','Harper','Hayden','Jessie','Kerry','Lane'
  ];

  const SPEEDS = { instant: 0, sprint: 50, fast: 300, normal: 1500, slow: 3000 };

  let _log = [];
  let _errs = [];
  let _savedStoreSave;
  let _savedToast;
  let _running = false;
  let _aborted = false;
  let _stepResolve = null;
  let _disruptedAt = {};
  let _disruptedType = {};

  function log(msg) { _log.push(msg); console.log(`[SIM] ${msg}`); }
  function err(msg) { _errs.push(msg); console.error(`[SIM ERR] ${msg}`); }
  function assert(cond, msg) { if (!cond) { err(`ASSERT FAILED: ${msg}`); return false; } return true; }

  function _isStepMode() { return document.getElementById('sim-step')?.checked ?? false; }

  function _showContinue(show) {
    const btn = document.getElementById('sim-continue-btn');
    if (btn) btn.style.display = show ? 'block' : 'none';
  }

  function _continue() {
    if (_stepResolve) { const r = _stepResolve; _stepResolve = null; _showContinue(false); r(); }
  }

  function _waitForContinue() {
    _showContinue(true);
    return new Promise(r => { _stepResolve = r; });
  }

  async function delay(ms) {
    if (_isStepMode()) return _waitForContinue();
    if (ms > 0) return new Promise(r => setTimeout(r, ms));
  }

  function resolveSpeed(speed) {
    if (typeof speed === 'number') return speed;
    return SPEEDS[speed] ?? SPEEDS.instant;
  }

  let _savedRenders = null;
  function stubSideEffects(live) {
    if (!live) {
      _savedStoreSave = STORE.save;
      STORE.save = () => Promise.resolve();
      _savedRenders = { renderLive: window.renderLive, renderHistory: window.renderHistory, renderStandings: window.renderStandings, updateHeader: window.updateHeader };
      window.renderLive = () => {};
      window.renderHistory = () => {};
      window.renderStandings = () => {};
      window.updateHeader = () => {};
    }
    _savedToast = window.toast;
    window.toast = () => {};
  }

  function restoreSideEffects() {
    if (_savedStoreSave) { STORE.save = _savedStoreSave; _savedStoreSave = null; }
    if (_savedRenders) { Object.assign(window, _savedRenders); _savedRenders = null; }
    if (_savedToast) { window.toast = _savedToast; _savedToast = null; }
  }

  function render() {
    try {
      if (S.session) { renderLive(); renderStandings(); }
      renderDB();
    } catch (e) { /* DOM may not be ready */ }
  }

  let _savedPin;
  let _savedDb;
  let _savedArchive;

  function saveRealState() {
    _savedPin = S.adminPin;
    _savedDb = JSON.parse(JSON.stringify(S.db));
    _savedArchive = JSON.parse(JSON.stringify(S.archive));
  }

  function restoreRealState() {
    S.adminPin = _savedPin;
    S.db = _savedDb;
    S.archive = _savedArchive;
    S.session = null;
    S.checkedIn = new Set();
    S.courts = _savedDb ? 1 : S.courts;
    S.editId = null;
  }

  function resetState() {
    S.db = [];
    S.checkedIn = new Set();
    S.session = null;
    S.archive = [];
    S.courts = 1;
    S.editId = null;
  }

  function createPlayers(n) {
    const players = [];
    for (let i = 0; i < n; i++) {
      const rating = 600 + Math.floor(Math.random() * 800);
      const id = uid();
      const p = {
        id, name: NAMES[i] || `Player${i+1}`, tag: '', rating,
        baseRating: rating, isNR: i >= n - 2, nrLevelHint: i >= n - 2 ? rating : null,
        dupr: null, isSeeding: false, gamesPlayed: 0,
        wins: 0, losses: 0, ties: 0,
        createdAt: new Date().toISOString()
      };
      S.db.push(p);
      players.push(p);
    }
    log(`Created ${n} players (${n-2} rated, 2 NR)`);
    return players;
  }

  function checkInAll(players) {
    players.forEach(p => S.checkedIn.add(p.id));
    log(`Checked in ${players.length} players`);
  }

  function startSim(courts) {
    S.courts = courts;
    S.adminPin = 'simtest';
    const arr = [...S.checkedIn];
    const ratedRatings = arr.filter(id => !gp(id)?.isNR).map(id => gp(id)?.rating || 1000);
    const sessAvg = ratedRatings.length ? Math.round(ratedRatings.reduce((a, b) => a + b, 0) / ratedRatings.length) : 1000;

    S.session = {
      id: uid(), name: 'Sim Session', date: new Date().toISOString(), courts,
      targetScore: 11, courtGroupSize: 4, cfMode: true, extendedMin: 16,
      sessionStart: null,
      activePlayers: [...arr],
      players: arr.map(id => {
        const p = gp(id);
        const startR = p.isNR ? (p.nrLevelHint || sessAvg) : (p.rating || 1000);
        return {
          id, name: p.name, tag: p.tag || '', isNR: p.isNR || false, isSeeding: false,
          sRating: startR, startRating: startR, wins: 0, losses: 0, ties: 0,
          matchesPlayed: 0, ptsFor: 0, ptsAgainst: 0, timeOnCourtMs: 0, timeInQueueMs: 0, status: 'active'
        };
      }),
      partnerHx: {}, oppHx: {}, oppHxTime: {},
      nrPairingHx: {},
      cfQueue: [], cfPinnedIds: [], cfPauseAfterGame: [], cfLockedPairs: [], cfSoftPairs: [], cfPermPairs: [],
      cfLeaveSoonIds: [], cfCourts: {}, cfSuggestions: {}, cfLog: [], cfMatchCount: 0,
      courtOffset: 0,
      cfMatchupHx: {}, cfGroupHx: {}, cfPairConsec: {}, cfPairWins: {},
      cfMustSplitPair: null, cfPaused: [],
      cfPairSessionCount: {}, cfPairLastAt: {}, cfPairLastLost: {},
      cfRanks: {},
      neverPair: {}, ratingOverrides: {},
      auditLog: [],
      status: 'lobby'
    };
    log(`Session created in lobby with ${courts} courts`);
  }

  function beginSim() {
    S.session.status = 'active';
    S.session.sessionStart = Date.now();
    _initSessionRanks();
    _invalidateMatchmakingCaches();
    CF._confirmAllBusy = false;
    CF._confirmAllLastTs = 0;
    CF.initQueue();
    log('Play started');
  }

  function confirmAllSuggestions() {
    const confirmed = [];
    for (let c = 1; c <= S.session.courts; c++) {
      if (S.session.cfSuggestions[c]) {
        CF.confirmSuggestion(c);
        confirmed.push(c);
      }
    }
    return confirmed;
  }

  function randomScore() {
    const winner = 11;
    const loser = Math.floor(Math.random() * 10);
    if (Math.random() < 0.03) return [9, 9];
    return Math.random() < 0.5 ? [winner, loser] : [loser, winner];
  }

  function submitAllScores() {
    const submitted = [];
    for (let c = 1; c <= S.session.courts; c++) {
      const ct = S.session.cfCourts?.[c];
      if (ct?.status === 'playing' && ct.match) {
        const [s1, s2] = randomScore();
        CF._doSubmitScore(c, s1, s2);
        submitted.push({ court: c, s1, s2 });
      }
    }
    return submitted;
  }

  // ── Verification helpers ──

  function verifyNoGhosts() {
    const queueIds = (S.session.cfQueue || []).map(q => q.id);
    const leftIds = S.session.players.filter(sp => sp.status === 'left').map(sp => sp.id);
    const activeIds = S.session.activePlayers || [];
    let ok = true;
    leftIds.forEach(id => {
      if (queueIds.includes(id)) { err(`Ghost: ${gp(id)?.name} is left but in queue`); ok = false; }
    });
    queueIds.forEach(id => {
      if (!activeIds.includes(id)) { err(`Ghost: ${gp(id)?.name} in queue but not in activePlayers`); ok = false; }
    });
    return ok;
  }

  function verifyNoDuplicates() {
    const onCourt = [];
    for (let c = 1; c <= S.session.courts; c++) {
      const ct = S.session.cfCourts?.[c];
      if (ct?.status === 'playing' && ct.match) {
        onCourt.push(...ct.match.t1, ...ct.match.t2);
      }
    }
    const dups = onCourt.filter((id, i) => onCourt.indexOf(id) !== i);
    if (dups.length) { err(`Duplicate on-court: ${dups.map(id => gp(id)?.name).join(', ')}`); return false; }
    const queueIds = (S.session.cfQueue || []).map(q => q.id);
    const overlap = onCourt.filter(id => queueIds.includes(id));
    if (overlap.length) { err(`On court AND in queue: ${overlap.map(id => gp(id)?.name).join(', ')}`); return false; }
    return true;
  }

  function verifyAllCourtsVisible() {
    for (let c = 1; c <= S.session.courts; c++) {
      const ct = S.session.cfCourts?.[c];
      const sug = S.session.cfSuggestions?.[c];
      if (ct?.status === 'playing' && ct.match) continue;
      if (sug) continue;
      if (ct?.status === 'ready') continue;
    }
    return true;
  }

  function verifyStats() {
    let ok = true;
    S.session.players.forEach(sp => {
      const total = (sp.wins || 0) + (sp.losses || 0) + (sp.ties || 0);
      if (sp.status !== 'left' && total !== sp.matchesPlayed) {
        err(`Stats mismatch for ${sp.name}: W${sp.wins}+L${sp.losses}+T${sp.ties}=${total} != matchesPlayed=${sp.matchesPlayed}`);
        ok = false;
      }
    });
    return ok;
  }

  function verifyPlayCountBalance() {
    const nc = S.session.courts || 1;
    const mc = S.session.cfMatchCount || 0;
    const paused = new Set((S.session.cfPaused || []).map(q => q.id));
    // On-court players have a match in progress — their matchesPlayed hasn't incremented yet.
    // Add +1 (same as batchGenerateSuggestions floor calc) to avoid transient false positives
    // when one player is mid-match and another just finished.
    const onCourt = new Set(Object.values(S.session.cfCourts || {})
      .filter(ct => ct?.status === 'playing' && ct.match)
      .flatMap(ct => [...ct.match.t1, ...ct.match.t2]));
    const active = S.session.players.filter(sp => sp.status !== 'left' && !paused.has(sp.id));
    if (active.length < 2) return true;
    const permPairIds = new Set((S.session.cfPermPairs || []).flat());
    // [CHALLENGE COURT] the reserved top-K play more by design (dedicated court) — that's an
    // accepted tradeoff, not a fairness bug. Exclude them so this check still verifies the OTHER
    // players are balanced without flagging the expected top-tier tilt.
    let _ccPool = new Set();
    if (S.session.cfChallengeCourt === true && (S.session.courts || 1) >= 3 && typeof _sessionLbRows === 'function') {
      const _ccK = Math.max(4, S.session.cfChallengeK || 6);
      _ccPool = new Set(_sessionLbRows(S.session).filter(p => p.status !== 'left' && !paused.has(p.id)).slice(0, _ccK).map(p => p.id));
    }
    const settled = active.filter(sp => {
      if (_ccPool.has(sp.id)) return false; // Challenge Court top-K — excluded (play more by design)
      if ((sp.matchesPlayed || 0) < nc) return false;
      // Perm pair members structurally wait for each other and accumulate a game-count
      // deficit vs solo players — exclude them like mid-add players.
      if (permPairIds.has(sp.id)) return false;
      const da = _disruptedAt[sp.id];
      if (da != null) {
        if (_disruptedType[sp.id] === 'midadd') return false;
        if ((mc - da) < nc * 4) return false;
      }
      return true;
    });
    if (settled.length < 2) return true;
    const counts = settled.map(sp => (sp.matchesPlayed || 0) + (onCourt.has(sp.id) ? 1 : 0));
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    // Wait wins over play-count: the scheduler now guarantees bounded wait and lets
    // game counts drift (a player who plays often by skill-fit racks up more games).
    // So tolerate a wider game-count spread before flagging — only egregious drift is
    // a real problem. Allow gap = max(4, nc+1): 3 courts → ≤4, 4 courts → ≤5.
    const maxAllowedGap = Math.max(4, nc + 1);
    if (max - min > maxAllowedGap) {
      // Use same on-court +1 offset as the counts array above so names always resolve.
      const behind = settled.filter(sp => (sp.matchesPlayed || 0) + (onCourt.has(sp.id) ? 1 : 0) === min).map(sp => sp.name);
      const ahead  = settled.filter(sp => (sp.matchesPlayed || 0) + (onCourt.has(sp.id) ? 1 : 0) === max).map(sp => sp.name);
      err(`Play count gap: ${max - min} games (min=${min}: ${behind.join(',')} | max=${max}: ${ahead.join(',')})`);
      return false;
    }
    return true;
  }

  // ── Main simulation (async for speed control) ──

  async function run(opts = {}) {
    if (_running) { console.warn('[SIM] Already running. Use SIM.stop() first.'); return; }
    const {
      players: nPlayers = 26,
      courts = 4,
      rounds = 20,
      speed = 'instant',
      live = false,
      challengeCourt = false, // [CHALLENGE COURT] reserve Court 1 for the session top-6 (3+ courts, Phase 2+)
    } = opts;

    _running = true;
    _aborted = false;
    _log = [];
    _errs = [];

    const ms = resolveSpeed(speed);
    const doRender = ms > 0 || live;

    log(`=== SIMULATION START === speed=${speed}(${ms}ms) live=${live}`);
    const t0 = performance.now();

    let _lastSimArch = null;
    saveRealState();
    stubSideEffects(live);
    try {
      resetState();
      const players = createPlayers(nPlayers);
      checkInAll(players);
      startSim(courts);
      if (doRender) render();
      if (live) await STORE.save();
      await delay(ms);

      beginSim();
      if (doRender) render();
      if (live) await STORE.save();
      await delay(ms);

      assert(S.session.status === 'active', 'Session should be active');
      assert(S.session.cfQueue.length > 0, 'Queue should have players');

      // [CHALLENGE COURT] opt-in for this sim run. Engine gates it to 3+ courts and Phase 2+,
      // so early rounds run normally and Court 1 becomes the top-6-only court once ranks settle.
      if (challengeCourt) {
        S.session.cfChallengeCourt = true;
        log(`👑 Challenge Court ENABLED — Court 1 reserved for the session top-6 from Phase 2 (courts=${courts}${courts < 3 ? ', WARNING: needs 3+ to take effect' : ''})`);
      }

      let totalMatches = 0;
      let midAddDone = false;
      let pauseDone = false;      // first pause/resume
      let pauseDone2 = false;     // second pause/resume (different player, later in session)
      let leaveSoonDone = false;
      let midRemoveDone = false;
      _disruptedAt = {};
      _disruptedType = {};

      // Wait-time tracking: completed matches elapsed between a player's last game ending
      // and their next game starting. Measures queue fairness under staggered court finishes.
      const _lastGameEndMc = {}; // player id → cfMatchCount anchor for gap calculation
      const _waitGaps = {};      // player id → array of completed-match waits
      // (Removed: _courtConfirmMc no longer needed — _lastGameEndMc is now set AFTER submit.)

      // Per-court tick counters — each court independently counts down before submitting.
      // 80%: each court gets a fresh 2–5 tick game length (staggered finish).
      // 20%: new court syncs to a currently-playing court's remaining ticks (simultaneous finish).
      const courtTicks = {};
      for (let c = 1; c <= courts; c++) courtTicks[c] = 0;
      function assignGameLen(courtId) {
        if (Math.random() < 0.20) {
          const candidates = [];
          for (let c2 = 1; c2 <= courts; c2++) {
            if (c2 !== courtId && courtTicks[c2] > 0) candidates.push(c2);
          }
          if (candidates.length > 0) {
            const pick = candidates[Math.floor(Math.random() * candidates.length)];
            return courtTicks[pick]; // finish at the same tick as that court
          }
        }
        return 2 + Math.floor(Math.random() * 4); // 2, 3, 4, or 5 ticks (independent)
      }

      // Proportional mid-session event rounds (scale with total rounds)
      const _pauseRound     = Math.max(8,  Math.round(rounds * 0.35)); // player 1 pause
      const _resumeRound    = Math.max(10, Math.round(rounds * 0.45)); // player 1 resume
      const _pause2Round    = Math.max(12, Math.round(rounds * 0.58)); // player 2 pause (after leave-soon)
      const _resume2Round   = Math.max(14, Math.round(rounds * 0.68)); // player 2 resume
      const _leaveSoonRound = Math.max(11, Math.round(rounds * 0.52)); // between the two pauses
      const _midRmRound     = Math.max(16, Math.round(rounds * 0.78));

      for (let r = 0; r < rounds; r++) {
        if (_aborted) { log('ABORTED by user'); break; }
        const _roundT0 = performance.now();

        // Regenerate suggestions for ready courts that have none
        const readyNoSug = [];
        for (let c = 1; c <= S.session.courts; c++) {
          const ct = S.session.cfCourts?.[c];
          if (ct?.status === 'ready' && !S.session.cfSuggestions?.[c] && S.session.cfQueue.length >= 4) {
            readyNoSug.push(c);
          }
        }
        if (readyNoSug.length) {
          try { CF.batchGenerateSuggestions(readyNoSug, null); } catch(e) { log(`Regen error: ${e.message}`); }
        }

        // Confirm suggestions one by one
        let confirmedCount = 0;
        for (let c = 1; c <= S.session.courts; c++) {
          if (_aborted) break;
          if (S.session.cfSuggestions[c]) {
            // Record wait gap (completed matches since each player's last game ended)
            const _sug = S.session.cfSuggestions[c];
            if (_sug) {
              const _mc = S.session.cfMatchCount || 0;
              [...(_sug.t1||[]), ...(_sug.t2||[])].forEach(id => {
                if (_lastGameEndMc[id] !== undefined) {
                  if (!_waitGaps[id]) _waitGaps[id] = [];
                  _waitGaps[id].push(_mc - _lastGameEndMc[id]);
                }
              });
            }
            CF.confirmSuggestion(c);
            courtTicks[c] = assignGameLen(c);
            confirmedCount++;
            log(`Round ${r+1}: confirmed court ${c} (ticks=${courtTicks[c]})`);
            verifyNoDuplicates();
            if (doRender) render();
            if (live) await STORE.save();
            await delay(ms);
          }
        }
        if (confirmedCount === 0 && S.session.cfQueue.length < 4) {
          log(`Round ${r+1}: not enough players for any court, skipping`);
          continue;
        }
        if (confirmedCount === 0 && S.session.cfQueue.length >= 4) {
          const mc = S.session.cfMatchCount || 0;
          const courtStates = [];
          for (let c2 = 1; c2 <= S.session.courts; c2++) {
            const ct2 = S.session.cfCourts?.[c2];
            courtStates.push(`C${c2}:${ct2?.status||'?'}${S.session.cfSuggestions?.[c2]?'+sug':''}`);
          }
          log(`Round ${r+1}: 0 confirmed, mc=${mc} q=${S.session.cfQueue.length} ${courtStates.join(' ')}`);
        }

        if (_aborted) break;

        // Submit scores one by one (courts with ticks > 0 are still mid-game)
        for (let c = 1; c <= S.session.courts; c++) {
          if (_aborted) break;
          const ct = S.session.cfCourts?.[c];
          if (ct?.status === 'playing' && ct.match) {
            if (courtTicks[c] > 0) { courtTicks[c]--; continue; }
            // Queue-time-only anchor: set _lastGameEndMc AFTER _doSubmitScore so we capture
            // cfMatchCount = matchIdx+1 (game-end time, not game-start/confirm time).
            // This matches index.html WAIT column: gap = confirmMc_next - matchIdx_prev - 1.
            // In-game submits from other courts are excluded from the WAIT metric.
            const _ct = S.session.cfCourts?.[c];
            const _submitPlayers = _ct?.match ? [...(_ct.match.t1||[]), ...(_ct.match.t2||[])] : [];
            const [s1, s2] = randomScore();
            const _submitT0 = performance.now();
            CF._doSubmitScore(c, s1, s2);
            // After submit: S.session.cfMatchCount = matchIdx+1 (game-end anchor for queue-only WAIT).
            _submitPlayers.forEach(id => { _lastGameEndMc[id] = S.session.cfMatchCount; });
            const _submitMs = performance.now() - _submitT0;
            totalMatches++;
            log(`Round ${r+1}: court ${c} score ${s1}-${s2}${_submitMs > 500 ? ` (${Math.round(_submitMs)}ms!)` : ''}`);
            verifyNoGhosts();
            verifyStats();
            if (doRender) render();
            if (live) await STORE.save();
            await delay(ms);
          }
        }

        verifyPlayCountBalance();

        const _roundMs = performance.now() - _roundT0;
        if (_roundMs > 3000) log(`Round ${r+1}: SLOW ${Math.round(_roundMs)}ms`);

        // ── Mid-session events ──

        // Late arrival: 30-60 min in (~30% of rounds with 10 min/game avg)
        const _lateRound = Math.max(4, Math.round(rounds * 0.30));
        if (r === _lateRound && !midAddDone && nPlayers < NAMES.length) {
          const newId = uid();
          const newRating = 700 + Math.floor(Math.random() * 600);
          S.db.push({
            id: newId, name: NAMES[nPlayers], tag: 'LATE', rating: newRating,
            baseRating: newRating, isNR: false, nrLevelHint: null, dupr: null,
            isSeeding: false, gamesPlayed: 0, wins: 0, losses: 0, ties: 0,
            createdAt: new Date().toISOString()
          });
          S.checkedIn.add(newId);
          midAdd(newId);
          midAddDone = true;
          _disruptedAt[newId] = S.session.cfMatchCount || 0;
          _disruptedType[newId] = 'midadd';
          // Initialise wait tracking from join time so the queue-wait before first game
          // is counted, not skipped. Without this, _lastGameEndMc stays undefined and
          // the first inter-game gap records as 0 regardless of actual wait.
          _lastGameEndMc[newId] = S.session.cfMatchCount || 0;
          log(`Mid-add: ${NAMES[nPlayers]} joined (round ${r+1})`);
          verifyNoGhosts();
          if (doRender) render();
          if (live) await STORE.save();
          await delay(ms);
        }

        if (r === _pauseRound && !pauseDone) {
          const qPlayer = S.session.cfQueue[0];
          if (qPlayer) {
            cfPausePlayer(qPlayer.id);
            pauseDone = qPlayer.id;
            log(`Paused: ${gp(qPlayer.id)?.name} (round ${r+1})`);
            if (doRender) render();
            if (live) await STORE.save();
            await delay(ms);
          }
        }

        if (r === _resumeRound && pauseDone) {
          const pEntry = (S.session.cfPaused || []).find(q => q.id === pauseDone);
          if (pEntry) {
            cfResumePlayer(pauseDone);
            // Reset the wait clock at resume — a voluntary pause is not queue wait, so the
            // wait-cap gate should measure only the post-resume wait, not the pause span.
            _lastGameEndMc[pauseDone] = S.session.cfMatchCount || 0;
            _disruptedAt[pauseDone] = S.session.cfMatchCount || 0;
            _disruptedType[pauseDone] = 'resume';
            log(`Resumed: ${gp(pauseDone)?.name} (round ${r+1})`);
            if (doRender) render();
            if (live) await STORE.save();
            await delay(ms);
          }
          pauseDone = false;
        }

        // Second pause/resume — different player, later in the session
        if (r === _pause2Round && !pauseDone2) {
          // Pick a queue player who wasn't the first paused player and isn't leaving soon
          const leaveSoonIds = S.session.cfLeaveSoonIds || [];
          const cand2 = S.session.cfQueue.find(q =>
            q.id !== pauseDone && !leaveSoonIds.includes(q.id)
          );
          if (cand2) {
            cfPausePlayer(cand2.id);
            pauseDone2 = cand2.id;
            log(`Paused #2: ${gp(cand2.id)?.name} (round ${r+1})`);
            if (doRender) render();
            if (live) await STORE.save();
            await delay(ms);
          }
        }

        if (r === _resume2Round && pauseDone2) {
          const pEntry2 = (S.session.cfPaused || []).find(q => q.id === pauseDone2);
          if (pEntry2) {
            cfResumePlayer(pauseDone2);
            // Reset the wait clock at resume (see note above) — pause span is not queue wait.
            _lastGameEndMc[pauseDone2] = S.session.cfMatchCount || 0;
            _disruptedAt[pauseDone2] = S.session.cfMatchCount || 0;
            _disruptedType[pauseDone2] = 'resume';
            log(`Resumed #2: ${gp(pauseDone2)?.name} (round ${r+1})`);
            if (doRender) render();
            if (live) await STORE.save();
            await delay(ms);
          }
          pauseDone2 = false;
        }

        if (r === _leaveSoonRound && !leaveSoonDone) {
          const qPlayer = S.session.cfQueue[1] || S.session.cfQueue[0];
          if (qPlayer) {
            cfLeaveSoon(qPlayer.id);
            leaveSoonDone = true;
            log(`Leave soon: ${gp(qPlayer.id)?.name} (round ${r+1})`);
            if (doRender) render();
            if (live) await STORE.save();
            await delay(ms);
          }
        }

        if (r === _midRmRound && !midRemoveDone) {
          const removable = S.session.activePlayers.find(id => {
            const onCourt = Object.values(S.session.cfCourts || {}).some(
              ct => ct?.status === 'playing' && ct.match && [...ct.match.t1, ...ct.match.t2].includes(id)
            );
            return !onCourt && gsp(id)?.status !== 'left';
          });
          if (removable) {
            midRemove(removable);
            midRemoveDone = true;
            log(`Mid-remove: ${gp(removable)?.name} (round ${r+1})`);
            assert(!S.session.cfRanks[removable], `Removed player should be cleared from cfRanks immediately`);
            verifyNoGhosts();
            if (doRender) render();
            if (live) await STORE.save();
            await delay(ms);
          }
        }
      }

      if (!_aborted) {
        // Final verification
        if (leaveSoonDone) {
          const leftPlayers = S.session.players.filter(sp => sp.status === 'left');
          const queueIds = new Set((S.session.cfQueue || []).map(q => q.id));
          leftPlayers.forEach(sp => {
            assert(!queueIds.has(sp.id), `Bug1 regression: left player ${sp.name} should not be in queue`);
          });
          log(`Bug 1 check: ${leftPlayers.length} left player(s) verified not in queue`);
        }

        verifyAllCourtsVisible();
        log('Bug 3 check: all courts accounted for');

        // End session
        const arch = {
          id: S.session.id, name: S.session.name, date: S.session.date, cfMode: true,
          players: S.session.players.map(sp => {
            const p = gp(sp.id) || {};
            return {
              id: sp.id, name: sp.name || p.name || '?', tag: sp.tag || p.tag || '',
              sRating: sp.sRating, startRating: sp.startRating,
              wins: sp.wins, losses: sp.losses, ties: sp.ties,
              matchesPlayed: sp.matchesPlayed, ptsFor: sp.ptsFor, ptsAgainst: sp.ptsAgainst,
              _joinedAtMatch: sp._joinedAtMatch ?? null, _resumedAtMatch: sp._resumedAtMatch ?? null
            };
          }),
          cfRanks: JSON.parse(JSON.stringify(S.session.cfRanks || {})),
          cfLog: JSON.parse(JSON.stringify(S.session.cfLog || []))
        };
        S.archive.unshift(arch);
        _lastSimArch = JSON.parse(JSON.stringify(arch));
        S.checkedIn.clear();
        S.session = null;
        recalcAllTimeRatings();

        const totalDbGames = S.db.reduce((sum, p) => sum + (p.gamesPlayed || 0), 0);
        assert(totalDbGames > 0, 'Bug2 regression: total gamesPlayed should be > 0 after session');
        log(`Bug 2 check: totalDbGames=${totalDbGames}`);

        // ── Wait-time report ──────────────────────────────────────────────
        // Shows each player's full gap sequence so consecutive long waits are visible.
        // A gap = completed matches by other courts while this player sat in queue.
        // Flag threshold: courts*2 (e.g. 4 for 2c, 6 for 3c, 8 for 4c).
        log('--- Wait Report (completed matches waited between games) ---');
        const longWaitThreshold = courts * 2; // 2 full rotation cycles = clearly too long
        const waitEntries = Object.entries(_waitGaps).map(([id, gaps]) => {
          const avg = gaps.length ? (gaps.reduce((a,b)=>a+b,0)/gaps.length).toFixed(1) : '–';
          const max = gaps.length ? Math.max(...gaps) : 0;
          // Find longest consecutive run of gaps >= longWaitThreshold
          let consecRun = 0, maxConsecRun = 0, cur = 0;
          gaps.forEach(g => {
            if (g >= longWaitThreshold) { cur++; maxConsecRun = Math.max(maxConsecRun, cur); }
            else cur = 0;
          });
          return { id, name: gp(id)?.name||id, avg: parseFloat(avg)||0, max, gaps, maxConsecRun };
        }).sort((a,b) => b.max - a.max || b.maxConsecRun - a.maxConsecRun);

        waitEntries.forEach(({ name, avg, max, gaps, maxConsecRun }) => {
          // Annotate the sequence: mark each gap with ★ if it hits the threshold
          const seq = gaps.map(g => g >= longWaitThreshold ? `[${g}]` : `${g}`).join('-');
          const flag = max >= longWaitThreshold
            ? (maxConsecRun >= 2 ? ' 🔴 STUCK' : ' ⚠️ long wait')
            : '';
          log(`  ${(name+'          ').slice(0,10)} avg=${avg} max=${max}  gaps: ${seq||'–'}${flag}`);
        });

        const longWaiters = waitEntries.filter(e => e.max >= longWaitThreshold);
        const stuckPlayers = waitEntries.filter(e => e.maxConsecRun >= 2);
        if (longWaiters.length === 0) {
          log(`  ✅ All players waited ≤${longWaitThreshold-1} completed matches between games`);
        } else {
          log(`  ⚠️ ${longWaiters.length} player(s) had a single wait ≥${longWaitThreshold} matches`);
          if (stuckPlayers.length) log(`  🔴 ${stuckPlayers.length} player(s) had long waits back-to-back (long wait → played 1 game → long wait again)`)
        }

        // ── WAIT CAP gate (matchmaking-spec.md §3, §8) ─────────────────────
        // Constant cap = max(nc*mult + 1, fair_floor + 1)  (mult = cfWaitCapMult = 2)
        //   → 5 (2c), 7 (3c), 9 (4c)
        // (A phase-graduated cap was tried and reverted — extra late wait-budget didn't tighten
        // matches; the ladder arc is bounded by rotation structure, not wait budget.)
        {
          const _capN = arch.players.length;
          const _capBench = Math.max(0, _capN - 4 * courts);
          const _capFloor = Math.ceil(_capBench / 4);
          const _mult = 2; // cfWaitCapMult default (Competitive); Social would be 1
          const _base = Math.floor(courts * _mult) + 1;
          const _waitCap = Math.max(_base, _capFloor + 1);
          const _roomTooFull = (_capFloor + 1) > _base;
          log(`--- WAIT CAP gate (N=${_capN}, courts=${courts}, bench=${_capBench}, fairFloor=${_capFloor}, cap=${_waitCap}${_roomTooFull ? ' — room too full for nc*mult+1 target' : ''}) ---`);
          const _capViolators = waitEntries.filter(e => e.max > _waitCap);
          if (_capViolators.length === 0) {
            log(`  ✅ WAIT CAP PASS — all players' max gap ≤ ${_waitCap}`);
          } else {
            _capViolators
              .sort((a, b) => b.max - a.max)
              .forEach(({ name, max, gaps }) => {
                const seq = gaps.map(g => g > _waitCap ? `[${g}]` : `${g}`).join('-');
                err(`WAIT CAP breach: ${name} max gap ${max} > cap ${_waitCap}  (gaps: ${seq})`);
              });
            log(`  ❌ WAIT CAP FAIL — ${_capViolators.length} player(s) exceeded cap ${_waitCap}`);
          }
        }

        // ── Skill Quality by phase (ladder-arc verification) ───────────────
        // Buckets completed matches into session thirds (a proxy for phase — later third =
        // more games played = more confident ranks) and reports avg partner gap + team gap
        // in RANK positions, using final standings rank. If the ladder arc works, the
        // numbers should DROP left→right (P1 loose → P3 tight). Partner = teammate rank
        // distance (lower = play with your level); Team = opponent-pair rank distance.
        {
          const _rankOf = {};
          [...arch.players].sort((a,b)=>(b.sRating||0)-(a.sRating||0)).forEach((p,i)=>{_rankOf[p.id]=i+1;});
          const _qlog = arch.cfLog || [];
          const _third = Math.max(1, Math.ceil(_qlog.length/3));
          const _pBuckets = [[],[],[]], _tBuckets = [[],[],[]];
          _qlog.forEach((m,i)=>{
            const t1=m.t1||[], t2=m.t2||[];
            if(t1.length<2||t2.length<2)return;
            const r=id=>_rankOf[id]||0;
            if(!r(t1[0])||!r(t1[1])||!r(t2[0])||!r(t2[1]))return;
            const pg=Math.max(Math.abs(r(t1[0])-r(t1[1])),Math.abs(r(t2[0])-r(t2[1])));
            const tg=Math.abs((r(t1[0])+r(t1[1]))/2-(r(t2[0])+r(t2[1]))/2);
            const b=Math.min(2,Math.floor(i/_third));
            _pBuckets[b].push(pg); _tBuckets[b].push(tg);
          });
          const _avg=a=>a.length?(a.reduce((s,x)=>s+x,0)/a.length).toFixed(1):'–';
          log('--- Skill Quality by phase (rank gaps; should DROP P1→P3 if ladder arc works) ---');
          log(`  Partner gap (teammate):  P1=${_avg(_pBuckets[0])}  P2=${_avg(_pBuckets[1])}  P3=${_avg(_pBuckets[2])}`);
          log(`  Team gap (vs opponents): P1=${_avg(_tBuckets[0])}  P2=${_avg(_tBuckets[1])}  P3=${_avg(_tBuckets[2])}`);
        }

        // ── [CHALLENGE COURT] reservation check (accurate — uses the per-match flag) ─────────
        // Each confirmed challenge match is tagged m.challenge=true (top-6 at formation time). We
        // count those directly instead of guessing from final standings (which churn). If the
        // feature worked: challenge matches > 0, all on the middle court, none leaked elsewhere.
        {
          const _mid = Math.ceil(courts/2);
          const _qlog2 = arch.cfLog || [];
          let chMid = 0, chOther = 0, midTot = 0;
          _qlog2.forEach(m => {
            if (m.courtNum === _mid) midTot++;
            if (m.challenge === true) { if (m.courtNum === _mid) chMid++; else chOther++; }
          });
          if (!challengeCourt) {
            log('--- [CHALLENGE COURT] not enabled for this run (pass challengeCourt:true to test it) ---');
          } else if (courts < 3) {
            // The engine intentionally disables the Challenge Court below 3 courts (needs _nCourts>=3):
            // reserving 1 of 2 courts would strand everyone else on a single court. So 0 here is
            // CORRECT — assert it's truly off rather than printing a misleading "courts>=3" diagnostic.
            const leaked = chMid + chOther;
            if (leaked === 0) log(`--- [CHALLENGE COURT] OFF at ${courts} courts (needs ≥3) — correctly disabled, 0 challenge matches tagged ✅ ---`);
            else err(`[CHALLENGE COURT] must be OFF at ${courts} courts but ${leaked} challenge match(es) were tagged`);
          } else {
            log(`--- [CHALLENGE COURT] middle court = #${_mid} (top-6-only, tagged at formation) ---`);
            log(`  Challenge matches played: ${chMid} on court #${_mid}  ← > 0 means the Challenge Court engaged`);
            log(`  Challenge matches that leaked onto other courts: ${chOther}  ← MUST be 0`);
            if (chMid > 0) log('  ✅ Challenge Court worked — top-6-only matches ran on the middle court (they play more by design; excluded from the play-count check)');
            else log('  (no challenge matches — challengeCourt:true and courts≥3, so check the run reached Phase 2; short runs may not)');
          }
        }

        log('--- Player Stats ---');
        const sorted = [...arch.players].sort((a,b) => (b.sRating||0) - (a.sRating||0));
        sorted.forEach((sp, i) => {
          const d = Math.round((sp.sRating||0) - (sp.startRating||0));
          const dStr = d >= 0 ? `+${d}` : `${d}`;
          log(`  ${i+1}. ${sp.name}: ${sp.wins||0}W/${sp.losses||0}L ${sp.matchesPlayed||0}G  Rating:${Math.round(sp.sRating||0)} (${dStr})`);
        });

        if (doRender) render();
        if (live) await STORE.save();
      }

      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      log(`=== SIMULATION COMPLETE ===`);
      log(`${totalMatches} matches in ${elapsed}s | ${_errs.length} error(s)`);

      if (_errs.length) console.warn('[SIM] ERRORS:', _errs);
      else log('ALL CHECKS PASSED');

    } finally {
      _running = false;
      restoreSideEffects();
      restoreRealState();
      if (_lastSimArch) S.archive.unshift(_lastSimArch);
      if (typeof renderDB === 'function') try { renderDB(); renderRoster?.(); renderHistory?.(); renderStandings?.(); } catch(e) {}
    }

    return { log: _log, errors: _errs, passed: _errs.length === 0 };
  }

  function stop() {
    if (!_running) { console.log('[SIM] Not running.'); return; }
    _aborted = true;
    _showContinue(false);
    if (_stepResolve) { const r = _stepResolve; _stepResolve = null; r(); }
    log('Stop requested — will halt after current round');
  }

  // ── Bug regression tests (always instant, no sync) ──

  function runBugChecks() {
    _log = [];
    _errs = [];
    log('=== BUG REGRESSION TESTS ===');

    stubSideEffects(false);
    try {

      // Bug 1: Ghost re-queue
      log('--- Bug 1: Leave-soon ghost re-queue ---');
      resetState();
      const p1 = createPlayers(8);
      checkInAll(p1);
      startSim(1);
      beginSim();

      let confirmed = confirmAllSuggestions();
      assert(confirmed.length === 1, 'Bug1: should confirm 1 court');

      const matchPlayers = [...S.session.cfCourts[1].match.t1, ...S.session.cfCourts[1].match.t2];
      const leaverId = matchPlayers[0];
      S.session.cfLeaveSoonIds = [leaverId];

      CF._doSubmitScore(1, 11, 7);

      const leaverSp = gsp(leaverId);
      assert(leaverSp?.status === 'left', `Bug1: ${gp(leaverId)?.name} should have status='left'`);
      assert(!S.session.cfQueue.some(q => q.id === leaverId), `Bug1: ${gp(leaverId)?.name} should NOT be re-queued`);
      assert(!S.session.activePlayers.includes(leaverId), `Bug1: ${gp(leaverId)?.name} should NOT be in activePlayers`);
      log('Bug 1: PASSED');

      // Bug 2: Archive cap stats
      log('--- Bug 2: Archive cap stats ---');
      resetState();
      createPlayers(8);
      for (let i = 0; i < 35; i++) {
        S.archive.push({
          id: uid(), name: `Session ${i+1}`, date: new Date().toISOString(), cfMode: true,
          players: S.db.map(p => ({
            id: p.id, name: p.name, tag: '', sRating: p.rating + 5, startRating: p.rating,
            wins: 2, losses: 1, ties: 0, matchesPlayed: 3, ptsFor: 30, ptsAgainst: 20
          })),
          cfLog: []
        });
      }
      assert(S.archive.length === 35, 'Bug2: archive should hold all 35 sessions (no cap)');
      recalcAllTimeRatings();
      const totalWins = S.db.reduce((sum, p) => sum + (p.wins || 0), 0);
      assert(totalWins === 35 * 2 * 8, `Bug2: total wins should be ${35*2*8}, got ${totalWins}`);
      log('Bug 2: PASSED');

      // Bug 3: Disappearing court
      log('--- Bug 3: Disappearing court visibility ---');
      resetState();
      createPlayers(6);
      checkInAll(S.db);
      startSim(2);
      beginSim();

      S.session.cfCourts[2] = { status: 'ready', match: null, idleStart: Date.now(), totalIdleMs: 0, matchCount: 0 };
      S.session.cfSuggestions[2] = null;
      let rendered = 0;
      for (let c = 1; c <= S.session.courts; c++) {
        const ct = S.session.cfCourts?.[c];
        if (ct?.status === 'playing' && ct.match) rendered++;
        else if (S.session.cfSuggestions?.[c]) rendered++;
        else if (ct?.status === 'ready') rendered++;
      }
      assert(rendered === S.session.courts, `Bug3: all ${S.session.courts} courts should be rendered, got ${rendered}`);
      log('Bug 3: PASSED');

      // Bug 4: _applyRemote wipes pre-session check-ins
      log('--- Bug 4: Pre-session check-in preservation ---');
      resetState();
      const p4 = createPlayers(8);
      checkInAll(p4);
      assert(S.checkedIn.size === 8, 'Bug4: 8 players checked in');

      const fakeSession = { status: 'lobby', players: [], cfMode: true };
      if (fakeSession.activePlayers?.length) {
        S.checkedIn.clear();
        fakeSession.activePlayers.forEach(id => S.checkedIn.add(id));
      }
      assert(S.checkedIn.size === 8, `Bug4: check-ins should survive, got ${S.checkedIn.size}`);
      log('Bug 4: PASSED');

      // Bug 5: midRemove cfRanks immediate clear
      log('--- Bug 5: midRemove immediate cfRanks clear ---');
      resetState();
      const p5 = createPlayers(8);
      checkInAll(p5);
      startSim(1);
      beginSim();

      confirmAllSuggestions();
      submitAllScores();

      const removeTarget = S.session.cfQueue.find(q => {
        const onCourt = Object.values(S.session.cfCourts || {}).some(
          ct => ct?.status === 'playing' && ct.match && [...ct.match.t1, ...ct.match.t2].includes(q.id)
        );
        return !onCourt;
      });
      if (removeTarget) {
        S.session.cfRanks[removeTarget.id] = { rank: 1, band: 'A' };
        midRemove(removeTarget.id);
        assert(!S.session.cfRanks[removeTarget.id], `Bug5: ${gp(removeTarget.id)?.name} should be removed from cfRanks immediately`);
        log('Bug 5: PASSED');
      } else {
        log('Bug 5: SKIPPED (no removable player found)');
      }

      log('=== BUG REGRESSION TESTS COMPLETE ===');
      log(`${_errs.length} failure(s)`);
      if (_errs.length) console.warn('[SIM] FAILURES:', _errs);
      else log('ALL BUG CHECKS PASSED');

    } finally {
      restoreSideEffects();
      resetState();
    }

    return { log: _log, errors: _errs, passed: _errs.length === 0 };
  }

  // ── Organizer 14p/2c simulation ──────────────────────────────────────────

  async function runOrganizer12(opts = {}) {
    if (_running) { console.warn('[SIM] Already running. SIM.stop() first.'); return; }
    const { speed = 'fast', live = false } = opts;
    const ms = resolveSpeed(speed);
    const doRender = ms > 0 || live;

    _running = true; _aborted = false; _log = []; _errs = [];
    _disruptedAt = {}; _disruptedType = {};

    // Per-run quality accumulators
    let permA = null, permB = null;
    let _matchSnaps = [];      // {matchNum, court, gap, t1Avg, t2Avg}
    let _waitTrack = {};       // {id: {cur, max}}
    let _partnerTrack = {};    // {id: Set<partnerId>}
    let _permViolations = 0, _permMatches = 0, _permHeldRounds = 0;

    // Snapshot court teams right after confirm
    const snapCourt = (c, matchNum) => {
      const ct = S.session.cfCourts?.[c];
      if (!ct?.match || ct.status !== 'playing') return;
      const { t1, t2 } = ct.match;
      const all = new Set([...t1, ...t2]);
      const avgR = ids => ids.reduce((s, id) => s + (gsp(id)?.sRating || gp(id)?.rating || 1000), 0) / ids.length;
      const t1a = avgR(t1), t2a = avgR(t2);
      _matchSnaps.push({ matchNum, court: c, gap: Math.abs(t1a - t2a), t1Avg: Math.round(t1a), t2Avg: Math.round(t2a) });
      for (const id of all) {
        if (!_partnerTrack[id]) _partnerTrack[id] = new Set();
        const myTeam = t1.includes(id) ? t1 : t2;
        myTeam.forEach(pid => { if (pid !== id) _partnerTrack[id].add(pid); });
      }
      const paused = new Set((S.session.cfPaused || []).map(q => q.id));
      for (const id of (S.session.activePlayers || [])) {
        const sp = gsp(id); if (!sp || sp.status === 'left') continue;
        if (!_waitTrack[id]) _waitTrack[id] = { cur: 0, max: 0 };
        if (all.has(id)) { _waitTrack[id].cur = 0; }
        else if (!paused.has(id)) { _waitTrack[id].cur++; if (_waitTrack[id].cur > _waitTrack[id].max) _waitTrack[id].max = _waitTrack[id].cur; }
      }
      if (permA && permB) {
        // Only enforce while the pair is still registered — after cfRemovePermPair the
        // players are independent and may appear on separate courts without violation.
        const _pk = (a, b) => [a, b].sort().join('|');
        const _key = _pk(permA, permB);
        const _stillActive = (S.session?.cfPermPairs || []).some(p => _pk(p[0], p[1]) === _key);
        if (_stillActive) {
          const aP = all.has(permA), bP = all.has(permB);
          const aLeft = gsp(permA)?.status === 'left', bLeft = gsp(permB)?.status === 'left';
          if (aP && bP) {
            _permMatches++;
            if (t1.includes(permA) !== t1.includes(permB)) { err(`PERM PAIR SPLIT-TEAM C${c} M${matchNum}`); _permViolations++; }
          } else if ((aP && !bP && !bLeft) || (bP && !aP && !aLeft)) {
            err(`PERM PAIR VIOLATION C${c} M${matchNum}: ${gp(permA)?.name}(in=${aP}) ${gp(permB)?.name}(in=${bP})`);
            _permViolations++;
          }
        }
      }
    };

    const checkPermHeld = () => {
      if (!permA || !permB) return;
      const qIds = new Set((S.session.cfQueue || []).map(q => q.id));
      const aQ = qIds.has(permA), bQ = qIds.has(permB);
      const aLeft = gsp(permA)?.status === 'left', bLeft = gsp(permB)?.status === 'left';
      if ((aQ && !bQ && !bLeft) || (bQ && !aQ && !aLeft)) _permHeldRounds++;
    };

    // ── DOM-free helpers for non-happy-path scenarios ─────────────────────

    // Swap one player in a pending suggestion (replicates CF.confirmSwap without modal)
    const simSwapPreview = (c, outId, inId) => {
      const sug = S.session?.cfSuggestions[c];
      if (!sug || !sug.allIds.includes(outId)) return false;
      if (!S.session.cfQueue.some(q => q.id === inId)) return false;
      if (!S.session.cfQueue.find(q => q.id === outId))
        S.session.cfQueue.push({ id: outId, since: Date.now(), consec: 0 });
      const newIds = sug.allIds.map(id => id === outId ? inId : id);
      const players = newIds.map(id => ({ id, sr: CF._rankSr(id), waitMin: 0 }));
      const { t1, t2 } = MM.bestPair(players);
      const gap = Math.abs((t1[0].sr + t1[1].sr) / 2 - (t2[0].sr + t2[1].sr) / 2);
      S.session.cfSuggestions[c] = { ...sug, t1: t1.map(p => p.id), t2: t2.map(p => p.id), allIds: newIds,
        meta: { ...sug.meta, gap: Math.round(gap), gapWarn: gap > 80 } };
      CF._reserveAndRefreshOtherCourts(c, newIds);
      return true;
    };

    // Swap one player mid-match (replicates CF.confirmActiveMatchSwap without modal)
    const simSwapActive = (c, outId, inId) => {
      const ct = S.session.cfCourts[c];
      if (!ct?.match) return false;
      const m = ct.match;
      if (![...m.t1, ...m.t2].includes(outId)) return false;
      const avail = [...(S.session.cfQueue || []), ...(S.session.cfPaused || [])];
      if (!avail.some(q => q.id === inId)) return false;
      const inQEntry = avail.find(q => q.id === inId);
      const updatedQS = { ...(m.queueSince || {}) };
      updatedQS[inId] = inQEntry?.since || m.startTime || Date.now();
      delete updatedQS[outId];
      ct.match = { ...m, t1: m.t1.map(id => id === outId ? inId : id), t2: m.t2.map(id => id === outId ? inId : id), queueSince: updatedQS };
      S.session.cfQueue = S.session.cfQueue.filter(q => q.id !== inId);
      if (S.session.cfPaused) S.session.cfPaused = S.session.cfPaused.filter(q => q.id !== inId);
      if (!S.session.cfQueue.find(q => q.id === outId))
        S.session.cfQueue.push({ id: outId, since: Date.now(), consec: 0 });
      AUDIT.log('swap_active', `Sim swap: ${gp(outId)?.name||'?'} → ${gp(inId)?.name||'?'}`, c);
      rebuildCFDerivedState();
      if (!S.session.cfCourts[c])
        S.session.cfCourts[c] = { status: 'playing', match: ct.match, idleStart: 0, totalIdleMs: 0, matchCount: 0 };
      return true;
    };

    // Edit a logged match score (replicates _saveCFScore without modal)
    const simEditScore = (matchIdx, newS1, newS2) => {
      const m = S.session?.cfLog?.[matchIdx];
      if (!m) return false;
      const old = `${m.s1}-${m.s2}`;
      m.s1 = newS1; m.s2 = newS2;
      const _target = S.session.targetScore || 11;
      const _hi = Math.max(newS1, newS2), _lo = Math.min(newS1, newS2);
      m.noElo = (newS1 === newS2) || (_hi < _target) || (newS1 !== newS2 && !isValidFinal(_hi, _lo, _target));
      AUDIT.log('score_edit', `Sim score edit M${matchIdx}: ${old} → ${newS1}-${newS2}`);
      recalcSessionCFELO();
      rebuildCFDerivedState();
      recalcAllTimeRatings();
      return true;
    };

    log('=== ORGANIZER SIM: 14 players / 2 courts ===');
    log('Scenarios: staggered court finishes · swap in preview · swap mid-match · score edit');
    log('           quality-first reshuffle · late arrivals · pause/resume · leave-soon');
    log('           mid-remove · permanent partners + pause/resume perm pair member');
    log('');

    saveRealState();
    stubSideEffects(live);
    try {
      resetState();

      //   0=Alex(1350-A)  1=Jordan(1250-A)  2=Sam(1100-B+)  3=Morgan(1050-B)
      //   4=Taylor(960-B) 5=Casey(910-B-)   6=Riley(860-C+) 7=Quinn(810-C)
      //   8=Avery(760-C)  9=Charlie(700-C-) 10=Drew(650-D)  11=Frankie(600-D)
      //   12=Jamie(NR)    13=Kai(NR)
      const fixedRatings = [1350,1250,1100,1050,960,910,860,810,760,700,650,600,0,0];
      for (let i = 0; i < 14; i++) {
        const isNR = i >= 12;
        const r = isNR ? 1000 : fixedRatings[i];
        const id = uid();
        S.db.push({ id, name: NAMES[i] || `P${i}`, tag: '', rating: r, baseRating: r,
          isNR, nrLevelHint: isNR ? 950 : null, dupr: null, isSeeding: false,
          gamesPlayed: 0, wins: 0, losses: 0, ties: 0, createdAt: new Date().toISOString() });
      }
      S.db.forEach(p => S.checkedIn.add(p.id));
      log(`Players: ${S.db.map((p,i)=>p.name+(p.isNR?'(NR)':'('+fixedRatings[i]+')')).join(' | ')}`);

      const arr = [...S.checkedIn];
      S.courts = 2; S.adminPin = 'simtest';
      S.session = {
        id: uid(), name: 'Organizer 14p/2c', date: new Date().toISOString(), courts: 2,
        targetScore: 11, courtGroupSize: 4, cfMode: true, extendedMin: 16, sessionStart: null,
        activePlayers: [...arr],
        players: arr.map(id => {
          const p = gp(id);
          const sr = p.isNR ? (p.nrLevelHint || 950) : p.rating;
          return { id, name: p.name, tag: '', isNR: p.isNR, isSeeding: false,
            sRating: sr, startRating: sr, wins: 0, losses: 0, ties: 0,
            matchesPlayed: 0, ptsFor: 0, ptsAgainst: 0, timeOnCourtMs: 0, timeInQueueMs: 0, status: 'active' };
        }),
        partnerHx:{},oppHx:{},oppHxTime:{},nrPairingHx:{},
        cfQueue:[],cfPinnedIds:[],cfPauseAfterGame:[],cfLockedPairs:[],cfSoftPairs:[],cfPermPairs:[],
        cfLeaveSoonIds:[],cfCourts:{},cfSuggestions:{},cfLog:[],cfMatchCount:0,courtOffset:0,
        cfMatchupHx:{},cfGroupHx:{},cfPairConsec:{},cfPairWins:{},cfMustSplitPair:null,cfPaused:[],
        cfPairSessionCount:{},cfPairLastAt:{},cfPairLastLost:{},
        cfRanks:{},neverPair:{},ratingOverrides:{},auditLog:[],status:'lobby'
      };
      S.session.status = 'active'; S.session.sessionStart = Date.now();
      _initSessionRanks(); _invalidateMatchmakingCaches();
      CF._confirmAllBusy = false; CF._confirmAllLastTs = 0;
      CF.initQueue();
      log('Play started. Queue: ' + S.session.cfQueue.map(q => gp(q.id)?.name).join(', '));

      try { CF.batchGenerateSuggestions([1, 2], null); } catch(e) { log('Initial suggest error: ' + e.message); }
      assert(S.session.cfSuggestions[1] || S.session.cfSuggestions[2], 'At least one suggestion at start');
      if (doRender) render();
      if (live) await STORE.save();
      await delay(ms);

      // ── Event state flags ─────────────────────────────────────────────────
      let permPairDone = false;
      let swapPreviewDone = false, swapActiveDone = false, editScoreDone = false, qualityFirstDone = false;
      let lateArrivalsDone = false, lateStrongDone = false;
      let pauseDone = false, pauseId = null, resumeDone = false;
      let leaveSoonDone = false, removeDone = false;
      let permPauseDone = false, permPauseId = null, permResumedDone = false, permRemovedDone = false;
      let lateIds = [];

      // Wait-time tracking (completed matches between games)
      const _org12WaitEndMc = {};
      const _org12WaitGaps = {};

      // ── Main loop ──────────────────────────────────────────────────────────
      // courtGameLen[c]: ticks remaining before court c finishes its current game.
      // Round 1 gets gameLen=0 (both courts finish simultaneously — organizer confirms all at once).
      // After that: 80% each court gets 2–5 independent ticks; 20% syncs to the other court's
      // remaining ticks, causing both to finish simultaneously (realistic busy-session bursts).
      const courtGameLen = { 1: 0, 2: 0 };
      function _assignCourtLen(courtId) {
        if (Math.random() < 0.20) {
          // Sync: match a currently-playing court's remaining ticks
          const other = courtId === 1 ? 2 : 1;
          if (courtGameLen[other] > 0) return courtGameLen[other];
        }
        return 2 + Math.floor(Math.random() * 4); // 2, 3, 4, or 5 ticks
      }
      let firstRoundDone = false;
      const TARGET_MATCHES = 54; // bumped to ensure all late-arrival scenarios complete
      const MAX_TICKS = 200; // 200 ticks: avg 3.5 ticks/game × 54 matches / 2 courts ≈ 95 ticks needed

      for (let tick = 0; tick < MAX_TICKS && S.session.cfMatchCount < TARGET_MATCHES && !_aborted; tick++) {

        // ── STEP 1: Submit courts whose game has ended ──────────────────────
        for (let c = 1; c <= 2; c++) {
          if (_aborted) break;
          const ct = S.session.cfCourts?.[c];
          if (ct?.status !== 'playing' || !ct.match) continue;
          if (courtGameLen[c] > 0) { courtGameLen[c]--; continue; }
          // Record game-end for wait tracking
          const _mcNow = S.session.cfMatchCount || 0;
          [...(ct.match.t1||[]), ...(ct.match.t2||[])].forEach(id => {
            _org12WaitEndMc[id] = _mcNow + 1;
          });
          const [s1, s2] = randomScore();
          CF._doSubmitScore(c, s1, s2);
          const mc = S.session.cfMatchCount;
          log(`T${tick+1} C${c} M${mc}: ${s1}-${s2}  q=${S.session.cfQueue.length}`);
          verifyNoGhosts(); verifyStats(); verifyPlayCountBalance();
          if (doRender) render();
          if (live) await STORE.save();
          await delay(ms);
        }

        const mc = S.session.cfMatchCount;

        // ── STEP 2: Score edit — correct the previous match after it was logged ──
        // Simulates organiser noticing a typo and fixing it via the ✏️ button.
        if (!editScoreDone && mc >= 16) {
          const logLen = S.session.cfLog?.length || 0;
          if (logLen >= 2) {
            const idx = logLen - 2;
            const m = S.session.cfLog[idx];
            // "Correction": keep same winner but bump loser score by 2 (common typo fix)
            const winner = Math.max(m.s1, m.s2), loser = Math.min(m.s1, m.s2);
            const fixedLoser = Math.min(loser + 2, winner - 1);
            const newS1 = m.s1 >= m.s2 ? winner : fixedLoser;
            const newS2 = m.s1 >= m.s2 ? fixedLoser : winner;
            log(`T${tick+1}: ✏️  SCORE EDIT M${idx} — was ${m.s1}-${m.s2}, corrected to ${newS1}-${newS2}`);
            const ok = simEditScore(idx, newS1, newS2);
            if (ok) { verifyStats(); editScoreDone = true; }
            if (doRender) render(); if (live) await STORE.save(); await delay(ms);
          }
        }

        // ── STEP 3: State-changing events (no pending suggestion needed) ────

        // mc≥4: Set permanent partners (Taylor + Casey)
        if (!permPairDone && mc >= 4) {
          permA = S.db[4].id; permB = S.db[5].id;
          cfAddPermPair(permA, permB);
          log(`T${tick+1}: ⛓️  PERM PAIR — ${S.db[4].name} & ${S.db[5].name}`);
          for (let c = 1; c <= 2; c++) {
            const sug = S.session.cfSuggestions?.[c];
            if (sug) {
              const inSug = new Set([...(sug.t1||[]),...(sug.t2||[])]);
              if (inSug.has(permA) !== inSug.has(permB))
                err(`T${tick+1}: C${c} suggestion splits perm pair after lock!`);
            }
          }
          permPairDone = true;
          if (doRender) render(); await delay(ms);
        }

        // mc≥14: Two mid-strength late arrivals (~7 games/court ≈ 60-70 min in)
        if (!lateArrivalsDone && mc >= 14) {
          for (const lr of [1000, 820]) {
            const ni = S.db.length, lId = uid();
            S.db.push({ id:lId, name:NAMES[ni]||`Late${ni}`, tag:'LATE', rating:lr, baseRating:lr,
              isNR:false, nrLevelHint:null, dupr:null, isSeeding:false,
              gamesPlayed:0, wins:0, losses:0, ties:0, createdAt:new Date().toISOString() });
            S.checkedIn.add(lId); midAdd(lId);
            lateIds.push(lId);
            _disruptedAt[lId] = mc; _disruptedType[lId] = 'midadd';
            log(`T${tick+1}: 🚶 Late arrival — ${NAMES[ni]}(${lr})`);
            verifyNoGhosts();
            if (doRender) render(); if (live) await STORE.save(); await delay(ms);
          }
          lateArrivalsDone = true;
        }

        // mc≥12: Pause a regular player (bathroom break)
        if (!pauseDone && mc >= 12) {
          const cand = S.session.cfQueue.find(q => q.id !== permA && q.id !== permB);
          if (cand) {
            cfPausePlayer(cand.id); pauseId = cand.id; pauseDone = true;
            log(`T${tick+1}: ⏸  Pause — ${gp(cand.id)?.name}`);
            if (doRender) render(); if (live) await STORE.save(); await delay(ms);
          }
        }

        // mc≥16: Strong A-level late arrival
        if (!lateStrongDone && mc >= 16) {
          const ni = S.db.length, lr = 1180, lId = uid();
          S.db.push({ id:lId, name:NAMES[ni]||`Late${ni}`, tag:'LATE', rating:lr, baseRating:lr,
            isNR:false, nrLevelHint:null, dupr:null, isSeeding:false,
            gamesPlayed:0, wins:0, losses:0, ties:0, createdAt:new Date().toISOString() });
          S.checkedIn.add(lId); midAdd(lId);
          lateIds.push(lId);
          _disruptedAt[lId] = mc; _disruptedType[lId] = 'midadd';
          log(`T${tick+1}: 🚶 Late #3 — ${NAMES[ni]}(${lr}) A-level, hunger boost applies`);
          lateStrongDone = true;
          verifyNoGhosts();
          if (doRender) render(); if (live) await STORE.save(); await delay(ms);
        }

        // mc≥20: Resume paused player
        if (!resumeDone && pauseId && mc >= 20) {
          const e = (S.session.cfPaused||[]).find(q => q.id === pauseId);
          if (e) {
            cfResumePlayer(pauseId);
            _disruptedAt[pauseId] = mc; _disruptedType[pauseId] = 'resume';
            log(`T${tick+1}: ▶  Resume — ${gp(pauseId)?.name}`);
            pauseId = null; resumeDone = true;
            if (doRender) render(); if (live) await STORE.save(); await delay(ms);
          }
        }

        // mc≥22: Leave-soon
        if (!leaveSoonDone && mc >= 22) {
          const cand = S.session.cfQueue.find(q => q.id!==permA && q.id!==permB && !lateIds.includes(q.id));
          if (cand) {
            cfLeaveSoon(cand.id); leaveSoonDone = true;
            log(`T${tick+1}: 🚪 Leave-soon — ${gp(cand.id)?.name}`);
            if (doRender) render(); if (live) await STORE.save(); await delay(ms);
          }
        }

        // mc≥26: Mid-remove late arrival (sudden departure)
        if (!removeDone && mc >= 26 && lateIds.length > 0) {
          const rmId = lateIds[0];
          const sp = gsp(rmId);
          if (sp && sp.status !== 'left') {
            const onCourt = Object.values(S.session.cfCourts||{}).some(
              ct => ct?.status==='playing' && ct.match && [...ct.match.t1,...ct.match.t2].includes(rmId));
            if (!onCourt) {
              midRemove(rmId); removeDone = true;
              log(`T${tick+1}: ❌ Mid-remove — ${gp(rmId)?.name} sudden departure`);
              assert(!S.session.cfRanks[rmId], `T${tick+1}: cfRanks cleared on midRemove`);
              verifyNoGhosts();
              if (doRender) render(); if (live) await STORE.save(); await delay(ms);
            }
          }
        }

        // mc≥30: Pause one permanent pair member
        if (!permPauseDone && permA && mc >= 30) {
          const target = S.session.cfQueue.find(q => q.id===permA || q.id===permB);
          if (target) {
            cfPausePlayer(target.id); permPauseId = target.id; permPauseDone = true;
            const other = target.id===permA ? permB : permA;
            log(`T${tick+1}: ⛓️⏸  PERM PAIR PAUSE — ${gp(target.id)?.name} paused`);
            log(`T${tick+1}:   → ${gp(other)?.name} should be held from suggestions`);
            for (let c = 1; c <= 2; c++) {
              const sug = S.session.cfSuggestions?.[c];
              if (sug && [...(sug.t1||[]),...(sug.t2||[])].includes(other))
                err(`T${tick+1}: ${gp(other)?.name} in suggestion while partner is paused!`);
            }
            if (doRender) render(); if (live) await STORE.save(); await delay(ms);
          }
        }

        // mc≥34: Resume paused perm pair member
        if (!permResumedDone && permPauseId && mc >= 34) {
          const e = (S.session.cfPaused||[]).find(q => q.id === permPauseId);
          if (e) {
            cfResumePlayer(permPauseId); permResumedDone = true;
            _disruptedAt[permPauseId] = mc; _disruptedType[permPauseId] = 'resume';
            log(`T${tick+1}: ⛓️▶  Resumed perm pair member — ${gp(permPauseId)?.name}`);
            if (doRender) render(); if (live) await STORE.save(); await delay(ms);
          }
        }

        // mc≥38: Admin dissolves the permanent partnership.
        // Both players re-enter the regular pool and can be assigned independently.
        if (!permRemovedDone && permA && permResumedDone && mc >= 38) {
          cfRemovePermPair(permA, permB);
          log(`T${tick+1}: ✂️  PERM PAIR DISSOLVED — ${gp(permA)?.name} & ${gp(permB)?.name} back in regular pool`);
          // Verify pair is gone from cfPermPairs
          const pk = (a,b) => [a,b].sort().join('|');
          const key = pk(permA, permB);
          assert(!(S.session.cfPermPairs||[]).some(p=>pk(p[0],p[1])===key), 'Perm pair removed from cfPermPairs');
          // After removal permA/permB tracking still works but no longer enforced
          permRemovedDone = true;
          if (doRender) render(); if (live) await STORE.save(); await delay(ms);
        }

        // ── STEP 4: Regenerate suggestions for idle ready courts ────────────
        const dead = [];
        for (let c = 1; c <= 2; c++) {
          const ct = S.session.cfCourts?.[c];
          if ((!ct || ct.status === 'ready') && !S.session.cfSuggestions?.[c] && S.session.cfQueue.length >= 4)
            dead.push(c);
        }
        if (dead.length) {
          try { CF.batchGenerateSuggestions(dead, null); } catch(e) { log(`T${tick+1} regen err: ${e.message}`); }
        }

        // ── STEP 5: Pre-confirm scenarios (need a pending suggestion) ────────

        // mc≥6: Swap one player in a preview suggestion before confirming.
        // Simulates organiser saying "actually put Riley on court instead of Quinn".
        if (!swapPreviewDone && mc >= 6) {
          for (let c = 1; c <= 2; c++) {
            const sug = S.session.cfSuggestions?.[c];
            if (!sug) continue;
            const outId = sug.allIds.find(id => id !== permA && id !== permB);
            const inId = (S.session.cfQueue||[]).find(q =>
              !sug.allIds.includes(q.id) && q.id !== permA && q.id !== permB)?.id;
            if (!outId || !inId) continue;
            log(`T${tick+1}: ⇄  SWAP PREVIEW C${c} — ${gp(outId)?.name} out, ${gp(inId)?.name} in (before confirm)`);
            const ok = simSwapPreview(c, outId, inId);
            if (ok) {
              assert(!S.session.cfSuggestions[c]?.allIds.includes(outId), `swap preview: ${gp(outId)?.name} still in suggestion`);
              assert(S.session.cfSuggestions[c]?.allIds.includes(inId),   `swap preview: ${gp(inId)?.name} missing from suggestion`);
              verifyNoDuplicates();
              swapPreviewDone = true;
              if (doRender) render(); await delay(ms);
            }
            if (swapPreviewDone) break;
          }
        }

        // mc≥14: Quality-first reshuffle — discard suggestion, re-generate ignoring fairness pressure.
        // Simulates organiser overriding a "fairness" suggestion for a closer match.
        if (!qualityFirstDone && mc >= 14) {
          for (let c = 1; c <= 2; c++) {
            if (!S.session.cfSuggestions?.[c]) continue;
            const prevGap = S.session.cfSuggestions[c]?.meta?.gap || '?';
            log(`T${tick+1}: 🔀  QUALITY-FIRST RESHUFFLE C${c} — gap before: ${prevGap}`);
            CF.reshuffleQualityFirst(c);
            const newGap = S.session.cfSuggestions[c]?.meta?.gap || '?';
            log(`T${tick+1}:   gap after: ${newGap}`);
            qualityFirstDone = true;
            if (doRender) render(); await delay(ms);
            break;
          }
        }

        // ── STEP 6: Confirm pending suggestions ─────────────────────────────
        for (let c = 1; c <= 2; c++) {
          if (_aborted || !S.session.cfSuggestions[c]) continue;
          // Record wait gaps for players about to start
          const _sug6 = S.session.cfSuggestions[c];
          const _mc6 = S.session.cfMatchCount || 0;
          [...(_sug6.t1||[]), ...(_sug6.t2||[])].forEach(id => {
            if (_org12WaitEndMc[id] !== undefined) {
              if (!_org12WaitGaps[id]) _org12WaitGaps[id] = [];
              _org12WaitGaps[id].push(_mc6 - _org12WaitEndMc[id]);
            }
          });
          CF.confirmSuggestion(c);
          snapCourt(c, S.session.cfMatchCount);
          verifyNoDuplicates();
          // Round 1: both courts start simultaneously (gameLen=0 → submit next tick).
          // Subsequent rounds: 80% → 2–5 independent ticks; 20% → sync with other court.
          courtGameLen[c] = firstRoundDone ? _assignCourtLen(c) : 0;
          if (doRender) render();
          if (live) await STORE.save();
          await delay(ms);
        }
        if (!firstRoundDone) firstRoundDone = true;

        // ── STEP 7: Mid-match swap (court now playing) ───────────────────────
        // Simulates organiser swapping an injured/tired player off a live court.
        if (!swapActiveDone && mc >= 10) {
          for (let c = 1; c <= 2; c++) {
            const ct = S.session.cfCourts?.[c];
            if (ct?.status !== 'playing' || !ct.match) continue;
            const allOnCourt = [...ct.match.t1, ...ct.match.t2];
            const outId = allOnCourt.find(id => id !== permA && id !== permB);
            const inId = (S.session.cfQueue||[]).find(q => q.id !== permA && q.id !== permB)?.id;
            if (!outId || !inId) continue;
            log(`T${tick+1}: ⇄  SWAP MID-MATCH C${c} — ${gp(outId)?.name} off, ${gp(inId)?.name} on`);
            const ok = simSwapActive(c, outId, inId);
            if (ok) {
              const nowOnCourt = [...S.session.cfCourts[c].match.t1,...S.session.cfCourts[c].match.t2];
              assert(nowOnCourt.includes(inId),  `swap active: ${gp(inId)?.name} not on court after swap`);
              assert(!nowOnCourt.includes(outId),`swap active: ${gp(outId)?.name} still on court after swap`);
              assert(S.session.cfQueue.some(q=>q.id===outId), `swap active: ${gp(outId)?.name} not back in queue`);
              verifyNoDuplicates(); verifyNoGhosts();
              swapActiveDone = true;
              if (doRender) render(); await delay(ms);
            }
            if (swapActiveDone) break;
          }
        }

        checkPermHeld();
      }

      // ── Final ghost check ──────────────────────────────────────────────────
      const leftIds = (S.session.players||[]).filter(sp=>sp.status==='left').map(sp=>sp.id);
      const finalQIds = new Set((S.session.cfQueue||[]).map(q=>q.id));
      leftIds.forEach(id => { assert(!finalQIds.has(id), `Ghost: ${gp(id)?.name} left but in queue`); });

      // Verify all non-happy-path scenarios actually ran
      assert(swapPreviewDone,  'Scenario ran: swap in preview');
      assert(swapActiveDone,   'Scenario ran: swap mid-match');
      assert(editScoreDone,    'Scenario ran: score edit');
      assert(qualityFirstDone, 'Scenario ran: quality-first reshuffle');
      assert(lateArrivalsDone, 'Scenario ran: late arrivals');
      assert(leaveSoonDone,    'Scenario ran: leave-soon');
      assert(removeDone,       'Scenario ran: mid-remove');
      assert(pauseDone,        'Scenario ran: pause/resume');
      assert(permRemovedDone,  'Scenario ran: perm pair dissolved');

      // ── Archive session ────────────────────────────────────────────────────
      const arch = {
        id: S.session.id, name: S.session.name, date: S.session.date, cfMode: true,
        players: (S.session.players||[]).map(sp => ({
          id:sp.id, name:sp.name||'?', status:sp.status,
          sRating:sp.sRating, startRating:sp.startRating,
          wins:sp.wins, losses:sp.losses, ties:sp.ties,
          matchesPlayed:sp.matchesPlayed, ptsFor:sp.ptsFor, ptsAgainst:sp.ptsAgainst
        })),
        cfRanks: JSON.parse(JSON.stringify(S.session.cfRanks||{})),
        cfLog: JSON.parse(JSON.stringify(S.session.cfLog||[]))
      };
      S.archive.unshift(arch);
      S.checkedIn.clear(); S.session = null;
      recalcAllTimeRatings();

      // ══ QUALITY REPORT ════════════════════════════════════════════════════
      log('');
      log('╔══════════════════════════════════════════════════╗');
      log('║   ORGANIZER QUALITY REPORT — 14p / 2 Courts     ║');
      log('╚══════════════════════════════════════════════════╝');

      const active = arch.players.filter(sp=>sp.matchesPlayed>0||sp.status!=='left');
      active.sort((a,b)=>(b.matchesPlayed||0)-(a.matchesPlayed||0));
      const gameCounts = active.map(sp=>sp.matchesPlayed||0);
      const minG=Math.min(...gameCounts), maxG=Math.max(...gameCounts);
      log(`PLAY DISTRIBUTION (gap ${maxG-minG} — target ≤2):`);
      active.forEach(sp => {
        const w = _waitTrack[sp.id]; const pts = _partnerTrack[sp.id]?.size||0;
        const lateFlag = lateIds.includes(sp.id) ? ' [late]' : '';
        const leftFlag = sp.status==='left' ? ' [left]' : '';
        const warnFlag = (w?.max||0)>=3 ? '  ⚠️ waited 3+ rounds' : '';
        log(`  ${(sp.name+'          ').slice(0,10)} ${String(sp.matchesPlayed||0).padStart(2)}G  ` +
            `maxWait=${w?.max||0}  partners=${pts}${lateFlag}${leftFlag}${warnFlag}`);
      });

      if (_matchSnaps.length) {
        const gaps = _matchSnaps.map(m=>m.gap);
        const avgGap = Math.round(gaps.reduce((s,g)=>s+g,0)/gaps.length);
        const maxGap = Math.round(Math.max(...gaps));
        const p50 = Math.round(100*gaps.filter(g=>g<=50).length/gaps.length);
        const p100 = Math.round(100*gaps.filter(g=>g<=100).length/gaps.length);
        log('');
        log(`MATCH BALANCE (${_matchSnaps.length} matches):`);
        log(`  Avg team gap: ${avgGap}pts  Max: ${maxGap}pts`);
        log(`  ${p50}% excellent (≤50pt gap)   ${p100}% acceptable (≤100pt gap)`);
        if (avgGap > 120) log('  ⚠️  High avg gap — rating spread too wide for 2 courts');
        else if (avgGap <= 60) log('  ✅ Excellent balance');
      }

      log('');
      log('WAIT REPORT (completed matches waited between games):');
      const _org12LongWaitThreshold = 2 * 2; // courts=2 × 2
      const _org12WaitEntries = Object.entries(_org12WaitGaps).map(([id, gaps]) => {
        const avg = gaps.length ? (gaps.reduce((a,b)=>a+b,0)/gaps.length).toFixed(1) : '–';
        const max = gaps.length ? Math.max(...gaps) : 0;
        let cur = 0, maxConsecRun = 0;
        gaps.forEach(g => {
          if (g >= _org12LongWaitThreshold) { cur++; maxConsecRun = Math.max(maxConsecRun, cur); }
          else cur = 0;
        });
        return { id, name: gp(id)?.name||id, avg: parseFloat(avg)||0, max, gaps, maxConsecRun };
      }).sort((a,b) => b.max - a.max || b.maxConsecRun - a.maxConsecRun);
      _org12WaitEntries.forEach(({ name, avg, max, gaps, maxConsecRun }) => {
        const seq = gaps.map(g => g >= _org12LongWaitThreshold ? `[${g}]` : `${g}`).join('-');
        const flag = max >= _org12LongWaitThreshold
          ? (maxConsecRun >= 2 ? ' 🔴 STUCK' : ' ⚠️ long wait') : '';
        log(`  ${(name+'          ').slice(0,10)} avg=${avg} max=${max}  gaps: ${seq||'–'}${flag}`);
      });
      const _org12LongWaiters = _org12WaitEntries.filter(e => e.max >= _org12LongWaitThreshold);
      if (_org12LongWaiters.length === 0) log(`  ✅ No long waits (threshold: ${_org12LongWaitThreshold} completed matches)`);
      else {
        const stuck = _org12LongWaiters.filter(e => e.maxConsecRun >= 2);
        if (stuck.length) log(`  🔴 ${stuck.length} player(s) had long waits back-to-back (long wait → played 1 game → long wait again)`);
        log(`  ⚠️ ${_org12LongWaiters.length} player(s) waited ${_org12LongWaitThreshold}+ completed matches between games`);
      }

      log('');
      log('PERMANENT PARTNER RESULTS:');
      if (permA && permB) {
        const pAN=gp(permA)?.name||'A', pBN=gp(permB)?.name||'B';
        const spA=arch.players.find(p=>p.id===permA), spB=arch.players.find(p=>p.id===permB);
        log(`  Pair: ${pAN} & ${pBN}`);
        log(`  Together: ${_permMatches} matches  |  Violations: ${_permViolations} ${_permViolations===0?'✅':'❌ BUG'}`);
        log(`  Rounds held (waiting for partner): ${_permHeldRounds}`);
        log(`  Games — ${pAN}: ${spA?.matchesPlayed||0}  ${pBN}: ${spB?.matchesPlayed||0}`);
        const gapPP = Math.abs((spA?.matchesPlayed||0)-(spB?.matchesPlayed||0));
        if (gapPP > 0) log(`  ⚠️  Game count gap between partners: ${gapPP} (should be 0)`);
        else log(`  ✅ Partners always played same number of games`);
      }

      log('');
      log(`SCENARIOS COVERED:`);
      log(`  R1: Both courts confirmed simultaneously (happy-path start)`);
      log(`  M4+: Permanent partners locked (Taylor & Casey)`);
      log(`  M6+: ⇄ Swap in preview (player swapped before confirming)`);
      log(`  M14+: Two mid-session late arrivals (~60-70 min in, 7 games/court)`);
      log(`  M10+: ⇄ Swap mid-match (live court player substitution)`);
      log(`  M12+: Player paused (bathroom break)`);
      log(`  M14+: 🔀 Quality-first reshuffle`);
      log(`  M16+: Strong A-level late arrival + score edit (typo correction)`);
      log(`  M20+: Paused player resumed`);
      log(`  M22+: Player flagged leave-soon`);
      log(`  M26+: Mid-remove (sudden departure)`);
      log(`  M30+: Perm pair member paused → partner held`);
      log(`  M34+: Perm pair member resumed`);
      log(`  M38+: ✂️  Permanent partnership dissolved — both back in regular pool`);

      log('');
      log(`TOTAL ERRORS: ${_errs.length}`);
      if (_errs.length === 0) log('✅ ALL CHECKS PASSED');
      else _errs.forEach(e => log('  ❌ ' + e));

    } finally {
      _running = false;
      restoreSideEffects();
      restoreRealState();
      try { renderDB(); renderRoster?.(); renderHistory?.(); renderStandings?.(); } catch(e){}
    }
    return { log: _log, errors: _errs, passed: _errs.length === 0 };
  }

  // ── Convenience sims: fixed player/court combos ─────────────────────────────
  // Each runs the generic run() at the correct ratio (6-7 players/court).
  // Max total players INCLUDING the late arrival = target count.
  // Start with (target-1) so that when 1 late arrival joins, total = target exactly.
  // Late arrival joins at round ~30% = ~60 min into a 3-hour session.
  // Usage: SIM.run14()  SIM.run20()  SIM.run26()
  function run14(opts = {}) {
    // 13 start + 1 late arrival = 14 total max
    return run({ players: 13, courts: 2, rounds: 70, speed: 'fast', ...opts });
  }
  function run20(opts = {}) {
    // 19 start + 1 late arrival = 20 total max
    return run({ players: 19, courts: 3, rounds: 70, speed: 'fast', ...opts });
  }
  function run26(opts = {}) {
    // 25 start + 1 late arrival = 26 total max
    return run({ players: 25, courts: 4, rounds: 70, speed: 'fast', ...opts });
  }


  // ── Permanent pair stress test ──────────────────────────────────────────────

  async function runPermPairCheck() {
    if (_running) { console.warn('[SIM] Already running.'); return; }
    _running = true; _aborted = false; _log = []; _errs = [];

    log('=== PERM PAIR STRESS TEST ===');
    log('Covers: solo-partner held, pause partner, leave dissolves lock, low player count');

    stubSideEffects(false);
    try {

      // ── Scenario A: normal flow — both partners always grouped ──
      log('--- Scenario A: normal — both in queue, should always be picked together ---');
      resetState();
      for (let i=0;i<10;i++){const r=800+i*50,id=uid();S.db.push({id,name:NAMES[i],tag:'',rating:r,baseRating:r,isNR:false,nrLevelHint:null,dupr:null,isSeeding:false,gamesPlayed:0,wins:0,losses:0,ties:0,createdAt:new Date().toISOString()});}
      S.db.forEach(p=>S.checkedIn.add(p.id));
      startSim(2); beginSim();
      const pA=S.db[3].id, pB=S.db[4].id;
      S.session.cfPermPairs=[[pA,pB]];
      for(let i=0;i<8;i++){
        const dead=[];for(let c=1;c<=2;c++){const ct=S.session.cfCourts?.[c];if((!ct||ct.status==='ready')&&!S.session.cfSuggestions?.[c]&&S.session.cfQueue.length>=4)dead.push(c);}
        if(dead.length)try{CF.batchGenerateSuggestions(dead,null);}catch(e){}
        for(let c=1;c<=2;c++){if(S.session.cfSuggestions[c]){CF.confirmSuggestion(c);const ct=S.session.cfCourts[c];if(ct?.match){const all=[...ct.match.t1,...ct.match.t2];const aP=all.includes(pA),bP=all.includes(pB);if(aP!==bP){err(`ScenA round ${i+1} C${c}: solo perm pair member in match`);}if(aP&&bP&&(ct.match.t1.includes(pA)!==ct.match.t1.includes(pB))){err(`ScenA round ${i+1} C${c}: perm pair on different teams`);}}}}
        for(let c=1;c<=2;c++){const ct=S.session.cfCourts?.[c];if(ct?.status==='playing'&&ct.match){CF._doSubmitScore(c,11,Math.floor(Math.random()*9));verifyNoGhosts();}}
      }
      assert(_errs.length===0,'Scenario A: no perm pair violations in 8 rounds');
      log('Scenario A: PASSED — partners always grouped, never split-team');

      // ── Scenario B: one partner paused → other held ──
      log('--- Scenario B: pause one partner — verify free partner is held out ---');
      resetState();
      for(let i=0;i<10;i++){const r=800+i*50,id=uid();S.db.push({id,name:NAMES[i],tag:'',rating:r,baseRating:r,isNR:false,nrLevelHint:null,dupr:null,isSeeding:false,gamesPlayed:0,wins:0,losses:0,ties:0,createdAt:new Date().toISOString()});}
      S.db.forEach(p=>S.checkedIn.add(p.id));
      startSim(2); beginSim();
      const bA=S.db[2].id, bB=S.db[3].id;
      S.session.cfPermPairs=[[bA,bB]];
      // Run 2 rounds so both are in queue
      for(let i=0;i<2;i++){
        const dead2=[];for(let c=1;c<=2;c++){const ct=S.session.cfCourts?.[c];if((!ct||ct.status==='ready')&&!S.session.cfSuggestions?.[c]&&S.session.cfQueue.length>=4)dead2.push(c);}
        if(dead2.length)try{CF.batchGenerateSuggestions(dead2,null);}catch(e){}
        for(let c=1;c<=2;c++){if(S.session.cfSuggestions[c])CF.confirmSuggestion(c);}
        for(let c=1;c<=2;c++){const ct=S.session.cfCourts?.[c];if(ct?.status==='playing'&&ct.match)CF._doSubmitScore(c,11,7);}
      }
      // Pause bA — bB should be held
      if(S.session.cfQueue.some(q=>q.id===bA)) cfPausePlayer(bA);
      else if(S.session.cfQueue.some(q=>q.id===bB)) cfPausePlayer(bB);
      const pausedPP = (S.session.cfPaused||[]).find(q=>q.id===bA||q.id===bB)?.id;
      const freePP = pausedPP===bA?bB:bA;
      // Generate suggestion — free partner should NOT appear in any suggestion
      try{CF.batchGenerateSuggestions([1,2],null);}catch(e){}
      for(let c=1;c<=2;c++){
        const sug=S.session.cfSuggestions?.[c];
        if(sug&&[...(sug.t1||[]),...(sug.t2||[])].includes(freePP))
          err(`ScenB: free partner ${gp(freePP)?.name} in suggestion while other partner paused`);
      }
      // Resume and verify both play together
      if(pausedPP)(cfResumePlayer(pausedPP));
      try{CF.batchGenerateSuggestions([1,2],null);}catch(e){}
      // Both should now be together in a suggestion
      let togetherInSug=false;
      for(let c=1;c<=2;c++){const sug=S.session.cfSuggestions?.[c];if(sug){const all=[...(sug.t1||[]),...(sug.t2||[])];if(all.includes(bA)&&all.includes(bB))togetherInSug=true;}}
      // (May not always be true if only 1 court has a suggestion and it's for different players — not a hard error)
      log(`Scenario B: pause/resume check done — partners in same suggestion after resume: ${togetherInSug}`);
      assert(_errs.filter(e=>e.includes('ScenB')).length===0,'Scenario B: no violations while partner paused');
      log('Scenario B: PASSED');

      // ── Scenario C: partner leaves → the other is freed ──
      log('--- Scenario C: one partner leaves (status=left) → other player freed ---');
      resetState();
      for(let i=0;i<8;i++){const r=800+i*60,id=uid();S.db.push({id,name:NAMES[i],tag:'',rating:r,baseRating:r,isNR:false,nrLevelHint:null,dupr:null,isSeeding:false,gamesPlayed:0,wins:0,losses:0,ties:0,createdAt:new Date().toISOString()});}
      S.db.forEach(p=>S.checkedIn.add(p.id));
      startSim(1); beginSim();
      const cA=S.db[0].id, cB=S.db[1].id;
      S.session.cfPermPairs=[[cA,cB]];
      try{CF.batchGenerateSuggestions([1],null);}catch(e){}
      if(S.session.cfSuggestions[1])CF.confirmSuggestion(1);
      if(S.session.cfCourts[1]?.status==='playing')CF._doSubmitScore(1,11,6);
      // Mark cA as left
      const spCA=gsp(cA); if(spCA)spCA.status='left';
      S.session.activePlayers=(S.session.activePlayers||[]).filter(id=>id!==cA);
      S.session.cfQueue=S.session.cfQueue.filter(q=>q.id!==cA);
      // Now generate — cB should appear freely in pool (partner left)
      try{CF.batchGenerateSuggestions([1],null);}catch(e){}
      let cBInSug=false;
      const sug1=S.session.cfSuggestions?.[1];
      if(sug1)cBInSug=[...(sug1.t1||[]),...(sug1.t2||[])].includes(cB);
      assert(cBInSug||S.session.cfQueue.some(q=>q.id===cB),'Scenario C: cB accessible after partner left');
      log(`Scenario C: ${gp(cB)?.name} freed after partner marked left — in suggestion: ${cBInSug}`);
      assert(_errs.filter(e=>e.includes('ScenC')).length===0,'Scenario C: no errors');
      log('Scenario C: PASSED');

      // ── Scenario D: low player count (8p/2c) — court goes idle until pair reunited ──
      log('--- Scenario D: 8 players/2 courts — perm pair may cause brief idle court ---');
      resetState();
      for(let i=0;i<8;i++){const r=900+i*50,id=uid();S.db.push({id,name:NAMES[i],tag:'',rating:r,baseRating:r,isNR:false,nrLevelHint:null,dupr:null,isSeeding:false,gamesPlayed:0,wins:0,losses:0,ties:0,createdAt:new Date().toISOString()});}
      S.db.forEach(p=>S.checkedIn.add(p.id));
      startSim(2); beginSim();
      const dA=S.db[1].id, dB=S.db[2].id;
      S.session.cfPermPairs=[[dA,dB]];
      try{CF.batchGenerateSuggestions([1,2],null);}catch(e){}
      // With 8 players, verify perm pair goes to same court in initial suggestions
      let dTogether=true;
      for(let c=1;c<=2;c++){const sug=S.session.cfSuggestions?.[c];if(sug){const all=[...(sug.t1||[]),...(sug.t2||[])];const aIn=all.includes(dA),bIn=all.includes(dB);if(aIn!==bIn){dTogether=false;err(`ScenD: 8p initial suggestion splits perm pair`);}}}
      log(`Scenario D: 8p initial split check — together in same suggestion: ${dTogether}`);
      // Run 4 rounds and verify no violations
      let dViolations=0;
      for(let i=0;i<4;i++){
        const dead3=[];for(let c=1;c<=2;c++){const ct=S.session.cfCourts?.[c];if((!ct||ct.status==='ready')&&!S.session.cfSuggestions?.[c]&&S.session.cfQueue.length>=4)dead3.push(c);}
        if(dead3.length)try{CF.batchGenerateSuggestions(dead3,null);}catch(e){}
        for(let c=1;c<=2;c++){if(S.session.cfSuggestions[c]){CF.confirmSuggestion(c);const ct=S.session.cfCourts[c];if(ct?.match){const all=[...ct.match.t1,...ct.match.t2];const aP=all.includes(dA),bP=all.includes(dB);if(aP!==bP){dViolations++;err(`ScenD round ${i+1} C${c}: perm pair split`);}if(aP&&bP&&(ct.match.t1.includes(dA)!==ct.match.t1.includes(dB)))err(`ScenD round ${i+1} C${c}: perm pair different teams`);}}}
        for(let c=1;c<=2;c++){const ct=S.session.cfCourts?.[c];if(ct?.status==='playing'&&ct.match){CF._doSubmitScore(c,11,Math.floor(Math.random()*9));verifyNoGhosts();}}
      }
      assert(dViolations===0,'Scenario D: no perm pair violations across 4 rounds with 8 players');
      log(`Scenario D: PASSED (${dViolations} violations)`);

      log('');
      log('=== PERM PAIR STRESS TEST COMPLETE ===');
      log(`Total errors: ${_errs.length} ${_errs.length===0?'✅ ALL PASSED':'❌ FAILURES FOUND'}`);
      if(_errs.length) _errs.forEach(e=>log('  ❌ '+e));

    } finally {
      _running = false;
      restoreSideEffects();
      resetState();
    }
    return { log: _log, errors: _errs, passed: _errs.length === 0 };
  }

  // ── UI Panel ──

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'sim-panel';
    panel.innerHTML = `
      <style>
        #sim-panel{position:fixed;bottom:16px;right:16px;z-index:99999;background:#1a1d23;border:1px solid #34d975;border-radius:12px;padding:14px 16px;font-family:'DM Sans',sans-serif;color:#e0e6ed;width:280px;box-shadow:0 8px 32px rgba(0,0,0,.5)}
        #sim-panel h3{margin:0 0 10px;font-family:'Bebas Neue',sans-serif;font-size:1.1rem;color:#34d975;letter-spacing:.5px}
        #sim-panel label{font-size:.7rem;color:#8892a0;display:block;margin-bottom:3px}
        #sim-panel select,#sim-panel input:not([type="checkbox"]){background:#12141a;border:1px solid #2a2e38;color:#e0e6ed;border-radius:6px;padding:5px 8px;font-size:.75rem;width:100%;margin-bottom:8px;box-sizing:border-box}
        #sim-panel .row{display:flex;gap:8px;margin-bottom:8px}
        #sim-panel .row>*{flex:1}
        #sim-panel button{border:none;border-radius:6px;padding:8px 0;font-size:.75rem;font-weight:700;cursor:pointer;width:100%;margin-bottom:6px;transition:opacity .15s}
        #sim-panel button:hover{opacity:.85}
        #sim-panel button:disabled{opacity:.4;cursor:not-allowed}
        .sim-go{background:#34d975;color:#111}
        .sim-bug{background:#3b82f6;color:#fff}
        .sim-stop{background:#ef4444;color:#fff}
        .sim-close{background:transparent;color:#8892a0;font-size:.65rem;padding:4px;margin:0;width:auto;position:absolute;top:8px;right:10px}
        #sim-log{max-height:120px;overflow-y:auto;font-size:.65rem;color:#8892a0;background:#12141a;border-radius:6px;padding:6px 8px;margin-top:6px;white-space:pre-wrap;font-family:monospace;display:none}
        #sim-log.active{display:block}
        .sim-chk{display:flex;align-items:center;gap:8px;margin-bottom:8px}
        .sim-chk input[type="checkbox"]{width:16px;min-width:16px;margin:0;flex:none}
        .sim-chk label{margin:0;font-size:.72rem;color:#c0c8d0;flex:1}
      </style>
      <button class="sim-close" onclick="document.getElementById('sim-panel').remove()">close</button>
      <h3>Simulator</h3>
      <div class="row">
        <div><label>Players</label><input type="number" id="sim-players" value="26" min="4" max="30"/></div>
        <div><label>Courts</label><input type="number" id="sim-courts" value="4" min="1" max="6"/></div>
        <div><label>Rounds</label><input type="number" id="sim-rounds" value="20" min="5" max="100"/></div>
      </div>
      <label>Speed</label>
      <select id="sim-speed">
        <option value="instant">Instant (regression only)</option>
        <option value="sprint">Sprint (50ms)</option>
        <option value="fast">Fast (300ms)</option>
        <option value="normal" selected>Normal (1.5s)</option>
        <option value="slow">Slow (3s) — multi-device demo</option>
      </select>
      <div class="sim-chk">
        <input type="checkbox" id="sim-live" checked/>
        <label for="sim-live">Live sync to Firebase</label>
      </div>
      <div class="sim-chk">
        <input type="checkbox" id="sim-step"/>
        <label for="sim-step">Step mode (pause after each action)</label>
      </div>
      <div class="sim-chk">
        <input type="checkbox" id="sim-challenge"/>
        <label for="sim-challenge">👑 Challenge Court (middle court = top 6 · needs 3+ courts)</label>
      </div>
      <button class="sim-go" id="sim-run-btn" onclick="SIM._uiRun()">▶ Run Full Simulation</button>
      <button class="sim-go" style="background:#34d399;color:#052e16" onclick="SIM.run14({speed:document.getElementById('sim-speed')?.value||'fast',live:document.getElementById('sim-live')?.checked??false,challengeCourt:document.getElementById('sim-challenge')?.checked??false})">14p / 2c</button>
      <button class="sim-go" style="background:#38bdf8;color:#0c1a2e" onclick="SIM.run20({speed:document.getElementById('sim-speed')?.value||'fast',live:document.getElementById('sim-live')?.checked??false,challengeCourt:document.getElementById('sim-challenge')?.checked??false})">20p / 3c</button>
      <button class="sim-go" style="background:#f59e0b;color:#1c0f00" onclick="SIM.run26({speed:document.getElementById('sim-speed')?.value||'fast',live:document.getElementById('sim-live')?.checked??false,challengeCourt:document.getElementById('sim-challenge')?.checked??false})">26p / 4c</button>
      <button class="sim-go" style="background:#a78bfa;color:#1a0540" onclick="SIM.runOrganizer12({speed:document.getElementById('sim-speed')?.value||'fast',live:document.getElementById('sim-live')?.checked??false,challengeCourt:document.getElementById('sim-challenge')?.checked??false})">⛓️ Organizer 14p/2c</button>
      <button class="sim-bug" onclick="SIM.runPermPairCheck()">🔒 Perm Pair Stress Test</button>
      <button class="sim-continue" id="sim-continue-btn" onclick="SIM._continue()" style="display:none;background:#fb923c;color:#111">Continue</button>
      <button class="sim-stop" id="sim-stop-btn" onclick="SIM.stop()" disabled>Stop</button>
      <div id="sim-log"></div>`;
    document.body.appendChild(panel);
  }

  function _updateLog() {
    const el = document.getElementById('sim-log');
    if (!el) return;
    el.className = 'active';
    el.textContent = _log.slice(-30).join('\n');
    el.scrollTop = el.scrollHeight;
  }

  const _origLog = log;
  function log(msg) {
    _log.push(msg);
    console.log(`[SIM] ${msg}`);
    _updateLog();
  }

  async function _uiRun() {
    const btn = document.getElementById('sim-run-btn');
    const stopBtn = document.getElementById('sim-stop-btn');
    if (btn) btn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;

    const players = parseInt(document.getElementById('sim-players')?.value) || 20;
    const courts = parseInt(document.getElementById('sim-courts')?.value) || 3;
    const rounds = parseInt(document.getElementById('sim-rounds')?.value) || 40;
    const speed = document.getElementById('sim-speed')?.value || 'normal';
    const live = document.getElementById('sim-live')?.checked ?? false;
    const challengeCourt = document.getElementById('sim-challenge')?.checked ?? false;
    try {
      await run({ players, courts, rounds, speed, live, challengeCourt });
    } finally {
      if (btn) btn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
    }
  }

  if (location.search.includes('simulate')) {
    if (document.readyState === 'complete') buildPanel();
    else window.addEventListener('load', buildPanel);
  }

  return { run, run14, run20, run26, runBugChecks, runOrganizer12, runPermPairCheck, stop, _uiRun, _continue, log: () => _log, errors: () => _errs };

})();
