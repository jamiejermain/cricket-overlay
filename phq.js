// ─────────────────────────────────────────────────────────────
//  phq.js — turns PlayHQ's public live-scoring data into the
//  overlay's match state ({ setup, tick: { state, event } }).
//
//  Totals, batting/bowling figures, dismissals and fall of wickets
//  come from PlayHQ's structured scorecard. The ball-by-ball feed is
//  used for "this over", the worm, who's on strike and hype screens.
//
//  window.PlayHQ = { Q, gameVars, eventsVars, ingestEvents, build, diff }
// ─────────────────────────────────────────────────────────────
(function () {
  const STATS = 'statistics { type { value } count }';
  const Q = {
    // spectator.playhq.com
    game: `query relayGame($id: ID!, $scope: PeriodScore) { game(id: $id) { id status updatedAt lastEventRecordedAt
      statistics {
        home { coinTossWinningResult { preference } players { id name lineupOrder periodStatistics { period { value } side type ${STATS} status displayOrder } } }
        away { coinTossWinningResult { preference } players { id name lineupOrder periodStatistics { period { value } side type ${STATS} status displayOrder } } }
        shared { period { value } players { playerID teamID role } dismissalType side status type } }
      result {
        home { periods(scope: $scope) { period { value } ${STATS} teamEvents { sequenceNo playerID statistic { count } } type role closureStatus } }
        away { periods(scope: $scope) { period { value } ${STATS} teamEvents { sequenceNo playerID statistic { count } } type role closureStatus } }
        currentPeriod { value primarySide } } } }`,
    events: `query relayEvents($gameID: ID!, $after: Int, $filters: EventFilter) { gameEvents(gameID: $gameID, after: $after, filters: $filters) {
      id title description sportEventStamp eventSection timestamp side period
      ... on ScoreEvent { score } ... on DismissalEvent { icon } ... on ExtraEvent { icon } } }`,
    // api.playhq.com (team names + logos)
    teams: `query relayTeams($gameId: ID!) { discoverGame(gameID: $gameId) { id
      home { ... on DiscoverTeam { id name logo { sizes { url dimensions { width } } } } ... on ProvisionalTeam { name } }
      away { ... on DiscoverTeam { id name logo { sizes { url dimensions { width } } } } ... on ProvisionalTeam { name } } } }`,
  };
  const gameVars = id => ({ id, scope: 'BY_PERIOD' });
  const eventsVars = (gameID, period, side, after) => ({ gameID, filters: { period, side }, ...(after ? { after } : {}) });

  const other = k => (k === 'home' ? 'away' : 'home');
  const stat = list => Object.fromEntries((list || []).map(s => [s.type.value, s.count]));
  const shortName = n => { const p = String(n).trim().split(/\s+/); return p.length > 1 ? `${p[0][0]}. ${p.slice(1).join(' ')}` : String(n); };
  const PERIODS = ['FIRST_INNINGS', 'SECOND_INNINGS'];
  const oversToBalls = o => { o = +o || 0; const w = Math.floor(o + 1e-9); return w * 6 + Math.round((o - w) * 10); };
  const BALL_TYPES = ['ScoreEvent', 'ExtraEvent', 'DismissalEvent'];

  /* ── events cache: { "<PERIOD>|<SIDE>": { id: event } } ──
     `page` is one page of events, newest first. `latest` = it's the newest page,
     so anything newer than its oldest entry that's missing was deleted (scorer undo). */
  function ingestEvents(cache, key, page, latest) {
    const box = cache[key] || (cache[key] = {});
    page = (page || []).filter(Boolean);
    if (latest && page.length) {
      const oldest = Math.min(...page.map(e => +e.timestamp)), ids = new Set(page.map(e => e.id));
      for (const id in box) if (+box[id].timestamp >= oldest && !ids.has(id)) delete box[id];
    }
    if (latest && !page.length) for (const id in box) delete box[id];
    for (const e of page) box[e.id] = e;
    return box;
  }

  // Read one delivery out of PlayHQ's commentary event.
  function parseBall(e) {
    const T = String(e.title || ''), num = (re, d) => { const x = T.match(re); return x ? +x[1] : d; };
    const [o, b] = String(e.sportEventStamp || '0.0').split('.').map(Number);
    const desc = String(e.description || ''), cut = desc.indexOf(' to ');
    const bowler = cut > 0 ? desc.slice(0, cut).trim() : '', facer = cut > 0 ? desc.slice(cut + 4).trim() : '';
    const r = { id: e.id, ts: +e.timestamp, section: e.eventSection, bowler, facer, legal: true, runs: 0, credited: 0, ran: 0, chip: null, wicket: null, boundary: null };
    if (e.__typename === 'ScoreEvent' || e.score != null && !e.icon) {
      const n = e.score === '.' || e.score == null ? 0 : parseInt(e.score, 10) || 0;
      r.runs = r.credited = n; r.boundary = n === 4 || n === 6 ? n : null; r.ran = r.boundary ? 0 : n;
      r.chip = { t: n === 0 ? '•' : String(n), k: n === 0 ? 'dot' : n === 4 ? 'four' : n === 6 ? 'six' : 'run' };
    } else if (e.icon === 'WD') {
      const n = num(/(\d+)\s*wide/i, 1); r.legal = false; r.runs = n; r.ran = n - 1;
      r.chip = { t: n === 1 ? 'wd' : `${n}wd`, k: 'extra' };
    } else if (e.icon === 'NB') {
      const bye = /leg bye/i.test(T) ? 'lb' : /bye/i.test(T) ? 'b' : '';
      const n = num(/(\d+)\s*(?:run|bye|leg)/i, 0); r.legal = false; r.runs = 1 + n; r.ran = n;
      if (bye) r.chip = { t: n ? `nb+${n}${bye}` : 'nb', k: 'extra' };
      else { r.credited = n; r.boundary = n === 4 || n === 6 ? n : null; if (r.boundary) r.ran = 0; r.chip = { t: n ? `${n}nb` : 'nb', k: 'extra' }; }
    } else if (e.icon === 'B' || e.icon === 'LB') {
      const n = num(/(\d+)/, 1); r.runs = n; r.ran = n; r.chip = { t: `${n}${e.icon.toLowerCase()}`, k: 'extra' };
    } else if (e.icon === 'W' || e.__typename === 'DismissalEvent') {
      r.chip = { t: 'W', k: 'wkt' };
      const m = T.match(/^(.+?)\s+(?:was|is)\s+(\w+(?:\s+\w+)?)/i);
      r.wicket = { name: m ? m[1].trim() : facer, how: m ? m[2].toLowerCase() : '' };
    } else return null;
    r.after = r.legal ? o * 6 + b : Math.max(0, o * 6 + b - 1);   // legal balls bowled once this delivery is done
    return r;
  }

  function dismissal(sh, byId) {
    if (!sh) return { how: '', bow: '' };
    const role = r => (sh.players || []).find(p => p.role === r);
    const bw = role('BOWLING'), fd = role('FIELDING') || role('WICKET_KEEPER');
    const bs = bw && byId[bw.playerID] ? shortName(byId[bw.playerID].name) : '', f = fd && byId[fd.playerID] ? shortName(byId[fd.playerID].name) : '';
    switch (sh.dismissalType) {
      case 'BOWLED': return { how: '', bow: `b ${bs}` };
      case 'CAUGHT': return fd && bw && fd.playerID === bw.playerID ? { how: '', bow: `c & b ${bs}` } : { how: f ? `c ${f}` : 'caught', bow: bs ? `b ${bs}` : '' };
      case 'CAUGHT_AND_BOWLED': return { how: '', bow: `c & b ${bs}` };
      case 'LBW': case 'LEG_BEFORE_WICKET': return { how: 'lbw', bow: `b ${bs}` };
      case 'STUMPED': return { how: f ? `st ${f}` : 'stumped', bow: `b ${bs}` };
      case 'HIT_WICKET': return { how: 'hit wicket', bow: `b ${bs}` };
      case 'RUN_OUT': return { how: f ? `run out (${f})` : 'run out', bow: '' };
      default: return { how: String(sh.dismissalType || 'out').toLowerCase().replace(/_/g, ' '), bow: '' };
    }
  }
  const TYPE = { BOWLED: 'bowled', CAUGHT: 'caught', CAUGHT_AND_BOWLED: 'caught', LBW: 'lbw', LEG_BEFORE_WICKET: 'lbw', STUMPED: 'stumped', HIT_WICKET: 'hit wicket', RUN_OUT: 'run out' };

  /* ── build the overlay state ──
     g      = spectator game
     cache  = events cache (see ingestEvents)
     teams  = { home, away } overlay team objects (name, short, colours, logo…)
     meta   = { gameId, setupId, title } */
  function build(g, cache, teams, meta) {
    const res = g.result || {}, per = {}, fowOf = {};
    for (const k of ['home', 'away']) for (const p of (res[k] && res[k].periods) || []) {
      if (!PERIODS.includes(p.period.value)) continue;
      const key = `${p.period.value}|${k.toUpperCase()}`;
      // A side's fall of wickets can sit on either of its records for that innings.
      if ((p.teamEvents || []).length && !(fowOf[key] || []).length) fowOf[key] = p.teamEvents;
      if (p.role === 'BATTING') per[key] = { side: k, period: p.period.value, st: stat(p.statistics), p };
    }
    const evs = key => Object.values(cache[key] || {}).map(parseBall).filter(Boolean).sort((a, b) => a.ts - b.ts);
    const started = (key, x) => x && ((x.st.TOTAL_OVERS || 0) > 0 || (x.st.TOTAL_SCORE || 0) > 0 || (fowOf[key] || []).length || evs(key).length);

    // Which innings exist, in the order they were played.
    let list = Object.entries(per).filter(([key, x]) => started(key, x));
    const firstOf = key => (evs(key)[0] || {}).ts || Infinity;
    list.sort((a, b) => PERIODS.indexOf(a[1].period) - PERIODS.indexOf(b[1].period)
      || ((a[1].st.TARGET_SCORE ? 1 : 0) - (b[1].st.TARGET_SCORE ? 1 : 0)) || firstOf(a[0]) - firstOf(b[0]));
    list = list.slice(0, 2);
    let battingFirst = list.length ? list[0][1].side : null;
    if (!battingFirst) {                                   // nothing bowled yet: go by the toss
      const S = g.statistics || {};
      for (const k of ['home', 'away']) { const t = S[k] && S[k].coinTossWinningResult; if (t && t.preference) battingFirst = /BAT/i.test(t.preference) ? k : other(k); }
      battingFirst = battingFirst || 'home';
    }
    const anyPer = Object.values(per)[0];
    const overs = (list[0] && list[0][1].st.OVER_LIMIT) || (anyPer && anyPer.st.OVER_LIMIT) || 20;
    const byId = {};
    for (const k of ['home', 'away']) for (const p of (g.statistics && g.statistics[k] && g.statistics[k].players) || []) byId[p.id] = p;
    const final = /FINAL|COMPLETE|RESULT/i.test(g.status || '');

    const innings = list.map(([key, x], idx) => {
      const bat = x.side, bowl = other(bat), SIDE = bat.toUpperCase(), P = x.period, st = x.st;
      const ps = p => (p.periodStatistics || []).find(s => s.period.value === P && s.side === SIDE) || null;
      const balls = evs(key);

      // Batters, in batting order, then the rest of the team.
      const squad = ((g.statistics[bat] || {}).players || []).map(p => ({ p, s: ps(p) }));
      squad.sort((a, b) => ((a.s && a.s.displayOrder) ?? 99) - ((b.s && b.s.displayOrder) ?? 99) || (a.p.lineupOrder ?? 99) - (b.p.lineupOrder ?? 99));
      const sharedOut = (g.statistics.shared || []).filter(s => s.period.value === P && s.side === SIDE);
      const batters = squad.map(({ p, s }, id) => {
        const v = stat(s && s.statistics), status = String((s && s.status) || '').toUpperCase();
        const b = { id, pid: p.id, name: p.name, runs: v.TOTAL_RUNS || 0, balls: v.BALLS_FACED || 0, fours: v.FOURS || 0, sixes: v.SIXES || 0, status: 'yet', how: '', bow: '' };
        const hasBatted = s && (s.displayOrder != null || v.BALLS_FACED > 0 || v.TOTAL_RUNS > 0);
        if (status === 'OUT') { const sh = sharedOut.find(o => (o.players || []).some(q => q.role === 'BATTING' && q.playerID === p.id)); b.status = 'out'; Object.assign(b, dismissal(sh, byId)); b.wtype = sh ? TYPE[sh.dismissalType] || String(sh.dismissalType).toLowerCase().replace(/_/g, ' ') : 'out'; }
        else if (/RETIRED/.test(status)) { b.status = 'retired'; b.how = 'retired not out'; }
        else if (status === 'DID_NOT_BAT' || !hasBatted) b.status = 'yet';
        else b.status = 'batting';
        return b;
      });
      const order = batters.filter(b => b.status !== 'yet').map(b => b.id);
      const named = n => batters.find(b => b.name.toLowerCase() === String(n).toLowerCase());

      // Bowlers, in the order they came on.
      const firstBowl = {}; balls.forEach((e, i) => { if (e.bowler && !(e.bowler in firstBowl)) firstBowl[e.bowler] = i; });
      const bowlers = ((g.statistics[bowl] || {}).players || []).map(p => ({ p, v: stat((ps(p) || {}).statistics) }))
        .filter(x => x.v.OVERS != null || x.v.WICKETS != null)
        .map(({ p, v }) => ({ name: p.name, balls: oversToBalls(v.OVERS), maidens: v.MAIDENS || 0, runs: v.RUNS || 0, wkts: v.WICKETS || 0, wd: v.WIDES || 0, nb: v.NO_BALLS || 0 }))
        .sort((a, b) => (firstBowl[a.name] ?? 999) - (firstBowl[b.name] ?? 999));

      const legal = oversToBalls(st.TOTAL_OVERS);
      const runs = st.TOTAL_SCORE || 0, wkts = st.TOTAL_OUTS || 0;

      // Worm (ball by ball from the commentary; the last point is the real total).
      const worm = [{ b: 0, r: 0 }]; let cum = 0;
      for (const e of balls) { cum += e.runs; worm.push({ b: e.after, r: cum }); }
      if (worm.length > 1 || runs) { const last = worm[worm.length - 1]; if (last.b !== legal || last.r !== runs) worm.push({ b: legal, r: runs }); }

      // Fall of wickets.
      const fowBall = {}; balls.filter(e => e.wicket).forEach(e => { fowBall[e.wicket.name.toLowerCase()] = e.after; });
      const fow = (fowOf[key] || []).slice().sort((a, b) => a.sequenceNo - b.sequenceNo).map(t => {
        const name = (byId[t.playerID] || {}).name || '';
        let b = fowBall[name.toLowerCase()];
        if (b == null) { const w = worm.find(pt => pt.r >= t.statistic.count); b = w ? w.b : legal; }
        return { w: t.sequenceNo, r: t.statistic.count, b, name };
      });

      // This over = deliveries in the latest over section.
      const last = balls[balls.length - 1];
      const thisOver = last ? balls.filter(e => e.section === last.section).map(e => e.chip) : [];

      // Who's in, who's on strike, who's bowling.
      const inNow = batters.filter(b => b.status === 'batting').sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).slice(-2);
      let striker = -1, nonStriker = -1;
      if (inNow.length) {
        const facer = last && named(last.facer);
        let s = facer && facer.status === 'batting' ? facer : inNow[inNow.length - 1];
        let n = inNow.find(b => b !== s) || null;
        if (last && facer === s && n) {
          let swap = last.ran % 2 === 1;
          if (last.legal && last.after % 6 === 0) swap = !swap;
          if (swap) [s, n] = [n, s];
        }
        striker = s.id; nonStriker = n ? n.id : -1;
      }
      const bwName = last && last.bowler, bowler = bowlers.findIndex(b => b.name === bwName);
      const overDone = legal > 0 && legal % 6 === 0 && last && last.legal;
      const closure = x.p.closureStatus;
      const target = idx === 1 ? (list[0][1].st.TOTAL_SCORE || 0) + 1 : null;
      const complete = !!closure || legal >= overs * 6 || (inNow.length === 0 && order.length > 1 && wkts >= batters.length - 1)
        || (idx === 1 && runs >= target) || final;
      return { bat, bowl, runs, wkts, legal,
        extras: { wd: st.EXTRA_WIDES || 0, nb: st.EXTRA_NO_BALLS || 0, b: st.EXTRA_BYES || 0, lb: st.EXTRA_LEG_BYES || 0 },
        batters, order, bowlers, striker, nonStriker, bowler, bowlHist: bowlers.map(b => b.name), thisOver,
        needBowler: !!overDone, overStartRuns: 0, worm, fow, complete,
        _lastBall: last ? last.id : null, _balls: balls.length };
    });

    let status = 'live', current = Math.max(0, innings.length - 1);
    if (!innings.length) innings.push(emptyInnings(battingFirst, teams));
    if (final || (innings.length === 2 && innings[1].complete)) status = 'complete';
    else if (innings.length === 1 && innings[0].complete) status = 'break';

    const setup = {
      id: meta.setupId, source: 'playhq', game: meta.gameId,
      match: { title: meta.title || '', oversPerInnings: overs, wideRuns: 1, noBallRuns: 1 },
      teams: {
        home: { ...teams.home, players: playersOf(g, 'home') },
        away: { ...teams.away, players: playersOf(g, 'away') },
      },
      battingFirst,
    };
    const state = { v: 1, innings, current, status, result: '', winner: null };
    return { setup, state };
  }
  function playersOf(g, k) {
    return (((g.statistics || {})[k] || {}).players || []).slice().sort((a, b) => (a.lineupOrder ?? 99) - (b.lineupOrder ?? 99)).map(p => p.name);
  }
  function emptyInnings(bat, teams) {
    return { bat, bowl: other(bat), runs: 0, wkts: 0, legal: 0, extras: { wd: 0, nb: 0, b: 0, lb: 0 }, batters: [], order: [], bowlers: [],
      striker: -1, nonStriker: -1, bowler: -1, bowlHist: [], thisOver: [], needBowler: true, overStartRuns: 0, worm: [{ b: 0, r: 0 }], fow: [], complete: false };
  }

  /* ── what changed since the last publish → the overlay's event ──
     prev/next = { state, cache }. Returns null if nothing worth publishing. */
  function diff(prevState, nextState, nextCache) {
    const P = prevState, N = nextState;
    if (P && JSON.stringify(P) === JSON.stringify(N)) return null;
    const ni = N.innings[N.current] || {}, pi = P && P.innings[N.current];
    if (!P || !pi || !ni._lastBall || pi._lastBall === ni._lastBall || ni._balls < (pi._balls || 0)) return { kind: 'other' };
    // New deliveries since the last publish (normally just one).
    const key = Object.keys(nextCache).find(k => nextCache[k][ni._lastBall]);
    const all = Object.values(nextCache[key] || {}).map(parseBall).filter(Boolean).sort((a, b) => a.ts - b.ts);
    const from = all.findIndex(e => e.id === pi._lastBall), fresh = all.slice(from + 1);
    if (!fresh.length) return { kind: 'other' };
    const lastB = fresh[fresh.length - 1], named = n => ni.batters.find(b => b.name.toLowerCase() === String(n).toLowerCase());
    const wk = [...fresh].reverse().find(e => e.wicket);
    let wicket = null;
    if (wk) {
      const ob = named(wk.wicket.name) || named(wk.facer);
      if (ob) wicket = { type: ob.wtype || wk.wicket.how || 'out', batter: { ...ob }, text: [ob.how, ob.bow].filter(Boolean).join(' ') };
    }
    const facer = named(lastB.facer) || ni.batters[ni.striker] || { name: lastB.facer, runs: 0, balls: 0 };
    const prevLegal = pi.legal || 0;
    void prevLegal;
    const overComplete = fresh.some(e => e.legal && e.after > 0 && e.after % 6 === 0);
    const inningsComplete = !pi.complete && !!ni.complete;
    return { kind: 'ball', runs: lastB.runs, boundary: lastB.boundary, wicket, credited: lastB.credited, batter: { ...facer }, overComplete, inningsComplete };
  }

  window.PlayHQ = { Q, gameVars, eventsVars, ingestEvents, build, diff, parseBall, oversToBalls };
})();
