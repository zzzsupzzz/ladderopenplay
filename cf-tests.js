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
  importBackup:typeof importBackup!=='undefined'?importBackup:null};`;

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
section('_sessPhaseNum() — progress-based phase boundaries (np*0.6, np*1.2)');
makeSession(20, 3); // np=20 → P1<12, P2<24, P3>=24
S.session.cfMatchCount = 0;  eq(CF._sessPhaseNum(), 1, 'mc 0 → phase 1');
S.session.cfMatchCount = 11; eq(CF._sessPhaseNum(), 1, 'mc 11 → phase 1');
S.session.cfMatchCount = 12; eq(CF._sessPhaseNum(), 2, 'mc 12 → phase 2');
S.session.cfMatchCount = 23; eq(CF._sessPhaseNum(), 2, 'mc 23 → phase 2');
S.session.cfMatchCount = 24; eq(CF._sessPhaseNum(), 3, 'mc 24 → phase 3');

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
  const tight = CF._scoreGroup(mk([0, 1, 2, 3]), null);   // four near-equal players
  const wide = CF._scoreGroup(mk([0, 1, 18, 19]), null);  // top-2 + bottom-2
  ok(tight && wide, 'scoreGroup returns a result for both foursomes');
  ok(tight.score < wide.score, 'tight-rank foursome scores better (lower) than a wide one');
  // best split of [top,top,bottom,bottom] should pair strong+weak to balance teams
  const ids = wide.t1.map(p => p.id).concat(wide.t2.map(p => p.id));
  ok(ids.length === 4, 'scoreGroup produces a 4-player split (2v2)');
} catch (e) {
  fail++; console.error('  ❌ _scoreGroup threw: ' + (e && e.message) + '\n' + (e && e.stack || ''));
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
}
if (APP._tierOf) {
  eq(APP._tierOf(1, 20).key,  3, '_tierOf: rank 1/20 → Gold');
  eq(APP._tierOf(5, 20).key,  3, '_tierOf: rank 5/20 (25%) → Gold');
  eq(APP._tierOf(6, 20).key,  2, '_tierOf: rank 6/20 (30%) → Silver');
  eq(APP._tierOf(13, 20).key, 1, '_tierOf: rank 13/20 (65%) → Bronze');
  ok(APP._tierOf(0, 20) === null, '_tierOf: rank 0 → null');
}
if (APP._awardsHtml) {
  const sess = {
    players: [
      { id:'a', name:'A', sRating:1250, startRating:1200, isNR:false, wins:3, losses:0, matchesPlayed:3 },
      { id:'b', name:'B', sRating:1180, startRating:1200, isNR:false, wins:1, losses:2 },
      { id:'c', name:'C', sRating:1090, startRating:1100, isNR:false, wins:1, losses:2 },
      { id:'d', name:'D', sRating:1070, startRating:1100, isNR:false, wins:1, losses:2 },
    ],
    cfRanks: { a:{initRank:4,rank:1}, b:{initRank:1,rank:2}, c:{initRank:2,rank:3}, d:{initRank:3,rank:4} },
    cfLog: [
      { t1:['a','c'], t2:['b','d'], s1:11, s2:6, sessionRanks:[4,2,1,3] },
      { t1:['a','d'], t2:['b','c'], s1:11, s2:8, sessionRanks:[1,4,2,3] },
      { t1:['a','b'], t2:['c','d'], s1:11, s2:9, sessionRanks:[1,2,3,4] },
    ],
  };
  const h = APP._awardsHtml(sess);
  ok(/NIGHT'S AWARDS/.test(h), '_awardsHtml: renders an awards panel');
  ok(/MOST IMPROVED/.test(h),  '_awardsHtml: includes Most Improved (A +50)');
  ok(/HOT HAND/.test(h),       '_awardsHtml: includes Hot Hand (A won 3)');
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

// ── Tests: [CHALLENGE COURT] middle court reserved for the session top-6 ────
section('Challenge Court — middle court holds only the session top-6');
try {
  const CCNUM = Math.ceil(3/2); // middle court of 3 = court 2
  makeSession(20, 3);
  if (APP._initSessionRanks) APP._initSessionRanks();
  // Phase 2+ (np=20 → mc≥12), everyone recently played (not force-overdue), clear standings.
  S.session.cfMatchCount = 15;
  S.session.players.forEach((sp, i) => { sp.matchesPlayed=3; sp.lastPlayedAtMatch=15; sp.lastConfirmedAtMatch=15; sp.wins=20-i; sp.losses=i; sp.ptsFor=60; sp.ptsAgainst=40; });
  S.session.cfChallengeCourt = true;
  S.session.cfCourts = { 1:{status:'ready'}, 2:{status:'ready'}, 3:{status:'ready'} };
  S.session.cfSuggestions = {};
  CF.batchGenerateSuggestions([1,2,3], null);
  const top6 = APP._sessionLbRows(S.session).slice(0,6).map(p=>p.id);
  const cc = S.session.cfSuggestions[CCNUM];
  ok(cc && Array.isArray(cc.allIds), `challenge court (middle = #${CCNUM}) got a suggestion`);
  ok(cc && cc.allIds.every(id=>top6.includes(id)), 'challenge court contains ONLY the current top-6');
  ok(cc && cc.meta && cc.meta.challenge === true, 'challenge court is flagged as a challenge match');
  const others = [1,2,3].filter(c=>c!==CCNUM).flatMap(c => { const s = S.session.cfSuggestions[c]; return s ? s.allIds : []; });
  ok(others.length > 0 && others.every(id => !top6.includes(id)), 'top-6 never appear on the non-challenge courts');
  // Default OFF: same setup, no flag → middle court is a normal match
  S.session.cfChallengeCourt = false;
  S.session.cfSuggestions = {};
  CF.batchGenerateSuggestions([1,2,3], null);
  const ccoff = S.session.cfSuggestions[CCNUM];
  ok(!(ccoff && ccoff.meta && ccoff.meta.challenge), 'Challenge OFF → middle court is a normal match');
  // ADAPTIVE GATE: too few players (13 < K6 + (3-1)*4 = 14) → does NOT engage even when ON
  makeSession(13, 3);
  if (APP._initSessionRanks) APP._initSessionRanks();
  S.session.cfMatchCount = 15;
  S.session.players.forEach((sp,i)=>{ sp.matchesPlayed=3; sp.lastPlayedAtMatch=15; sp.lastConfirmedAtMatch=15; sp.wins=13-i; sp.losses=i; });
  S.session.cfChallengeCourt = true;
  S.session.cfCourts = { 1:{status:'ready'}, 2:{status:'ready'}, 3:{status:'ready'} };
  S.session.cfSuggestions = {};
  CF.batchGenerateSuggestions([1,2,3], null);
  const ccThin = S.session.cfSuggestions[CCNUM];
  ok(!(ccThin && ccThin.meta && ccThin.meta.challenge), 'adaptive gate: too few players → challenge court does NOT engage');
} catch (e) {
  fail++; console.error('  ❌ Challenge Court test threw: ' + (e && e.message) + '\n' + (e && e.stack || ''));
}

// ── Tests: LIVE-PLAY stress — the real confirm → submit → regenerate loop ───
// Drives the actual game loop headlessly (renders/toasts silenced) over many matches with the
// Challenge Court ON, asserting the things that would BREAK A LIVE NIGHT: no exception, no court
// stranded empty, wait stays bounded, and the challenge court never holds a non-top-6 player.
section('live-play stress — confirm → submit → regenerate (no crash / no stuck court)');
['renderLive','renderHistory','renderStandings','renderDB','renderRoster','renderArchive','updateHeader','updateProgress','startElapsed','startCFTick','toast','updatePvSelect','updatePvSessFilter'].forEach(fn=>{ try{ if(typeof ctx[fn]!=='undefined') ctx[fn]=()=>{}; }catch(e){} });
try {
  makeSession(20, 3);
  if (APP._initSessionRanks) APP._initSessionRanks();
  S.session.cfChallengeCourt = true; // exercise the Challenge Court under live play too
  S.session.cfCourts = { 1:{status:'ready'}, 2:{status:'ready'}, 3:{status:'ready'} };
  S.session.cfSuggestions = {};
  let played = 0, maxGap = 0, stuck = false, ccBreach = 0, err = null;
  const top6 = () => new Set(APP._sessionLbRows(S.session).slice(0,6).map(p=>p.id));
  for (let step = 0; step < 60 && !err; step++) {
    try {
      // generate for any ready court without a suggestion
      const ready = [1,2,3].filter(c => { const ct=S.session.cfCourts[c]; return (!ct||ct.status!=='playing') && !S.session.cfSuggestions[c]; });
      if (ready.length) {
        CF.batchGenerateSuggestions(ready, null);
        // Validate the challenge invariant AT FORMATION TIME (before submits shuffle the standings):
        // a freshly-generated court-2 challenge suggestion must contain only the current top-6.
        if (ready.includes(2) && CF._sessPhaseNum() >= 2) {
          const cc = S.session.cfSuggestions[2];
          if (cc && cc.meta && cc.meta.challenge) { const t = top6(); if (!cc.allIds.every(id => t.has(id))) ccBreach++; }
        }
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
  ok(ccBreach === 0, `challenge court never held a non-top-6 player during live play (${ccBreach})`);
} catch(e) {
  fail++; console.error('  ❌ live-play stress threw during setup: ' + (e && e.message) + '\n' + (e && e.stack || ''));
}

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
