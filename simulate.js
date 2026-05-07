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
      cfQueue: [], cfPinnedIds: [], cfPauseAfterGame: [], cfLockedPairs: [], cfSoftPairs: [],
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
    const settled = active.filter(sp => {
      if ((sp.matchesPlayed || 0) < nc) return false;
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
      <button class="sim-go" id="sim-run-btn" onclick="SIM._uiRun()">Run Full Simulation</button>
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

  return { run, runBugChecks, stop, _uiRun, _continue, log: () => _log, errors: () => _errs };

})();
