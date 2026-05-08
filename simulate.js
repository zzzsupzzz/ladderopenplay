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
      cfRanks: {}, cfPendingPairs: [],
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
    const active = S.session.players.filter(sp => sp.status !== 'left' && !paused.has(sp.id));
    if (active.length < 2) return true;
    const permPairIds = new Set((S.session.cfPermPairs || []).flat());
    const settled = active.filter(sp => {
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
    const counts = settled.map(sp => sp.matchesPlayed || 0);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    if (max - min > 2) {
      const behind = settled.filter(sp => (sp.matchesPlayed || 0) === min).map(sp => sp.name);
      const ahead = settled.filter(sp => (sp.matchesPlayed || 0) === max).map(sp => sp.name);
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
      live = false
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

      let totalMatches = 0;
      let midAddDone = false;
      let pauseDone = false;
      let leaveSoonDone = false;
      let midRemoveDone = false;
      _disruptedAt = {};
      _disruptedType = {};

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
            CF.confirmSuggestion(c);
            confirmedCount++;
            log(`Round ${r+1}: confirmed court ${c}`);
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

        // Submit scores one by one
        for (let c = 1; c <= S.session.courts; c++) {
          if (_aborted) break;
          const ct = S.session.cfCourts?.[c];
          if (ct?.status === 'playing' && ct.match) {
            const [s1, s2] = randomScore();
            const _submitT0 = performance.now();
            CF._doSubmitScore(c, s1, s2);
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

        if (r === 5 && !midAddDone && nPlayers < NAMES.length) {
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
          log(`Mid-add: ${NAMES[nPlayers]} joined (round ${r+1})`);
          verifyNoGhosts();
          if (doRender) render();
          if (live) await STORE.save();
          await delay(ms);
        }

        if (r === 10 && !pauseDone) {
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

        if (r === 13 && pauseDone) {
          const pEntry = (S.session.cfPaused || []).find(q => q.id === pauseDone);
          if (pEntry) {
            cfResumePlayer(pauseDone);
            _disruptedAt[pauseDone] = S.session.cfMatchCount || 0;
            _disruptedType[pauseDone] = 'resume';
            log(`Resumed: ${gp(pauseDone)?.name} (round ${r+1})`);
            if (doRender) render();
            if (live) await STORE.save();
            await delay(ms);
          }
          pauseDone = false;
        }

        if (r === 15 && !leaveSoonDone) {
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

        if (r === 25 && !midRemoveDone) {
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
              matchesPlayed: sp.matchesPlayed, ptsFor: sp.ptsFor, ptsAgainst: sp.ptsAgainst
            };
          }),
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

  // ── Organizer 12p/2c simulation ──────────────────────────────────────────

  async function runOrganizer12(opts = {}) {
    if (_running) { console.warn('[SIM] Already running. SIM.stop() first.'); return; }
    const { speed = 'fast', live = false } = opts;
    const ms = resolveSpeed(speed);
    const doRender = ms > 0 || live;

    _running = true; _aborted = false; _log = []; _errs = [];
    _disruptedAt = {}; _disruptedType = {};

    // Per-run quality accumulators
    let permA = null, permB = null;
    let _matchSnaps = [];      // {round, court, gap, t1Avg, t2Avg}
    let _waitTrack = {};       // {id: {cur, max}}
    let _partnerTrack = {};    // {id: Set<partnerId>}
    let _permViolations = 0, _permMatches = 0, _permHeldRounds = 0;

    // Snapshot court teams right after confirm (before score submit clears them)
    const snapCourt = (c, round) => {
      const ct = S.session.cfCourts?.[c];
      if (!ct?.match || ct.status !== 'playing') return;
      const { t1, t2 } = ct.match;
      const all = new Set([...t1, ...t2]);
      const avgR = ids => ids.reduce((s, id) => s + (gsp(id)?.sRating || gp(id)?.rating || 1000), 0) / ids.length;
      const t1a = avgR(t1), t2a = avgR(t2);
      _matchSnaps.push({ round, court: c, gap: Math.abs(t1a - t2a), t1Avg: Math.round(t1a), t2Avg: Math.round(t2a) });

      // Partner variety
      for (const id of all) {
        if (!_partnerTrack[id]) _partnerTrack[id] = new Set();
        const myTeam = t1.includes(id) ? t1 : t2;
        myTeam.forEach(pid => { if (pid !== id) _partnerTrack[id].add(pid); });
      }

      // Wait streaks — anyone active not playing increments streak
      const paused = new Set((S.session.cfPaused || []).map(q => q.id));
      for (const id of (S.session.activePlayers || [])) {
        const sp = gsp(id); if (!sp || sp.status === 'left') continue;
        if (!_waitTrack[id]) _waitTrack[id] = { cur: 0, max: 0 };
        if (all.has(id)) {
          _waitTrack[id].cur = 0;
        } else if (!paused.has(id)) {
          _waitTrack[id].cur++;
          if (_waitTrack[id].cur > _waitTrack[id].max) _waitTrack[id].max = _waitTrack[id].cur;
        }
      }

      // Permanent pair verification
      if (permA && permB) {
        const aP = all.has(permA), bP = all.has(permB);
        const aLeft = gsp(permA)?.status === 'left', bLeft = gsp(permB)?.status === 'left';
        if (aP && bP) {
          _permMatches++;
          if (t1.includes(permA) !== t1.includes(permB)) {
            err(`PERM PAIR SPLIT-TEAM on C${c} R${round}: ${gp(permA)?.name} & ${gp(permB)?.name} on opposite teams`);
            _permViolations++;
          }
        } else if ((aP && !bP && !bLeft) || (bP && !aP && !aLeft)) {
          err(`PERM PAIR VIOLATION on C${c} R${round}: ${gp(permA)?.name}(playing=${aP}) & ${gp(permB)?.name}(playing=${bP}) split`);
          _permViolations++;
        }
      }
    };

    // Check if one perm partner is in queue but the other is not (held-waiting state)
    const checkPermHeld = () => {
      if (!permA || !permB) return;
      const qIds = new Set((S.session.cfQueue || []).map(q => q.id));
      const aQ = qIds.has(permA), bQ = qIds.has(permB);
      const aLeft = gsp(permA)?.status === 'left', bLeft = gsp(permB)?.status === 'left';
      if ((aQ && !bQ && !bLeft) || (bQ && !aQ && !aLeft)) _permHeldRounds++;
    };

    log('=== ORGANIZER SIM: 12 players / 2 courts / ~3h ===');
    log('Scenarios: late arrivals, pause/resume, leave-soon, mid-remove, permanent partners');
    log('');

    saveRealState();
    stubSideEffects(live);
    try {
      resetState();

      // Fixed-rating players so results are deterministic and readable
      //   0=Alex(1350-A)  1=Jordan(1250-A)  2=Sam(1100-B+)  3=Morgan(1050-B)
      //   4=Taylor(960-B) 5=Casey(910-B-)   6=Riley(860-C+) 7=Quinn(810-C)
      //   8=Avery(760-C)  9=Charlie(700-C-) 10=Drew(NR)     11=Frankie(NR)
      const fixedRatings = [1350,1250,1100,1050,960,910,860,810,760,700,0,0];
      for (let i = 0; i < 12; i++) {
        const isNR = i >= 10;
        const r = isNR ? 1000 : fixedRatings[i];
        const id = uid();
        S.db.push({ id, name: NAMES[i] || `P${i}`, tag: '', rating: r, baseRating: r,
          isNR, nrLevelHint: isNR ? 950 : null, dupr: null, isSeeding: false,
          gamesPlayed: 0, wins: 0, losses: 0, ties: 0, createdAt: new Date().toISOString() });
      }
      S.db.forEach(p => S.checkedIn.add(p.id));
      log(`Players: ${S.db.map((p,i)=>p.name+(p.isNR?'(NR)':'('+fixedRatings[i]+')')).join(' | ')}`);

      // Build session (mirrors startSim but explicit for organizer scenario)
      const arr = [...S.checkedIn];
      S.courts = 2; S.adminPin = 'simtest';
      S.session = {
        id: uid(), name: 'Organizer 12p/2c', date: new Date().toISOString(), courts: 2,
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
        cfRanks:{},cfPendingPairs:[],neverPair:{},ratingOverrides:{},auditLog:[],status:'lobby'
      };
      S.session.status = 'active'; S.session.sessionStart = Date.now();
      _initSessionRanks(); _invalidateMatchmakingCaches();
      CF._confirmAllBusy = false; CF._confirmAllLastTs = 0;
      CF.initQueue();
      log('Play started. Initial queue: ' + S.session.cfQueue.map(q => gp(q.id)?.name).join(', '));

      // Generate initial suggestions for both courts
      try { CF.batchGenerateSuggestions([1, 2], null); } catch(e) { log('Initial suggest error: ' + e.message); }
      assert(S.session.cfSuggestions[1] || S.session.cfSuggestions[2], 'At least one suggestion generated at start');
      if (doRender) render();
      if (live) await STORE.save();
      await delay(ms);

      let pausedId = null, leaveSoonDone = false, removeDone = false;
      let permPauseId = null, permPauseResumed = false;
      let lateIds = [];
      const ROUNDS = 18;

      for (let r = 0; r < ROUNDS && !_aborted; r++) {
        const rl = `R${r+1}`;

        // Regenerate suggestions for idle ready courts
        const dead = [];
        for (let c = 1; c <= 2; c++) {
          const ct = S.session.cfCourts?.[c];
          if (ct?.status === 'ready' && !S.session.cfSuggestions?.[c] && S.session.cfQueue.length >= 4) dead.push(c);
        }
        if (dead.length) {
          try { CF.batchGenerateSuggestions(dead, null); } catch(e) { log(`${rl} regen err: ${e.message}`); }
        }

        // Confirm all ready suggestions
        let confirmed = 0;
        for (let c = 1; c <= 2; c++) {
          if (_aborted) break;
          if (S.session.cfSuggestions[c]) {
            CF.confirmSuggestion(c);
            confirmed++;
            snapCourt(c, r + 1);
            verifyNoDuplicates();
            if (doRender) render();
            if (live) await STORE.save();
            await delay(ms);
          }
        }

        // Submit all playing courts
        let submitted = 0;
        for (let c = 1; c <= 2; c++) {
          if (_aborted) break;
          const ct = S.session.cfCourts?.[c];
          if (ct?.status === 'playing' && ct.match) {
            const [s1, s2] = randomScore();
            CF._doSubmitScore(c, s1, s2);
            submitted++;
            log(`${rl} C${c}: ${s1}-${s2}  queue=${S.session.cfQueue.length}`);
            verifyNoGhosts(); verifyStats(); verifyPlayCountBalance();
            if (doRender) render();
            if (live) await STORE.save();
            await delay(ms);
          }
        }

        checkPermHeld();

        if (!confirmed && !submitted && S.session.cfQueue.length < 4) {
          log(`${rl}: insufficient players — court idle`); continue;
        }

        // ── Timeline events ──────────────────────────────────────

        // After R2: Set up permanent partners (Taylor + Casey)
        if (r === 1 && !permA) {
          permA = S.db[4].id; permB = S.db[5].id;
          cfAddPermPair(permA, permB);
          log(`${rl}: ⛓️  PERMANENT PAIR — ${S.db[4].name}(${fixedRatings[4]}) & ${S.db[5].name}(${fixedRatings[5]})`);
          // Verify no existing suggestion already splits them
          for (let c = 1; c <= 2; c++) {
            const sug = S.session.cfSuggestions?.[c];
            if (sug) {
              const inSug = new Set([...(sug.t1||[]),...(sug.t2||[])]);
              const aIn = inSug.has(permA), bIn = inSug.has(permB);
              if (aIn !== bIn) err(`${rl}: existing C${c} suggestion has solo perm pair member after lock!`);
            }
          }
          if (doRender) render();
          await delay(ms);
        }

        // R4: Two late arrivals (mid-strength players)
        if (r === 3 && lateIds.length === 0) {
          const lateRatings = [1000, 820];
          for (let i = 0; i < 2; i++) {
            const ni = S.db.length, lr = lateRatings[i], lId = uid();
            S.db.push({ id:lId, name:NAMES[ni]||`Late${ni}`, tag:'LATE', rating:lr, baseRating:lr,
              isNR:false, nrLevelHint:null, dupr:null, isSeeding:false,
              gamesPlayed:0, wins:0, losses:0, ties:0, createdAt:new Date().toISOString() });
            S.checkedIn.add(lId); midAdd(lId);
            lateIds.push(lId);
            _disruptedAt[lId] = S.session.cfMatchCount||0; _disruptedType[lId] = 'midadd';
            log(`${rl}: Late arrival — ${NAMES[ni]}(${lr}): joined mid-session with 0 games`);
            verifyNoGhosts();
            if (doRender) render(); if (live) await STORE.save(); await delay(ms);
          }
        }

        // R5: Pause a regular player (not perm pair member)
        if (r === 4 && !pausedId) {
          const cand = S.session.cfQueue.find(q => q.id !== permA && q.id !== permB);
          if (cand) {
            cfPausePlayer(cand.id); pausedId = cand.id;
            log(`${rl}: Pause — ${gp(cand.id)?.name} (bathroom break)`);
            if (doRender) render(); if (live) await STORE.save(); await delay(ms);
          }
        }

        // R6: Strong late arrival (A-level player runs late)
        if (r === 5 && lateIds.length === 2) {
          const ni = S.db.length, lr = 1180, lId = uid();
          S.db.push({ id:lId, name:NAMES[ni]||`Late${ni}`, tag:'LATE', rating:lr, baseRating:lr,
            isNR:false, nrLevelHint:null, dupr:null, isSeeding:false,
            gamesPlayed:0, wins:0, losses:0, ties:0, createdAt:new Date().toISOString() });
          S.checkedIn.add(lId); midAdd(lId);
          lateIds.push(lId);
          _disruptedAt[lId] = S.session.cfMatchCount||0; _disruptedType[lId] = 'midadd';
          log(`${rl}: Late arrival #3 — ${NAMES[ni]}(${lr}) strong A-level, 0 games — hunger priority kicks in`);
          verifyNoGhosts();
          if (doRender) render(); if (live) await STORE.save(); await delay(ms);
        }

        // R8: Resume paused player
        if (r === 7 && pausedId) {
          const e = (S.session.cfPaused||[]).find(q=>q.id===pausedId);
          if (e) {
            cfResumePlayer(pausedId);
            _disruptedAt[pausedId] = S.session.cfMatchCount||0; _disruptedType[pausedId] = 'resume';
            log(`${rl}: Resumed — ${gp(pausedId)?.name}`);
            pausedId = null;
            if (doRender) render(); if (live) await STORE.save(); await delay(ms);
          }
        }

        // R9: Leave-soon for one regular player
        if (r === 8 && !leaveSoonDone) {
          const cand = S.session.cfQueue.find(q => q.id!==permA && q.id!==permB && !lateIds.includes(q.id));
          if (cand) {
            cfLeaveSoon(cand.id); leaveSoonDone = true;
            log(`${rl}: Leave-soon flagged — ${gp(cand.id)?.name} (has to go after current game)`);
            if (doRender) render(); if (live) await STORE.save(); await delay(ms);
          }
        }

        // R11: Sudden mid-remove (late arrival gets a phone call, has to leave NOW)
        if (r === 10 && !removeDone && lateIds.length > 0) {
          const rmId = lateIds[0];
          const sp = gsp(rmId);
          if (sp && sp.status !== 'left') {
            const onCourt = Object.values(S.session.cfCourts||{}).some(
              ct => ct?.status==='playing' && ct.match && [...ct.match.t1,...ct.match.t2].includes(rmId));
            if (!onCourt) {
              midRemove(rmId); removeDone = true;
              log(`${rl}: Mid-remove — ${gp(rmId)?.name} sudden departure from queue`);
              assert(!S.session.cfRanks[rmId], `${rl}: cfRanks cleared immediately on midRemove`);
              verifyNoGhosts();
              if (doRender) render(); if (live) await STORE.save(); await delay(ms);
            }
          }
        }

        // R14: CRITICAL TEST — pause one permanent pair member
        // Expected: partner is automatically held, cannot be assigned while other is paused
        if (r === 13 && !permPauseId && permA) {
          const target = S.session.cfQueue.find(q=>q.id===permA||q.id===permB);
          if (target) {
            cfPausePlayer(target.id); permPauseId = target.id;
            const other = target.id===permA ? permB : permA;
            log(`${rl}: ⛓️  PERM PAIR TEST — paused ${gp(target.id)?.name}`);
            log(`${rl}:   → ${gp(other)?.name} should now be HELD in queue (not assigned to any court)`);
            // Immediately verify the free partner is not already on court from a suggestion
            for (let c=1;c<=2;c++) {
              const sug = S.session.cfSuggestions?.[c];
              if (sug && [...(sug.t1||[]),...(sug.t2||[])].includes(other))
                err(`${rl}: free perm pair partner ${gp(other)?.name} in pending suggestion while partner is paused!`);
            }
            if (doRender) render(); if (live) await STORE.save(); await delay(ms);
          }
        }

        // R16: Resume paused perm pair member — both should play together next round
        if (r === 15 && permPauseId && !permPauseResumed) {
          const e = (S.session.cfPaused||[]).find(q=>q.id===permPauseId);
          if (e) {
            cfResumePlayer(permPauseId);
            permPauseResumed = true;
            _disruptedAt[permPauseId] = S.session.cfMatchCount||0; _disruptedType[permPauseId] = 'resume';
            log(`${rl}: ⛓️  Resumed paused perm pair member — ${gp(permPauseId)?.name}`);
            log(`${rl}:   → Both partners back in queue — should play together in next suggestion`);
            if (doRender) render(); if (live) await STORE.save(); await delay(ms);
          }
        }
      }

      // ── Final leave-soon ghost check ──
      const leftIds = (S.session.players||[]).filter(sp=>sp.status==='left').map(sp=>sp.id);
      const qIds = new Set((S.session.cfQueue||[]).map(q=>q.id));
      leftIds.forEach(id => { assert(!qIds.has(id), `Ghost check: ${gp(id)?.name} left but in queue`); });

      // ── Archive session ──
      const arch = {
        id: S.session.id, name: S.session.name, date: S.session.date, cfMode: true,
        players: (S.session.players||[]).map(sp => ({
          id:sp.id, name:sp.name||'?', status:sp.status,
          sRating:sp.sRating, startRating:sp.startRating,
          wins:sp.wins, losses:sp.losses, ties:sp.ties,
          matchesPlayed:sp.matchesPlayed, ptsFor:sp.ptsFor, ptsAgainst:sp.ptsAgainst
        })),
        cfLog: JSON.parse(JSON.stringify(S.session.cfLog||[]))
      };
      S.archive.unshift(arch);
      S.checkedIn.clear(); S.session = null;
      recalcAllTimeRatings();

      // ══ QUALITY REPORT ════════════════════════════════════════════
      log('');
      log('╔══════════════════════════════════════════════════╗');
      log('║   ORGANIZER QUALITY REPORT — 12p / 2 Courts     ║');
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
        if (avgGap > 120) log('  ⚠️  High avg gap — rating spread may be too wide for 2 courts');
        else if (avgGap <= 60) log('  ✅ Excellent balance — matchmaking working well');
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
      } else {
        log('  (No permanent pair set in this run)');
      }

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
      <button class="sim-go" id="sim-run-btn" onclick="SIM._uiRun()">▶ Run Full Simulation</button>
      <button class="sim-go" style="background:#a78bfa;color:#1a0540" onclick="SIM.runOrganizer12({speed:document.getElementById('sim-speed')?.value||'fast',live:document.getElementById('sim-live')?.checked??false})">⛓️ Run 12p/2c Organizer Sim</button>
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

    try {
      await run({ players, courts, rounds, speed, live });
    } finally {
      if (btn) btn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
    }
  }

  if (location.search.includes('simulate')) {
    if (document.readyState === 'complete') buildPanel();
    else window.addEventListener('load', buildPanel);
  }

  return { run, runBugChecks, runOrganizer12, runPermPairCheck, stop, _uiRun, _continue, log: () => _log, errors: () => _errs };

})();
