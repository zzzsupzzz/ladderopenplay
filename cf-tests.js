#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   Headless unit tests for the matchmaking core (CF / ELO / ranking / wait cap).

   WHY: the app is one ~10k-line index.html with no fast test loop. simulate.js
   needs a full browser. This loads the app's inline <script> in a node `vm`
   sandbox (DOM / Firebase / timers stubbed), then exercises the PURE-ish
   matchmaking functions directly and asserts known invariants. Runs in
   milliseconds, no browser, so engine changes can be checked before they ship.

   Run:  node cf-tests.js
   ────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
// The app is the largest inline <script> block.
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const app = scripts.sort((a, b) => b.length - a.length)[0];
if (!app) { console.error('Could not find app script'); process.exit(1); }

// ── Stubs: anything the script touches at load time (DOM, storage, net, timers)
const noop = () => {};
// Chainable element/DOM proxy: every property read returns a callable no-op or
// another proxy, so .style.x=, .classList.add(), .appendChild(), etc. never throw.
function makeProxy() {
  const target = function () { return makeProxy(); };
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'style' || prop === 'classList' || prop === 'dataset') return makeProxy();
      if (prop === 'value' || prop === 'textContent' || prop === 'innerHTML') return '';
      if (prop === 'length') return 0;
      if (prop === Symbol.iterator) return function* () {};
      return makeProxy();
    },
    set() { return true; },
    apply() { return makeProxy(); }
  });
}
const documentStub = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => makeProxy(),
  addEventListener: noop, removeEventListener: noop,
  body: makeProxy(), head: makeProxy(), documentElement: makeProxy()
};
const localStorageStub = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop };
const firebaseStub = (() => {
  const ref = () => ({ on: noop, off: noop, once: () => Promise.resolve({ val: () => null }), update: () => Promise.resolve(), set: () => Promise.resolve(), child: () => ref(), remove: () => Promise.resolve() });
  return { initializeApp: () => ({}), database: () => ({ ref }), apps: [] };
})();

const ctx = {
  console, Math, JSON, Date, Object, Array, Set, Map, Number, String, Boolean,
  parseInt, parseFloat, isNaN, isFinite, RegExp, Promise, Symbol, Proxy,
  setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
  requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
  document: documentStub, localStorage: localStorageStub, sessionStorage: localStorageStub,
  navigator: { onLine: true, userAgent: 'node' },
  location: { href: 'http://test/', search: '', hash: '', reload: noop },
  history: { replaceState: noop, pushState: noop },
  performance: { now: () => Date.now() },
  firebase: firebaseStub, QRCode: function () { return makeProxy(); },
  alert: noop, confirm: () => true, prompt: () => null,
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;

// Export the const-bound objects we want to test (functions are already globals).
const exportSnippet = `;var __APP={S:S,CF:CF,MM:MM,ELO:ELO,SYNC:typeof SYNC!=='undefined'?SYNC:null,
  _sessionRank:typeof _sessionRank!=='undefined'?_sessionRank:null,
  _totalRanked:typeof _totalRanked!=='undefined'?_totalRanked:null,
  _ranksCompatible:typeof _ranksCompatible!=='undefined'?_ranksCompatible:null,
  _initSessionRanks:typeof _initSessionRanks!=='undefined'?_initSessionRanks:null,
  gp:typeof gp!=='undefined'?gp:null, gsp:typeof gsp!=='undefined'?gsp:null,
  _seasonLadderHtml:typeof _seasonLadderHtml!=='undefined'?_seasonLadderHtml:null,
  _streakOf:typeof _streakOf!=='undefined'?_streakOf:null,
  _tierOf:typeof _tierOf!=='undefined'?_tierOf:null,
  _awardsHtml:typeof _awardsHtml!=='undefined'?_awardsHtml:null,
  _ratingSparkHtml:typeof _ratingSparkHtml!=='undefined'?_ratingSparkHtml:null,
  _pvLeaderboardHtml:typeof _pvLeaderboardHtml!=='undefined'?_pvLeaderboardHtml:null,
  _sessionLbRows:typeof _sessionLbRows!=='undefined'?_sessionLbRows:null,
  _multiWriterBannerHtml:typeof _multiWriterBannerHtml!=='undefined'?_multiWriterBannerHtml:null,
  exportBackup:typeof exportBackup!=='undefined'?exportBackup:null,
  importBackup:typeof importBackup!=='undefined'?importBackup:null,
  _updateSessionRank:typeof _updateSessionRank!=='undefined'?_updateSessionRank:null,
  _pvRecord:typeof _pvRecord!=='undefined'?_pvRecord:null,
  _waitGapStats:typeof _waitGapStats!=='undefined'?_waitGapStats:null};`;

vm.createContext(ctx);
try {
  vm.runInContext(app + exportSnippet, ctx, { filename: 'index.app.js' });
} catch (e) {
  console.error('❌ App script failed to load in sandbox:\n', e && e.stack || e);
  process.exit(1);
}

const APP = ctx.__APP;
if (!APP || !APP.CF) { console.error('❌ Loaded, but CF not exported'); process.exit(1); }
console.log('✅ App loaded headlessly. Exports:', Object.keys(APP).filter(k => APP[k]).join(', '));

// ── tiny test framework ───────────────────────────────────────────────────
let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  if (actual === expected) { pass++; }
  else { fail++; console.error(`  ❌ ${msg}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`  ❌ ${msg}`); } }
function section(name) { console.log('\n── ' + name + ' ──'); }

const { S, CF } = APP;

// Build a minimal active CF session with N players, nc courts.
function makeSession(n, nc, mult = 2) {
  const players = [];
  for (let i = 0; i < n; i++) players.push({ id: 'p' + i, name: 'P' + i, status: 'active', matchesPlayed: 0, sRating: 1200 - i * 20, startRating: 1200 - i * 20, wins: 0, losses: 0, ties: 0, lastPlayedAtMatch: null });
  S.session = {
    courts: nc, cfMode: true, status: 'active', cfWaitCapMult: mult,
    players, activePlayers: players.map(p => p.id),
    cfQueue: players.map(p => ({ id: p.id, since: Date.now(), consec: 0 })),
    cfPaused: [], cfCourts: {}, cfSuggestions: {}, cfRanks: {},
    cfMatchCount: 0, cfLog: [], sessionStart: Date.now(),
    // history maps the app initialises at session start (MM.pc/oc read these directly)
    partnerHx: {}, oppHx: {}, oppHxTime: {},
    cfMatchupHx: {}, cfGroupHx: {}, cfPairConsec: {}, cfPermPairs: [], cfSoftPairs: []
  };
  // mirror into S.db so gp() resolves (ratings, names)
  S.db = players.map(p => ({ id: p.id, name: p.name, rating: p.sRating, gamesPlayed: 0, wins: 0, losses: 0, isNR: false }));
  return S.session;
}

// ── Tests: WAIT CAP scales with court count ─────────────────────────────────
section('waitCap() — court scaling (constant cap = nc*mult+1)');
makeSession(20, 2); eq(CF.waitCap(), 5, '2 courts / mult 2 → cap 5');
makeSession(20, 3); eq(CF.waitCap(), 7, '3 courts / mult 2 → cap 7');
makeSession(20, 4); eq(CF.waitCap(), 9, '4 courts / mult 2 → cap 9');
makeSession(20, 3, 1); eq(CF.waitCap(), 4, '3 courts / mult 1 (social) → cap 4');
// phase-independent: all phases equal (P3 wait-slack + tighten experiment reverted — the sim
// showed partner gap RISES P1→P3 regardless, and tightening the P3 target made late gaps WIDER
// because availability, not the cap, is the binding constraint. Constant cap restored.)
makeSession(20, 3); S.session.cfMatchCount = 40;
eq(CF.waitCap(), 7, 'cap is constant across phases (no graduation)');

// ── Tests: bench floor raises cap when room is too full ─────────────────────
section('waitCap() — bench floor for a crowded room');
makeSession(40, 3); // bench = 40-12 = 28, ceil(28/4)+1 = 8 > 7
eq(CF.waitCap(), 8, 'crowded room raises cap to fairFloor+1');

// ── Tests: _sessionPhase is games-based ─────────────────────────────────────
section('_sessPhaseNum() — progress-based phase boundaries (np*0.5 warm-up, np*1.2)');
makeSession(20, 3); // np=20 → warm-up P1<10 (~2 games each), P2<24, P3>=24
S.session.cfMatchCount = 0;  eq(CF._sessPhaseNum(), 1, 'mc 0 → phase 1');
S.session.cfMatchCount = 9;  eq(CF._sessPhaseNum(), 1, 'mc 9 → phase 1 (still warm-up)');
S.session.cfMatchCount = 10; eq(CF._sessPhaseNum(), 2, 'mc 10 → phase 2 (warm-up = np*0.5 = 10 matches = ~2 games each)');
S.session.cfMatchCount = 23; eq(CF._sessPhaseNum(), 2, 'mc 23 → phase 2');
S.session.cfMatchCount = 24; eq(CF._sessPhaseNum(), 3, 'mc 24 → phase 3');

// ── Tests: Phase-1 warm-up seating — fewest-games-first (0-game never starves) ─
// The dedicated warm-up path must seat the players with the FEWEST games next, so nobody waits
// 3 matches for their first game and the same foursome doesn't keep recycling. (Real-night bug:
// hungerBoost is ~7 in early warm-up — below the >10 gate — so the engine wasn't prioritizing them.)
section('Phase 1 warm-up — fewest-games-first seating (0-game players never starve)');
try {
  makeSession(14, 2);
  if (APP._initSessionRanks) APP._initSessionRanks();
  S.session.cfMatchCount = 1; // deep warm-up (np*0.5 = 7)
  const played = S.session.players.slice(0, 4).map(p => p.id); // these 4 already have a game
  S.session.players.forEach((p, i) => { p.matchesPlayed = i < 4 ? 1 : 0; });
  S.session.cfQueue = S.session.players.map(p => ({ id: p.id, since: Date.now(), consec: 0 }));
  S.session.cfCourts = { 1: { status: 'ready' }, 2: { status: 'ready' } };
  S.session.cfSuggestions = {};
  CF.batchGenerateSuggestions([1, 2], null);
  const seated = [1, 2].flatMap(c => S.session.cfSuggestions[c] ? S.session.cfSuggestions[c].allIds : []);
  ok(seated.length === 8, `warm-up seated both ready courts (${seated.length}/8)`);
  const seatedAlreadyPlayed = seated.filter(id => played.includes(id)).length;
  ok(seatedAlreadyPlayed === 0, `warm-up seats the zero-game players FIRST, never the 4 who already played (already-played seated: ${seatedAlreadyPlayed})`);
} catch (e) {
  fail++; console.error('  ❌ Phase-1 warm-up seating test threw: ' + (e && e.message) + '\n' + (e && e.stack || ''));
}

// ── Tests: matchGap basics ──────────────────────────────────────────────────
section('matchGap() — gap counting + resume anchor');
makeSession(20, 3);
S.session.cfMatchCount = 10;
const a = S.session.players[0];
a.matchesPlayed = 2; a.lastPlayedAtMatch = 6;
eq(CF.matchGap(a.id), 4, 'gap = cfMatchCount(10) - lastPlayed(6) = 4');
// resumed-from-pause anchors to the resume point, not the pre-pause game
a.resumedFromPause = true; a._resumedAtMatch = 9;
eq(CF.matchGap(a.id), 1, 'resumed: gap = mc(10) - max(lastPlayed 6, resume 9) = 1');
delete a.resumedFromPause; delete a._resumedAtMatch;

// ── Tests: _scoreGroup skill balance ────────────────────────────────────────
section('_scoreGroup() — skill-balance scoring sanity');
makeSession(20, 3);
if (APP._initSessionRanks) APP._initSessionRanks();
const mk = ids => ids.map(i => {
  const sp = S.session.players[i];
  return { id: sp.id, sr: sp.sRating, mg: 0, pcg: 0, cmg: 0, waitMin: 0, _minGames: 0 };
});
try {
  // Phase 3 (skill matters): tight foursome scores better than a wide one.
  S.session.cfMatchCount = 40; // np=20 → ≥1.2*20=24 ⇒ Phase 3
  const tight = CF._scoreGroup(mk([0, 1, 2, 3]), null);   // four near-equal players
  const wide = CF._scoreGroup(mk([0, 1, 18, 19]), null);  // top-2 + bottom-2
  ok(tight && wide, 'scoreGroup returns a result for both foursomes');
  ok(tight.score < wide.score, 'Phase 3: tight-rank foursome scores better (lower) than a wide one');
  const ids = wide.t1.map(p => p.id).concat(wide.t2.map(p => p.id));
  ok(ids.length === 4, 'scoreGroup produces a 4-player split (2v2)');
} catch (e) {
  fail++; console.error('  ❌ _scoreGroup threw: ' + (e && e.message) + '\n' + (e && e.stack || ''));
}

// ── Tests: Phase 1 = BALANCED RANDOM (warm-up) ──────────────────────────────
// Phase 1 ignores skill for SELECTION (foursomes mix freely) but still balances the 2v2 teams —
// so a spread foursome splits strong+weak: LOW team gap, HIGH partner gap by design. The match-quality
// chip is suppressed (🎲 Warm-up) in this phase, so high partner gaps aren't flagged as mismatches.
section('_scoreGroup() — Phase 1 balanced-random (skill-blind selection, team-balanced split)');
try {
  makeSession(20, 3);
  if (APP._initSessionRanks) APP._initSessionRanks();
  // Use foursomes WITHIN the rank-band hard limit (≤50% spread for 3c, so ~10 ranks). The hard
  // "crazy mismatch" block (which prevents un-balanceable blowouts) still applies every phase —
  // [0,1,8,9] spans 9 ranks, comfortably legal.
  S.session.cfMatchCount = 0; // np=20 → <0.6*20=12 ⇒ Phase 1
  const tP1 = CF._scoreGroup(mk([0, 1, 2, 3]), null);   // spread ~3
  const sP1 = CF._scoreGroup(mk([0, 1, 8, 9]), null);   // spread ~9 (legal)
  // 1) Selection is skill-blind: a tight and a spread (legal) foursome score ~equally in Phase 1.
  ok(Math.abs(tP1.score - sP1.score) < 25, `Phase 1: tight vs spread foursome score ~equally — selection ignores skill (Δ=${Math.round(Math.abs(tP1.score - sP1.score))})`);
  // 2) The spread foursome still splits to BALANCED teams (low cross-team gap).
  const sTeamGap = Math.abs((sP1.t1[0].sr + sP1.t1[1].sr) / 2 - (sP1.t2[0].sr + sP1.t2[1].sr) / 2);
  ok(sTeamGap < 60, `Phase 1: spread foursome splits to balanced teams — low team gap (${Math.round(sTeamGap)})`);
  // 3) …via a strong+weak pairing → high partner gap (the intended Phase-1 signature).
  const sPartnerGap = Math.max(Math.abs(sP1.t1[0].sr - sP1.t1[1].sr), Math.abs(sP1.t2[0].sr - sP1.t2[1].sr));
  ok(sPartnerGap > 100, `Phase 1: spread foursome pairs strong+weak — high partner gap by design (${Math.round(sPartnerGap)})`);
  // 4) SPLIT B (organizer decision): Phase 2/3 ALSO split wide foursomes to BALANCED teams —
  //    a forced-wide group becomes a close carry game (strong+weak each side), never a
  //    top-pair-vs-bottom-pair blowout. Group-spread penalties still prefer tight foursomes.
  S.session.cfMatchCount = 40;
  const sP3 = CF._scoreGroup(mk([0, 1, 8, 9]), null);
  const sP3TeamGap = Math.abs((sP3.t1[0].sr + sP3.t1[1].sr) / 2 - (sP3.t2[0].sr + sP3.t2[1].sr) / 2);
  ok(sP3TeamGap < 60, `Split B: Phase 3 wide foursome splits to balanced teams — no blowout (team gap ${Math.round(sP3TeamGap)})`);

  // 5) TRUE-RANDOM opening (every player ≤1 game): the spread limit is OFF — even a top+bottom or a
  //    3-strong-1-weak foursome forms (selection fully skill-blind), but teams still balance.
  S.session.cfMatchCount = 0;
  S.session.players.forEach(p => p.matchesPlayed = 0);             // everyone in their 1st game
  const wildOpen = CF._scoreGroup(mk([0, 1, 18, 19]), null);      // spread ~18 — blocked once games accrue
  const topHeavyOpen = CF._scoreGroup(mk([0, 1, 2, 18]), null);   // 3 strong + 1 weak ("top 3 with bottom")
  const tightOpen = CF._scoreGroup(mk([0, 1, 2, 3]), null);
  ok(Math.abs(wildOpen.score - tightOpen.score) < 40, `Opening: top+bottom foursome NOT blocked — true random (Δ=${Math.round(Math.abs(wildOpen.score - tightOpen.score))})`);
  ok(Math.abs(topHeavyOpen.score - tightOpen.score) < 40, `Opening: 3-strong-1-weak foursome allowed too (Δ=${Math.round(Math.abs(topHeavyOpen.score - tightOpen.score))})`);
  const woTeamGap = Math.abs((wildOpen.t1[0].sr + wildOpen.t1[1].sr) / 2 - (wildOpen.t2[0].sr + wildOpen.t2[1].sr) / 2);
  ok(woTeamGap < 60, `Opening: wild foursome still split to balanced teams (team gap ${Math.round(woTeamGap)})`);
  // 6) Once players are past their first 2 games (still Phase 1), the spread limit returns.
  S.session.cfMatchCount = 9; // np=20 → warm-up <10 ⇒ still Phase 1
  S.session.players.forEach(p => p.matchesPlayed = 2);
  const wildLater = CF._scoreGroup(mk([0, 1, 18, 19]), null);
  const tightLater = CF._scoreGroup(mk([0, 1, 2, 3]), null);
  ok(wildLater.score > tightLater.score + 100, `After first 2 games: spread limit returns — wild foursome penalised (wild ${Math.round(wildLater.score)} > tight ${Math.round(tightLater.score)})`);
} catch (e) {
  fail++; console.error('  ❌ Phase-1 balanced-random test threw: ' + (e && e.message) + '\n' + (e && e.stack || ''));
}

// ── Tests: ladder arc — Phase-2 band ramp + Phase-3 court tiers ─────────────
// Phase 2: the rank-band soft target slides CONTINUOUSLY from its P2-start value to the P3
// value as cfMatchCount advances, so the same moderately-wide foursome scores progressively
// worse through the middle of the session. Phase 3: _tierPen anchors court 1 to the top band
// of the standings (court nc = bottom band) as a soft, wait-decaying score bias.
section('ladder arc — Phase-2 band ramp + Phase-3 court-tier affinity (_tierPen)');
try {
  // Ramp (2 courts, 14p): soft target 50%→40% of N across P2 (mc 9..16). Spread-8 foursome
  // [ranks 1,2,8,9] sits over the soft target but under the hard limit → pure soft-zone signal.
  makeSession(14, 2);
  if (APP._initSessionRanks) APP._initSessionRanks();
  S.session.players.forEach(p => { p.matchesPlayed = 5; });
  S.session.cfMatchCount = 8;  // just into Phase 2 (np*0.5 = 7 for np=14)
  S.session.players.forEach(p => { p.lastPlayedAtMatch = S.session.cfMatchCount; });
  const earlyP2 = CF._scoreGroup(mk([0, 1, 7, 8]), null);
  S.session.cfMatchCount = 16; // late Phase 2 (P3 starts at 17)
  S.session.players.forEach(p => { p.lastPlayedAtMatch = S.session.cfMatchCount; });
  const lateP2 = CF._scoreGroup(mk([0, 1, 7, 8]), null);
  ok(lateP2.score > earlyP2.score, `P2 ramp: same wide foursome scores worse late in P2 than early (${Math.round(lateP2.score)} > ${Math.round(earlyP2.score)})`);

  // _tierPen (3 courts, 18p): bands of 6 — court 1 = ranks 1-6, court 2 = 7-12, court 3 = 13-18.
  makeSession(18, 3);
  if (APP._initSessionRanks) APP._initSessionRanks();
  S.session.cfMatchCount = 30; // np=18 → P3 at mc>=21.6
  S.session.players.forEach(p => { p.matchesPlayed = 5; p.lastPlayedAtMatch = 30; }); // matchGap 0
  const topG = mk([0, 1, 2, 3]); // ranks 1-4 → top band
  eq(CF._tierPen(topG, 1), 0, '_tierPen: top-band group on court 1 → 0 (home court)');
  const off1 = CF._tierPen(topG, 2), off2 = CF._tierPen(topG, 3);
  ok(off1 > 0, `_tierPen: top-band group on court 2 → penalised (${Math.round(off1)})`);
  ok(off2 > off1, `_tierPen: court 3 (two bands off) > court 2 (${Math.round(off2)} > ${Math.round(off1)})`);
  eq(CF._tierPen(topG, null), 0, '_tierPen: no destination court → 0 (court-agnostic callers unaffected)');
  S.session.cfMatchCount = 15; // Phase 2
  eq(CF._tierPen(topG, 3), 0, '_tierPen: Phase 2 → 0 (tiers are Phase-3 only)');
  S.session.cfMatchCount = 30;
  // Wait decay: penalty fades as a member's matchGap approaches the wait cap (wait beats tier).
  const fullPull = CF._tierPen(mk([0, 1, 2, 3]), 3);
  S.session.players.forEach(p => { p.lastPlayedAtMatch = 30 - CF.waitCap(); }); // all AT the cap
  eq(CF._tierPen(mk([0, 1, 2, 3]), 3), 0, '_tierPen: members at the wait cap → tier pull fully decayed to 0');
  S.session.players.forEach(p => { p.lastPlayedAtMatch = 28; }); // matchGap 2 — partial decay
  const partial = CF._tierPen(mk([0, 1, 2, 3]), 3);
  ok(partial > 0 && partial < fullPull, `_tierPen: partial wait → partial decay (0 < ${Math.round(partial)} < ${Math.round(fullPull)})`);
  // End-to-end: _scoreGroup prefers the home court for a top-band group in P3.
  S.session.players.forEach(p => { p.lastPlayedAtMatch = 30; });
  const sHome = CF._scoreGroup(mk([0, 1, 2, 3]), null, 1);
  const sAway = CF._scoreGroup(mk([0, 1, 2, 3]), null, 3);
  ok(sAway.score > sHome.score, `_scoreGroup: top-band group scores worse bound for court 3 than court 1 (${Math.round(sAway.score)} > ${Math.round(sHome.score)})`);
  // Uncalibrated guard: <4 games → no tier pull (rank not trustworthy yet).
  S.session.players.forEach(p => { p.matchesPlayed = 2; });
  eq(CF._tierPen(mk([0, 1, 2, 3]), 3), 0, '_tierPen: players with <4 games → 0 (uncalibrated ranks)');
} catch (e) {
  fail++; console.error('  ❌ ladder-arc test threw: ' + (e && e.message) + '\n' + (e && e.stack || ''));
}

// ── Tests: ENDGAME mode + no-groundhog rules + form balancing + margin ranks ─
// Endgame (mc >= np*1.5): variety memory off, tightest spread — but the same four can't
// immediately re-form (rule 1), partners can't repeat back-to-back (existing cooldown),
// and a foursome rematch must redraw the teams (rule 3). Form: tonight's ranked record
// nudges effective strength for TEAM BALANCING only. Margin: blowouts move ranks harder
// while the ladder is calibrating (phases 1-2), clamped at ±4.
section('endgame — closeness>variety, no-groundhog rules, form split, margin-aware ranks');
try {
  makeSession(20, 3);
  if (APP._initSessionRanks) APP._initSessionRanks();
  S.session.players.forEach(p => { p.matchesPlayed = 5; p.lastPlayedAtMatch = 30; });
  // _isEndgame boundary: np=20 → endgame at mc>=30
  S.session.cfMatchCount = 29; eq(CF._isEndgame(), false, '_isEndgame: mc 29 → not yet (np*1.5=30)');
  S.session.cfMatchCount = 30; eq(CF._isEndgame(), true, '_isEndgame: mc 30 → endgame');

  // Rule 1: just-played foursome (any court) is heavily deprioritized
  const g4 = mk([0, 1, 2, 3]);
  const gk = g4.map(p => p.id).sort().join(',');
  S.session.cfRecentGroups = [];
  const fresh = CF._scoreGroup(g4, null).score;
  S.session.cfRecentGroups = [gk];
  const recent = CF._scoreGroup(g4, null).score;
  ok(recent >= fresh + 700, `rule 1: just-played foursome deprioritized (+${Math.round(recent - fresh)})`);
  S.session.cfRecentGroups = [];

  // Rule 3: a foursome rematch must use DIFFERENT teams than last time
  const res1 = CF._scoreGroup(g4, null);
  const key1 = CF.matchupKey(res1.t1.map(p => p.id), res1.t2.map(p => p.id));
  S.session.cfGroupLastSplit = {}; S.session.cfGroupLastSplit[gk] = key1;
  const res2 = CF._scoreGroup(g4, null);
  const key2 = CF.matchupKey(res2.t1.map(p => p.id), res2.t2.map(p => p.id));
  ok(key2 !== key1, 'rule 3: same foursome re-forms with different battle lines (split redrawn)');
  S.session.cfGroupLastSplit = {};

  // Endgame spread tightening: the same wide group is penalized harder in endgame than in P3
  S.session.cfMatchCount = 25; // Phase 3, pre-endgame
  const wideP3 = CF._scoreGroup(mk([0, 1, 7, 8]), null).score;
  S.session.cfMatchCount = 30; // endgame
  const wideEG = CF._scoreGroup(mk([0, 1, 7, 8]), null).score;
  ok(wideEG > wideP3, `endgame: spread target tightens (${Math.round(wideEG)} > ${Math.round(wideP3)})`);

  // Form adjustment: ranked form nudges effective strength, capped at ±2 ranks, needs ≥2 games
  const pA = S.session.players[5], pB = S.session.players[6];
  pA.wins = 4; pA.losses = 0; pA.ties = 0; pA.ptsFor = 44; pA.ptsAgainst = 20;
  pB.wins = 0; pB.losses = 4; pB.ties = 0; pB.ptsFor = 20; pB.ptsAgainst = 44;
  const adjA = CF._formAdjSr(pA.id), adjB = CF._formAdjSr(pB.id);
  ok(adjA > 0, `form: hot player balanced as stronger (+${Math.round(adjA)}sr)`);
  ok(adjB < 0, `form: slumping player balanced as weaker (${Math.round(adjB)}sr)`);
  const perRank = 500 / 19;
  ok(Math.abs(adjA) <= 2 * perRank + 0.01 && Math.abs(adjB) <= 2 * perRank + 0.01, 'form: nudge capped at ±2 ranks');
  pA.wins = 1; pA.losses = 0;
  eq(CF._formAdjSr(pA.id), 0, 'form: <2 ranked games → no adjustment (no evidence yet)');

  // Margin-aware ranks: in calibration (P1-2), an 11-1 win vs better opponents moves ranks
  // more than an 11-9 — and movement is clamped at 4.
  const _byRank = r => S.session.players.find(p => APP._sessionRank(p.id) === r).id;
  makeSession(20, 3);
  if (APP._initSessionRanks) APP._initSessionRanks();
  S.session.cfMatchCount = 5; // calibrating (P1)
  Object.values(S.session.cfRanks).forEach(e => { e.games = 4; }); // full speedMult
  let midId = _byRank(11), oppIds = [_byRank(3), _byRank(4)];
  APP._updateSessionRank(midId, true, 10, oppIds);
  const moveBlowout = 11 - APP._sessionRank(midId);
  makeSession(20, 3);
  if (APP._initSessionRanks) APP._initSessionRanks();
  S.session.cfMatchCount = 5;
  Object.values(S.session.cfRanks).forEach(e => { e.games = 4; });
  midId = _byRank(11); oppIds = [_byRank(3), _byRank(4)];
  APP._updateSessionRank(midId, true, 2, oppIds);
  const moveSqueaker = 11 - APP._sessionRank(midId);
  ok(moveBlowout > moveSqueaker, `margin-aware: blowout moves more than squeaker while calibrating (${moveBlowout} > ${moveSqueaker})`);
  ok(moveBlowout <= 4, `margin-aware: movement clamped at 4 (got ${moveBlowout})`);
} catch (e) {
  fail++; console.error('  ❌ endgame test threw: ' + (e && e.message) + '\n' + (e && e.stack || ''));
}

// ── Tests: _waitGapStats — WAIT column excludes pause/leave absences ─────────
// Regression for the false "WAIT 11": a leave→rejoin (or pause→resume) gap must NOT count the
// matches that elapsed while the player was out. The standings render and these tests share this
// exact function, so the displayed WAIT can't diverge from the engine's accounting.
section('_waitGapStats() — absences (pause/leave) excluded from the WAIT column');
try {
  // Games at cfMatchCount 0,2,4,6 — a session-start player (joinMc 0 → first gap skipped).
  // endAnchor = the match-count just after each game ends.
  const g = (cmc, end) => ({ cmc, endAnchor: end });
  const games = [g(0,1), g(2,3), g(4,5), g(6,7)];
  // No absence: gaps are 2-1=1 each (skip first) → max 1.
  eq(APP._waitGapStats(games, 0, [], 0).maxWait, 1, 'no absence: normal between-games gap');
  // Contiguous games (mc0→mc1, no real wait), then LEFT after the game ending at anchor 2 and
  // rejoined to play at mc15. Raw gap 15-2=13; absence window {2,15} fully overlaps → wait 0, not 13.
  const leaveGames = [g(0,1), g(1,2), g(15,16)];
  const left = APP._waitGapStats(leaveGames, 0, [{from:2,to:15}], 0);
  eq(left.maxWait, 0, 'leave→rejoin: the time away is NOT counted as wait (was the false WAIT 11)');
  // Real wait BEFORE leaving still counts: paused at mc5 (anchor was 3) → gap 5-3=2 before the break.
  const partial = APP._waitGapStats([g(0,1), g(2,3), g(16,17)], 0, [{from:5,to:16}], 0);
  eq(partial.maxWait, 2, 'wait accrued before the absence still counts (5-3=2)');
  // DOUBLE pause: two windows both excluded (the second hole the single-anchor logic missed).
  const dbl = APP._waitGapStats([g(0,1), g(10,11), g(20,21)], 0, [{from:1,to:10},{from:11,to:20}], 0);
  eq(dbl.maxWait, 0, 'two separate absences are both excluded');
  // Legacy fallback (no _absences array): single resume anchor clamps the spanning gap.
  const legacy = APP._waitGapStats([g(0,1), g(2,3), g(16,17)], 0, null, 14);
  eq(legacy.maxWait, 2, 'legacy resumeMc path: spanning gap clamped to resume (16-14=2)');
} catch (e) {
  fail++; console.error('  ❌ _waitGapStats test threw: ' + (e && e.message));
}

// ── Tests: late arrival fast-calibration ─────────────────────────────────────
// A late arrival skipped warm-up, so their rank is a pure entered-rating guess. Their first
// games must move FAST (accelerated, not damped) so the estimate snaps to its real spot —
// even mid Phase-3 (they're personally calibrating). Identical blowout → late player's rank
// moves more than a normal mid-session player's.
section('late arrival — rank fast-calibrates (first games move hard, even in Phase 3)');
try {
  makeSession(20, 3);
  if (APP._initSessionRanks) APP._initSessionRanks();
  S.session.cfMatchCount = 40; // deep Phase 3 — normal players are stable here
  S.session.players.forEach(p => { p.matchesPlayed = 6; });
  const _byRank = r => S.session.players.find(p => APP._sessionRank(p.id) === r).id;
  // Normal mid-pack player, 1 rank-update done, loses a blowout to better opponents
  const normId = _byRank(11);
  S.session.cfRanks[normId].games = 1; S.session.cfRanks[normId].isLateArrival = false;
  const normBefore = APP._sessionRank(normId);
  APP._updateSessionRank(normId, false, 10, [_byRank(3), _byRank(4)]);
  const normMove = Math.abs(APP._sessionRank(normId) - normBefore);
  // Late arrival at the same rank position, same blowout loss
  makeSession(20, 3);
  if (APP._initSessionRanks) APP._initSessionRanks();
  S.session.cfMatchCount = 40;
  S.session.players.forEach(p => { p.matchesPlayed = 6; });
  const lateId = _byRank(11);
  S.session.cfRanks[lateId].games = 1; S.session.cfRanks[lateId].isLateArrival = true;
  const lateBefore = APP._sessionRank(lateId);
  APP._updateSessionRank(lateId, false, 10, [_byRank(3), _byRank(4)]);
  const lateMove = Math.abs(APP._sessionRank(lateId) - lateBefore);
  ok(lateMove > normMove, `late arrival's rank moves more than a settled player's on the same blowout (late ${lateMove} > normal ${normMove})`);
  ok(lateMove > 0, 'late arrival actually moves in Phase 3 (not frozen by the gentle table)');
} catch (e) {
  fail++; console.error('  ❌ late-arrival test threw: ' + (e && e.message));
}

// ── Tests: _pvRecord — player's personal record INCLUDES warm-up ────────────
// The board is ranked-only, but a player's own view should show their whole night.
section('_pvRecord() — personal record counts every game, warm-up split out');
try {
  const log = [
    { t1: ['P1', 'x'], t2: ['a', 'b'], s1: 11, s2: 5, phase: 1 },  // warm-up WIN
    { t1: ['a', 'b'], t2: ['P1', 'y'], s1: 11, s2: 9, phase: 1 },  // warm-up LOSS
    { t1: ['P1', 'z'], t2: ['a', 'b'], s1: 11, s2: 8, phase: 2 },  // ranked WIN
    { t1: ['P1', 'z'], t2: ['a', 'b'], s1: 7, s2: 11, phase: 3 },  // ranked LOSS
    { t1: ['P1', 'z'], t2: ['a', 'b'], s1: 9, s2: 9, phase: 3 },   // ranked TIE
    { t1: ['a', 'b'], t2: ['c', 'd'], s1: 11, s2: 3, phase: 3 },   // not involving P1
    { t1: ['P1', 'z'], t2: ['a', 'b'], s1: null, s2: null, phase: 3 } // unplayed → skip
  ];
  const r = APP._pvRecord(log, 'P1');
  eq(r.g, 5, '_pvRecord: 5 games involving the player (unplayed/uninvolved excluded)');
  eq(r.w, 2, '_pvRecord: 2 wins overall (warm-up included)');
  eq(r.l, 2, '_pvRecord: 2 losses overall');
  eq(r.t, 1, '_pvRecord: 1 tie overall');
  eq(r.wg, 2, '_pvRecord: 2 warm-up games tracked separately');
  eq(r.ww, 1, '_pvRecord: 1 warm-up win');
  eq(r.wl, 1, '_pvRecord: 1 warm-up loss');
} catch (e) {
  fail++; console.error('  ❌ _pvRecord test threw: ' + (e && e.message));
}

// ── Tests: ranked-only board (Phase-1 warm-up doesn't count toward W/L) ──────
section('ranked-only board — Phase-1 warm-up calibrates but does NOT count W/L');
['renderLive','renderStandings','renderHistory','renderDB','renderRoster','toast','openModal','closeModal','startElapsed','startCFTick','updateHeader'].forEach(fn=>{ try{ if(typeof ctx[fn]!=='undefined') ctx[fn]=()=>{}; }catch(e){} });
try {
  const gsp = APP.gsp;
  const playMatch = (mc) => {
    S.session.cfMatchCount = mc;
    S.session.cfCourts = { 1: { status:'playing', match: { id:'tm'+mc, t1:['p0','p1'], t2:['p2','p3'], startTime: Date.now()-600000, status:'playing' } } };
    const before = ['p0','p1','p2','p3'].map(id => ({ id, w:(gsp(id).wins||0), l:(gsp(id).losses||0), g:(gsp(id).matchesPlayed||0), r:gsp(id).sRating }));
    CF._doSubmitScore(1, 11, 5); // p0,p1 win 11-5
    return before.map(b => ({ id:b.id, dw:(gsp(b.id).wins||0)-b.w, dl:(gsp(b.id).losses||0)-b.l, dg:(gsp(b.id).matchesPlayed||0)-b.g, dr:gsp(b.id).sRating-b.r }));
  };
  // Phase 1 (mc=0): warm-up — NO W/L, but games-played + ELO still move (calibration).
  makeSession(8, 2); if (APP._initSessionRanks) APP._initSessionRanks();
  const p1 = playMatch(0);
  ok(p1.every(x => x.dw === 0 && x.dl === 0), 'warm-up: no W/L recorded for any of the 4 players');
  ok(p1.every(x => x.dg === 1), 'warm-up: matchesPlayed still +1 (warm-up counts as a game played)');
  ok(p1.some(x => x.dr !== 0), 'warm-up: rating still moved (calibration intact)');
  ok((S.session.cfLog[S.session.cfLog.length-1]||{}).phase === 1, 'warm-up: logged match stamped phase 1');
  // Phase 3 (mc=12, np=8 → ≥9.6): ranked — W/L counts.
  makeSession(8, 2); if (APP._initSessionRanks) APP._initSessionRanks();
  const p3 = playMatch(12);
  const wl = p3.reduce((s,x) => s + x.dw + x.dl, 0);
  ok(wl === 4, `ranked: W/L recorded for all 4 players (got ${wl})`);
  ok((S.session.cfLog[S.session.cfLog.length-1]||{}).phase >= 2, 'ranked: logged match stamped phase ≥ 2');
} catch (e) {
  fail++; console.error('  ❌ ranked-only board test threw: ' + (e && e.message) + '\n' + (e && e.stack || ''));
}

// ── Tests: season ladder movement (snapshot diff) ──────────────────────────
section('_seasonLadderHtml() — week-over-week movement from rank snapshots');
if (APP._seasonLadderHtml) {
  S.session = null;
  S.db = [
    { id: 'a', name: 'A', rating: 1300, gamesPlayed: 5, wins: 3, losses: 2 },
    { id: 'b', name: 'B', rating: 1200, gamesPlayed: 5, wins: 2, losses: 3 },
    { id: 'c', name: 'C', rating: 1100, gamesPlayed: 5, wins: 1, losses: 4 },
  ];
  // newest snapshot first (archive.unshift order): A climbed 2→1, B slipped 1→2
  S.archive = [
    { id: 's2', players: S.db.map(p => ({ id: p.id })), rankSnapshot: { a: 1, b: 2, c: 3 } },
    { id: 's1', players: S.db.map(p => ({ id: p.id })), rankSnapshot: { a: 2, b: 1, c: 3 } },
  ];
  const h = APP._seasonLadderHtml();
  ok(/SEASON LADDER/.test(h), 'renders a season ladder');
  ok(/▲1/.test(h), 'A shows ▲1 (climbed from #2 to #1)');
  ok(/▼1/.test(h), 'B shows ▼1 (slipped from #1 to #2)');
  // [consistency sweep] season ladder is RATING-only — no wins-derived "catch" numbers, labeled clearly
  ok(!/to catch/.test(h), 'season ladder has NO "wins to catch" lines (rating ladder)');
  ok(/skill rating/.test(h), 'season ladder labels itself "by skill rating"');
  ok(/Top of the ladder/.test(h), '#1 gets the crown');
  // first-season case: a single snapshot → no movement shown
  S.archive = [{ id: 's1', players: S.db.map(p => ({ id: p.id })), rankSnapshot: { a: 1, b: 2, c: 3 } }];
  const h1 = APP._seasonLadderHtml();
  ok(!/▲|▼/.test(h1), 'single snapshot → no movement arrows yet');
} else {
  fail++; console.error('  ❌ _seasonLadderHtml not exported');
}

// ── Tests: progression helpers (streak / tier / awards / sparkline) ─────────
section('progression helpers — _streakOf / _tierOf / _awardsHtml / _ratingSparkHtml');
if (APP._streakOf) {
  const log = [
    { t1:['a','x'], t2:['y','z'], s1:3,  s2:11 }, // a loses
    { t1:['a','x'], t2:['y','z'], s1:11, s2:5  }, // a wins
    { t1:['a','x'], t2:['y','z'], s1:11, s2:7  }, // a wins
    { t1:['a','x'], t2:['y','z'], s1:11, s2:9  }, // a wins → trailing W3
  ];
  const st = APP._streakOf(log, 'a');
  eq(st.type, 'W', '_streakOf: trailing streak type is W');
  eq(st.n, 3, '_streakOf: trailing win streak is 3');
  // Ranked-only: Phase-1 warm-up matches (phase:1) are skipped, so a warm-up win doesn't extend a streak.
  const logWarm = [
    { t1:['a','x'], t2:['y','z'], s1:11, s2:2, phase:1 }, // warm-up win — should NOT count
    { t1:['a','x'], t2:['y','z'], s1:11, s2:5, phase:2 }, // ranked win
    { t1:['a','x'], t2:['y','z'], s1:11, s2:7, phase:3 }, // ranked win → ranked streak = 2
  ];
  const stW = APP._streakOf(logWarm, 'a');
  eq(stW.n, 2, '_streakOf: warm-up (phase 1) win is skipped — ranked streak is 2, not 3');
}
if (APP._tierOf) {
  eq(APP._tierOf(1, 20).key,  3, '_tierOf: rank 1/20 → Gold');
  eq(APP._tierOf(5, 20).key,  3, '_tierOf: rank 5/20 (25%) → Gold');
  eq(APP._tierOf(6, 20).key,  2, '_tierOf: rank 6/20 (30%) → Silver');
  eq(APP._tierOf(13, 20).key, 1, '_tierOf: rank 13/20 (65%) → Bronze');
  ok(APP._tierOf(0, 20) === null, '_tierOf: rank 0 → null');
}
if (APP._awardsHtml) {
  // Ranked-only awards: A racks up a big WARM-UP (phase 1) gain + win, B does it in RANKED (phase 2-3).
  // So Most Improved, Biggest Climber and Hot Hand should all go to B — A's warm-up doesn't count.
  const sess = {
    players: [
      { id:'a', name:'A', sRating:1290, startRating:1200, isNR:false, wins:0, losses:2, matchesPlayed:3 },
      { id:'b', name:'B', sRating:1260, startRating:1200, isNR:false, wins:2, losses:0, matchesPlayed:3 },
      { id:'c', name:'C', sRating:1110, startRating:1100, isNR:false },
      { id:'d', name:'D', sRating:1085, startRating:1100, isNR:false },
    ],
    cfRanks: { a:{initRank:3,rank:3}, b:{initRank:4,rank:1}, c:{initRank:2,rank:3}, d:{initRank:1,rank:4} },
    cfLog: [
      // Phase 1 warm-up — A wins big (+70), warm-end rank 4 for B. Should NOT count for any award.
      { t1:['a','c'], t2:['b','d'], s1:11, s2:6, phase:1, eloDeltas:[70,0,5,0], sessionRanks:[3,2,4,1] },
      // Phase 2-3 ranked — B wins both (A loses both), B gains +60 and climbs 4→1. Counts.
      { t1:['b','c'], t2:['a','d'], s1:11, s2:8, phase:2, eloDeltas:[50,5,-30,-5], sessionRanks:[2,3,3,4] },
      { t1:['b','c'], t2:['a','d'], s1:11, s2:9, phase:3, eloDeltas:[10,2,-8,-2], sessionRanks:[1,3,3,4] },
    ],
  };
  const h = APP._awardsHtml(sess);
  ok(/NIGHT'S AWARDS/.test(h), '_awardsHtml: renders an awards panel');
  ok(/MOST IMPROVED<\/div><div[^>]*>B</.test(h),   '_awardsHtml: Most Improved is ranked-only (B +60, not warm-up A +70)');
  ok(/BIGGEST CLIMBER<\/div><div[^>]*>B</.test(h),  '_awardsHtml: Biggest Climber is ranked-only (B)');
  ok(/HOT HAND<\/div><div[^>]*>B</.test(h),         '_awardsHtml: Hot Hand is ranked-only (B, not warm-up A)');
}
if (APP._ratingSparkHtml) {
  S.db = [{ id:'a', name:'A', rating:1280, isNR:false }];
  S.archive = [
    { id:'s2', players:[{ id:'a', startRating:1220, isNR:false }] },
    { id:'s1', players:[{ id:'a', startRating:1200, isNR:false }] },
  ];
  const h = APP._ratingSparkHtml('a'); // 1200,1220,1280 → 3 pts, +80
  ok(/Rating Trajectory/.test(h), '_ratingSparkHtml: renders trajectory with >=3 points');
  ok(/\+80/.test(h),              '_ratingSparkHtml: net change +80 over the season');
  ok(APP._ratingSparkHtml('nobody') === '', '_ratingSparkHtml: <3 points → empty');
}
if (APP._pvLeaderboardHtml) {
  const lbSess = {
    players: [
      { id:'a', name:'Ann', sRating:1240, startRating:1200, isNR:false, wins:3, losses:0, ptsFor:33, ptsAgainst:18 },
      { id:'b', name:'Bob', sRating:1180, startRating:1200, isNR:false, wins:1, losses:2, ptsFor:25, ptsAgainst:30 },
      { id:'c', name:'Cy',  sRating:1100, startRating:1100, isNR:false, wins:0, losses:2, ptsFor:12, ptsAgainst:22 },
    ], cfRanks:{}, cfLog:[],
  };
  const h = APP._pvLeaderboardHtml(lbSess, 'b', true);
  ok(/LEADERBOARD/.test(h), '_pvLeaderboardHtml: renders a leaderboard');
  ok(/YOU/.test(h), '_pvLeaderboardHtml: highlights the viewed player');
  ok(h.indexOf('Ann') < h.indexOf('Bob'), '_pvLeaderboardHtml: orders by wins (Ann 3W above Bob 1W)');
  ok(APP._pvLeaderboardHtml({players:[{id:'a',name:'A',wins:0,losses:0}]},'a',true) === '', '_pvLeaderboardHtml: <2 players → empty');
  // [consistency sweep] shows point-diff (the tiebreaker) + labels the wins-first basis; not rating
  ok(/ranked by/i.test(h), '_pvLeaderboardHtml: labels the "ranked by wins" basis');
  ok(/\+15/.test(h), '_pvLeaderboardHtml: shows point differential (Ann pd +15), not absolute rating');
}
// [consistency sweep] _sessionLbRows is the SINGLE order used by hero rank + leaderboard + end modal.
// The key invariant: tied on wins → POINT DIFF breaks the tie (NOT rating). This is exactly the
// "Frankie 976 ranks above Morgan 1314" case being correct, and the source of the old confusion.
if (APP._sessionLbRows) {
  const tied = { players: [
    { id:'lo', name:'Lo', wins:2, losses:0, ptsFor:22, ptsAgainst:20, sRating:1300 }, // 2W · pd +2 · high rating
    { id:'hi', name:'Hi', wins:2, losses:0, ptsFor:22, ptsAgainst:10, sRating:900 },  // 2W · pd +12 · low rating
    { id:'lw', name:'Lw', wins:0, losses:2, ptsFor:5,  ptsAgainst:30, sRating:1500 }, // 0W · highest rating
  ]};
  const rows = APP._sessionLbRows(tied);
  eq(rows[0].id, 'hi', '_sessionLbRows: tied wins → higher point-diff wins (not higher rating)');
  eq(rows[2].id, 'lw', '_sessionLbRows: fewer wins ranks last even with the highest rating');
}

// ── Tests: backup/restore + multi-scorer guard are wired ───────────────────
section('backup/restore + multi-scorer guard');
ok(typeof APP.exportBackup === 'function', 'exportBackup() is defined');
ok(typeof APP.importBackup === 'function', 'importBackup() is defined');
ok(typeof APP._multiWriterBannerHtml === 'function', '_multiWriterBannerHtml() is defined');
if (APP._multiWriterBannerHtml) {
  // No recent other-device write (and not a writer-conflict) → banner must be silent (no spurious warning).
  ok(APP._multiWriterBannerHtml() === '', 'multi-scorer banner stays empty with no recent other-device write');
}

// ── Tests: LIVE-PLAY stress — the real confirm → submit → regenerate loop ───
// Drives the actual game loop headlessly (renders/toasts silenced) over many matches, asserting
// the things that would BREAK A LIVE NIGHT: no exception, no court stranded empty, wait bounded.
section('live-play stress — confirm → submit → regenerate (no crash / no stuck court)');
['renderLive','renderHistory','renderStandings','renderDB','renderRoster','renderArchive','updateHeader','updateProgress','startElapsed','startCFTick','toast','updatePvSelect','updatePvSessFilter'].forEach(fn=>{ try{ if(typeof ctx[fn]!=='undefined') ctx[fn]=()=>{}; }catch(e){} });
try {
  makeSession(20, 3);
  if (APP._initSessionRanks) APP._initSessionRanks();
  S.session.cfCourts = { 1:{status:'ready'}, 2:{status:'ready'}, 3:{status:'ready'} };
  S.session.cfSuggestions = {};
  let played = 0, maxGap = 0, stuck = false, err = null;
  for (let step = 0; step < 60 && !err; step++) {
    try {
      // generate for any ready court without a suggestion
      const ready = [1,2,3].filter(c => { const ct=S.session.cfCourts[c]; return (!ct||ct.status!=='playing') && !S.session.cfSuggestions[c]; });
      if (ready.length) {
        CF.batchGenerateSuggestions(ready, null);
      }
      // confirm any court that has a suggestion and isn't already playing
      for (const c of [1,2,3]) if (S.session.cfSuggestions[c] && S.session.cfCourts[c]?.status!=='playing') CF.confirmSuggestion(c);
      // submit a score on each playing court (alternate the winning side)
      for (const c of [1,2,3]) {
        const ct = S.session.cfCourts[c];
        if (ct?.status==='playing' && ct.match) {
          const win = (step + c) % 2 === 0;
          CF._doSubmitScore(c, win ? 11 : (step % 10), win ? (step % 10) : 11);
          played++;
        }
      }
      // invariants
      maxGap = Math.max(maxGap, ...S.session.players.map(sp => CF.matchGap(sp.id)));
      [1,2,3].forEach(c => {
        const ct = S.session.cfCourts[c];
        if ((!ct || ct.status==='ready') && !S.session.cfSuggestions[c] && (S.session.cfQueue||[]).length >= 4) {
          try { CF.batchGenerateSuggestions([c], null); } catch(e) {} // safety-net should fill it
          if (!S.session.cfSuggestions[c] && (S.session.cfQueue||[]).length >= 4) stuck = true;
        }
      });
    } catch(e) { err = e; }
  }
  ok(!err, 'live loop ran 60 steps without throwing' + (err ? ': ' + err.message + '\n' + (err.stack||'') : ''));
  ok(played >= 30, `played a healthy number of matches headlessly (${played})`);
  ok(!stuck, 'no court got permanently stuck (ready + no suggestion while queue ≥ 4)');
  ok(maxGap <= 16, `no runaway wait — max matchGap stayed bounded (${maxGap})`);
} catch(e) {
  fail++; console.error('  ❌ live-play stress threw during setup: ' + (e && e.message) + '\n' + (e && e.stack || ''));
}

// ── Tests: CHAOS — unhappy paths during live play ──────────────────────────
// Injects leave / pause / resume / rejoin / suggestion-swap into the live loop and asserts the
// things you actually worry about: nothing crashes, no court vanishes/stalls, left & paused players
// never end up queued/suggested/on a court, nobody's double-booked, and ranks stay duplicate-free.
section('chaos — leave / pause / resume / swap during live play (no crash / no orphans / ranks valid)');
['renderLive','renderHistory','renderStandings','renderDB','renderRoster','renderRosterModal','renderArchive','updateHeader','updateProgress','startElapsed','startCFTick','toast','openModal','closeModal','updatePvSelect','updatePvSessFilter'].forEach(fn=>{ try{ if(typeof ctx[fn]!=='undefined') ctx[fn]=()=>{}; }catch(e){} });
try {
  const G = ctx, gsp = APP.gsp;
  makeSession(24, 3);
  if (APP._initSessionRanks) APP._initSessionRanks();
  S.session.cfCourts = { 1:{status:'ready'}, 2:{status:'ready'}, 3:{status:'ready'} };
  S.session.cfSuggestions = {};
  let seed = 987654321; const rnd = () => (seed = (seed*1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let err = null, errWhen = '', played = 0;
  const v = { leftQ:0, leftSug:0, leftCourt:0, pauseQ:0, pauseSug:0, pauseCourt:0, dblBook:0, dupRank:0, stuck:0, leaves:0, pauses:0, resumes:0, swaps:0 };
  const _diag = { dup: [], stuck: [] };
  for (let step = 0; step < 90 && !err; step++) {
    try {
      let lastAct = 'play';
      const roll = rnd();
      const queuedActive = (S.session.cfQueue||[]).map(q=>q.id).filter(id => gsp(id)?.status !== 'left');
      if (roll < 0.14 && queuedActive.length > 8) { G.cfPausePlayer(queuedActive[Math.floor(rnd()*queuedActive.length)]); v.pauses++; lastAct='pause'; }
      else if (roll < 0.27 && (S.session.cfPaused||[]).length) { G.cfResumePlayer(S.session.cfPaused[Math.floor(rnd()*S.session.cfPaused.length)].id); v.resumes++; lastAct='resume'; }
      else if (roll < 0.38 && queuedActive.length > 9) { G.midRemove(queuedActive[Math.floor(rnd()*queuedActive.length)]); v.leaves++; lastAct='leave'; }
      else if (roll < 0.46) { const left = S.session.players.filter(p=>p.status==='left'); if (left.length) { G.midRejoin(left[Math.floor(rnd()*left.length)].id); lastAct='rejoin'; } }
      else if (roll < 0.58) {
        const sc = Object.keys(S.session.cfSuggestions).find(c => S.session.cfSuggestions[c]);
        if (sc) { const sug = S.session.cfSuggestions[sc]; const out = sug.allIds[Math.floor(rnd()*sug.allIds.length)];
          // Candidates = any queued, non-left player not already in THIS court's suggestion. Players in
          // another court's pending suggestion ARE allowed (they're not in play) — confirming resolves
          // the transient overlap. This exercises that path; the no-double-book-on-court invariant holds.
          const avail = (S.session.cfQueue||[]).map(q=>q.id).filter(id => !sug.allIds.includes(id) && gsp(id)?.status!=='left');
          if (avail.length) { G._sugPickerApply(sc, out, avail[Math.floor(rnd()*avail.length)]); v.swaps++; lastAct='swap'; } }
      }
      // normal live step
      const ready = [1,2,3].filter(c => { const ct=S.session.cfCourts[c]; return (!ct||ct.status!=='playing') && !S.session.cfSuggestions[c]; });
      if (ready.length) CF.batchGenerateSuggestions(ready, null);
      for (const c of [1,2,3]) if (S.session.cfSuggestions[c] && S.session.cfCourts[c]?.status!=='playing') CF.confirmSuggestion(c);
      // ── on-court invariants (checked WHILE courts are occupied, before scores post) ──
      // The REAL bugs: a player physically on two courts at once, or a LEFT/PAUSED player
      // seated on a court. (Suggestion∩suggestion overlap is an INTENTIONAL transient —
      // overdue players are un-reserved so a ready court can force-seat them, and
      // confirmSuggestion's stale-guard regenerates the colliding court at confirm — so we
      // assert on PLAYING courts, where the stale-guard has already resolved any overlap.)
      const left = new Set(S.session.players.filter(p=>p.status==='left').map(p=>p.id));
      const paused = new Set((S.session.cfPaused||[]).map(q=>q.id));
      const playingNow = [];
      [1,2,3].forEach(c => { const ct=S.session.cfCourts[c]; if (ct?.status==='playing'&&ct.match) playingNow.push(...ct.match.t1, ...ct.match.t2); });
      if (new Set(playingNow).size !== playingNow.length) v.dblBook++;
      playingNow.forEach(id => { if (left.has(id)) v.leftCourt++; if (paused.has(id)) v.pauseCourt++; });
      for (const c of [1,2,3]) { const ct=S.session.cfCourts[c]; if (ct?.status==='playing' && ct.match) { const w=(step+c)%2===0; CF._doSubmitScore(c, w?11:(step%10), w?(step%10):11); played++; } }
      // ── post-step invariants: queue / suggestion hygiene + rank integrity ──
      (S.session.cfQueue||[]).forEach(q => { if (left.has(q.id)) v.leftQ++; if (paused.has(q.id)) v.pauseQ++; });
      const sugIds = []; Object.values(S.session.cfSuggestions||{}).forEach(s => { if (s) sugIds.push(...s.allIds); });
      sugIds.forEach(id => { if (left.has(id)) v.leftSug++; if (paused.has(id)) v.pauseSug++; });
      const activeRankPairs = Object.entries(S.session.cfRanks||{}).filter(([id]) => !left.has(id) && !paused.has(id) && gsp(id)).map(([id,e]) => [id,e.rank]);
      const activeRanks = activeRankPairs.map(p=>p[1]);
      if (new Set(activeRanks).size !== activeRanks.length) {
        v.dupRank++;
        if (_diag.dup.length < 4) {
          const counts = {}; activeRankPairs.forEach(([id,r])=>{ (counts[r]=counts[r]||[]).push(id); });
          const dups = Object.entries(counts).filter(([,ids])=>ids.length>1).map(([r,ids])=>`rank${r}=[${ids.join(',')}]`);
          _diag.dup.push(`step${step} after '${lastAct}': ${dups.join(' ')}`);
        }
      }
      // stuck: a court ready with no suggestion while ≥4 SEATABLE players wait. GENUINELY idle =
      // queued and NOT already committed to another court's pending suggestion. Only if ≥4 such
      // players sit while a court is empty is it actually stranded. (Players in other courts'
      // suggestions are about to play — not free for this court; the engine generates courts
      // jointly, so a court left empty with <4 truly-free players is correct, not stuck.)
      [1,2,3].forEach(c => {
        const ct=S.session.cfCourts[c];
        if ((!ct||ct.status==='ready') && !S.session.cfSuggestions[c]) {
          try{CF.batchGenerateSuggestions([c],null);}catch(e){}
          if (!S.session.cfSuggestions[c]) {
            const otherSug = new Set();
            [1,2,3].forEach(x=>{ if(x!==c && S.session.cfSuggestions[x]) S.session.cfSuggestions[x].allIds.forEach(id=>otherSug.add(id)); });
            const idle = (S.session.cfQueue||[]).filter(q=>!otherSug.has(q.id)).length;
            if (idle>=4) {
              v.stuck++;
              if (_diag.stuck.length < 8) {
                const sugState = [1,2,3].map(x=>`c${x}:${S.session.cfCourts[x]?.status||'-'}/${S.session.cfSuggestions[x]?'sug':'nosug'}`).join(' ');
                _diag.stuck.push(`step${step} after '${lastAct}' court${c}: queue${(S.session.cfQueue||[]).length} otherSug${otherSug.size} idle${idle} | ${sugState}`);
              }
            }
          }
        }
      });
    } catch(e) { err = e; errWhen = 'step ' + step; }
  }
  ok(!err, 'chaos loop ran 90 steps without throwing' + (err ? ` (${errWhen}): ${err.message}\n${err.stack||''}` : ''));
  ok(played >= 20, `matches still got played amid the chaos (${played})`);
  ok(v.leaves+v.pauses+v.resumes+v.swaps >= 10, `chaos events actually fired (leave ${v.leaves} / pause ${v.pauses} / resume ${v.resumes} / swap ${v.swaps})`);
  ok(v.leftQ===0 && v.leftSug===0 && v.leftCourt===0, `LEFT players never queued/suggested/on-court (q${v.leftQ} sug${v.leftSug} court${v.leftCourt})`);
  ok(v.pauseQ===0 && v.pauseSug===0 && v.pauseCourt===0, `PAUSED players never queued/suggested/on-court (q${v.pauseQ} sug${v.pauseSug} court${v.pauseCourt})`);
  ok(v.dblBook===0, `no player double-booked across courts/suggestions (${v.dblBook})`);
  ok(v.dupRank===0, `ranks stayed duplicate-free for active players through every leave/pause/resume (${v.dupRank})`);
  if (v.dupRank) console.error('     DUP DIAG:\n       ' + _diag.dup.join('\n       '));
  ok(v.stuck===0, `no court stranded by a manual change (${v.stuck})`);
  if (v.stuck) console.error('     STUCK DIAG:\n       ' + _diag.stuck.join('\n       '));
} catch(e) { fail++; console.error('  ❌ chaos test setup threw: ' + (e && e.message) + '\n' + (e && e.stack || '')); }

// ── Tests: undo (snapshot + restore of pre-confirm suggestion state) ────────
section('undo — _snapUndo / undoLast restore the pre-action suggestion');
ctx.renderLive = () => {}; // silence the re-render side-effect during the test
makeSession(20, 3);
S.session.cfSuggestions = { 1: { t1: ['p0', 'p1'], t2: ['p2', 'p3'], allIds: ['p0', 'p1', 'p2', 'p3'] } };
CF._snapUndo(1, 'Reshuffle');
ok(CF._undo && CF._undo.court === 1, 'snapshot captured for court 1');
// simulate a reshuffle replacing the whole suggestion
S.session.cfSuggestions = { 1: { t1: ['p4', 'p5'], t2: ['p6', 'p7'], allIds: ['p4', 'p5', 'p6', 'p7'] } };
try { CF.undoLast(); } catch (e) {/* restore happens before render side-effects */}
eq(JSON.stringify(S.session.cfSuggestions[1].allIds), JSON.stringify(['p0', 'p1', 'p2', 'p3']), 'undo restored the pre-reshuffle four');
eq(CF._undo, null, 'undo cleared after use');

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
