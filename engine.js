// ─────────────────────────────────────────────────────────────
//  engine.js — the cricket scoring model, shared by the scorer
//  app and the overlay. A match is a setup plus a list of
//  actions; replaying the actions gives the current state, so
//  "undo" is just dropping the last action.
//
//  Actions:
//    { t:'open', striker, nonStriker, bowler? }   openers (2nd innings starts with this too)
//    { t:'bowler', name, mid? }                    bowler for the new over (mid = mid-over change)
//    { t:'ball', runs, extra?, wicket?, next? }    a delivery
//         extra:  'wd' | 'nb' | 'b' | 'lb'
//         wicket: { type, fielder?, out?: 'striker'|'nonStriker' }
//         next:   id of the incoming batter after a wicket
//    { t:'swap' }                                  change strike
//    { t:'retire', who, next? }                    retired not out
//    { t:'end' }                                   end the innings early
// ─────────────────────────────────────────────────────────────
(function () {
  const other = k => (k === 'home' ? 'away' : 'home');
  const oversStr = b => `${Math.floor(b / 6)}.${b % 6}`;
  const surname = n => String(n).trim().split(/\s+/).slice(-1)[0].toUpperCase();
  const shortName = n => { const p = String(n).trim().split(/\s+/); return p.length > 1 ? `${p[0][0]}. ${p.slice(1).join(' ')}` : String(n); };
  const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');
  // Firebase can hand arrays back as objects (or with gaps) — normalise.
  const list = v => Array.isArray(v) ? v.filter(x => x != null)
    : v && typeof v === 'object' ? Object.keys(v).sort((a, b) => a - b).map(k => v[k]).filter(x => x != null) : [];
  const BOWLER_WICKETS = ['bowled', 'caught', 'lbw', 'stumped', 'hit wicket'];

  class Match {
    constructor(cfg) { this.cfg = cfg; this.reset(); }
    reset() { this.innings = [this.newInnings(this.cfg.battingFirst || 'home')]; this.current = 0; this.status = 'live'; this.result = ''; this.winner = null; }
    newInnings(batKey) {
      const batters = list(this.cfg.teams[batKey].players).map((name, i) => ({ id: i, name, runs: 0, balls: 0, fours: 0, sixes: 0, status: 'yet', how: '', bow: '' }));
      return { bat: batKey, bowl: other(batKey), runs: 0, wkts: 0, legal: 0, extras: { wd: 0, nb: 0, b: 0, lb: 0 }, batters, order: [], bowlers: [],
        striker: -1, nonStriker: -1, bowler: -1, bowlHist: [], thisOver: [], needBowler: true, overStartRuns: 0,
        worm: [{ b: 0, r: 0 }], fow: [], complete: false };
    }
    get inn() { return this.innings[this.current]; }
    get target() { return this.innings[0].runs + 1; }
    get overs() { return +(this.cfg.match && this.cfg.match.oversPerInnings) || 20; }
    get needOpeners() { return this.status === 'break' || (this.status === 'live' && this.inn.striker < 0); }
    get needBowler() { return this.status === 'live' && !this.needOpeners && this.inn.needBowler; }
    team(k) { return this.cfg.teams[k]; }
    maxWkts(inn = this.inn) { return Math.max(1, inn.batters.length - 1); }
    available(inn = this.inn) { return [...inn.batters.filter(b => b.status === 'yet'), ...inn.batters.filter(b => b.status === 'retired')]; }
    bringIn(slot, id) {
      const inn = this.inn; let b = id != null ? inn.batters[id] : null;
      if (!b || !(b.status === 'yet' || b.status === 'retired')) b = this.available()[0];
      if (!b) { inn[slot] = -1; return; }
      b.status = 'batting'; b.how = ''; b.bow = '';
      if (!inn.order.includes(b.id)) inn.order.push(b.id);
      inn[slot] = b.id;
    }
    setBowler(name, mid) {
      const inn = this.inn; let i = inn.bowlers.findIndex(b => b.name === name);
      if (i < 0) { inn.bowlers.push({ name, balls: 0, maidens: 0, runs: 0, wkts: 0, wd: 0, nb: 0 }); i = inn.bowlers.length - 1; }
      inn.bowler = i;
      if (!mid) { inn.bowlHist.push(name); inn.overStartRuns = inn.bowlers[i].runs; inn.thisOver = []; }
      inn.needBowler = false;
    }
    startSecondInnings() { this.innings.push(this.newInnings(other(this.innings[0].bat))); this.current = 1; this.status = 'live'; }
    endInnings() {
      const inn = this.inn; if (inn.complete) return;
      inn.complete = true;
      if (this.current === 0) this.status = 'break'; else { this.status = 'complete'; this.computeResult(); }
    }

    apply(a) {
      if (!a || this.status === 'complete') return null;
      const inn = this.inn;
      switch (a.t) {
        case 'open':
          if (this.status === 'break') this.startSecondInnings();
          this.bringIn('striker', a.striker); this.bringIn('nonStriker', a.nonStriker);
          if (a.bowler) this.setBowler(a.bowler);
          return null;
        case 'bowler': this.setBowler(a.name, a.mid); return null;
        case 'swap': [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker]; return null;
        case 'retire': {
          const slot = a.who === 'nonStriker' ? 'nonStriker' : 'striker', b = inn.batters[inn[slot]];
          if (b) { b.status = 'retired'; b.how = 'retired not out'; b.bow = ''; }
          this.bringIn(slot, a.next); return null;
        }
        case 'end': this.endInnings(); return null;
        case 'ball': return this.status === 'live' ? this.bowl(a) : null;
      }
      return null;
    }

    bowl(o) {
      const inn = this.inn, mc = this.cfg.match || {};
      if (inn.bowler < 0 || inn.striker < 0) return null;
      const bw = inn.bowlers[inn.bowler], st = inn.batters[inn.striker];
      const runs = +o.runs || 0, ex = o.extra || null, legal = ex !== 'wd' && ex !== 'nb';
      const wdPen = mc.wideRuns != null ? +mc.wideRuns : 1, nbPen = mc.noBallRuns != null ? +mc.noBallRuns : 1;
      let total, chip;
      if (ex === 'wd') { total = wdPen + runs; inn.extras.wd += total; bw.runs += total; bw.wd++; chip = { t: total === 1 ? 'wd' : `${total}wd`, k: 'extra' }; }
      else if (ex === 'nb') {
        // o.nbx = 'b' | 'lb' when the runs off a no-ball were byes / leg byes (not off the bat)
        total = nbPen + runs; inn.extras.nb += nbPen; st.balls++; bw.nb++;
        if (o.nbx === 'b' || o.nbx === 'lb') { inn.extras[o.nbx] += runs; bw.runs += nbPen; chip = { t: runs ? `nb+${runs}${o.nbx}` : 'nb', k: 'extra' }; }
        else { st.runs += runs; bw.runs += total; chip = { t: runs ? `${runs}nb` : 'nb', k: 'extra' }; }
      }
      else if (ex === 'b' || ex === 'lb') { total = runs; inn.extras[ex] += runs; st.balls++; chip = { t: `${runs}${ex}`, k: 'extra' }; }
      else { total = runs; st.runs += runs; st.balls++; bw.runs += runs; chip = { t: runs === 0 ? '•' : String(runs), k: runs === 0 ? 'dot' : runs === 4 ? 'four' : runs === 6 ? 'six' : 'run' }; }
      const offBat = !ex || (ex === 'nb' && !o.nbx);
      const boundary = offBat && (runs === 4 || runs === 6) ? runs : null;
      if (boundary === 4) st.fours++; if (boundary === 6) st.sixes++;
      if (legal) { inn.legal++; bw.balls++; }
      inn.runs += total;

      const w = o.wicket || null;
      const outId = w ? (w.type === 'run out' && w.out === 'nonStriker' ? inn.nonStriker : inn.striker) : -1;
      const ran = ex === 'wd' ? runs : boundary ? 0 : runs;
      if (ran % 2 === 1) [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];

      let wicket = null, allOut = false;
      if (w) {
        const ob = inn.batters[outId], bs = shortName(bw.name), f = w.fielder ? shortName(w.fielder) : '';
        ob.status = 'out';
        switch (w.type) {
          case 'bowled': ob.how = ''; ob.bow = `b ${bs}`; break;
          case 'caught':
            if (w.fielder && w.fielder === bw.name) { ob.how = ''; ob.bow = `c & b ${bs}`; }
            else { ob.how = f ? `c ${f}` : 'caught'; ob.bow = `b ${bs}`; } break;
          case 'lbw': ob.how = 'lbw'; ob.bow = `b ${bs}`; break;
          case 'stumped': ob.how = f ? `st ${f}` : 'stumped'; ob.bow = `b ${bs}`; break;
          case 'hit wicket': ob.how = 'hit wicket'; ob.bow = `b ${bs}`; break;
          case 'run out': ob.how = f ? `run out (${f})` : 'run out'; ob.bow = ''; break;
          default: ob.how = w.type; ob.bow = '';
        }
        if (BOWLER_WICKETS.includes(w.type)) bw.wkts++;
        inn.wkts++; inn.fow.push({ w: inn.wkts, r: inn.runs, b: inn.legal, name: ob.name });
        chip = { t: 'W', k: 'wkt' };
        wicket = { type: w.type, batter: { ...ob }, text: [ob.how, ob.bow].filter(Boolean).join(' ') };
        const slot = inn.striker === outId ? 'striker' : 'nonStriker';
        if (inn.wkts >= this.maxWkts() || this.available().length === 0) allOut = true;
        else this.bringIn(slot, o.next);
      }
      inn.thisOver.push(chip);
      inn.worm.push({ b: inn.legal, r: inn.runs });

      const overComplete = legal && inn.legal % 6 === 0;
      if (overComplete) {
        if (bw.runs - inn.overStartRuns === 0) bw.maidens++;
        [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];
        inn.needBowler = true;
      }
      const inningsComplete = allOut || inn.legal >= this.overs * 6 || (this.current === 1 && inn.runs >= this.target);
      if (inningsComplete) this.endInnings();
      const credited = offBat ? runs : 0;
      return { runs: total, extra: ex, boundary, wicket, credited, batter: { ...st }, overComplete, inningsComplete };
    }

    computeResult() {
      const a = this.innings[0], b = this.innings[1], A = this.team(a.bat), B = this.team(b.bat);
      if (b.runs >= this.target) { const w = this.maxWkts(b) - b.wkts; this.winner = b.bat; this.result = `${B.name.toUpperCase()} WIN BY ${w} WICKET${w === 1 ? '' : 'S'}`; }
      else if (b.runs === a.runs) { this.winner = null; this.result = 'MATCH TIED'; }
      else { const r = a.runs - b.runs; this.winner = a.bat; this.result = `${A.name.toUpperCase()} WIN BY ${r} RUN${r === 1 ? '' : 'S'}`; }
    }
  }

  // Lines the score bar status rotates through (first = main status).
  function statusList(m) {
    const inn = m.inn;
    if (m.status === 'complete') return [m.result];
    if (m.status === 'break') return [`TARGET ${m.target}`, 'INNINGS BREAK'];
    const f = inn.fow[inn.fow.length - 1], pr = inn.runs - (f ? f.r : 0), pb = inn.legal - (f ? f.b : 0);
    const extra = inn.legal >= 6 ? [`P'SHIP ${pr} (${pb})`] : [];
    if (m.current === 0) return ['1ST INNINGS', ...(inn.legal >= 6 ? [`RUN RATE ${(inn.runs / (inn.legal / 6)).toFixed(2)}`] : []), ...extra];
    const need = m.target - inn.runs, balls = m.overs * 6 - inn.legal;
    return [`NEED ${need} OFF ${balls} BALL${balls === 1 ? '' : 'S'}`, `REQ. RATE ${(need / Math.max(1, balls) * 6).toFixed(2)}`, ...extra];
  }

  function replay(setup, actions) {
    const m = new Match(setup); let ev = null;
    for (const a of list(actions)) ev = m.apply(a);
    return { m, ev };
  }

  // ── The published match state ─────────────────────────────
  // This plain-JSON snapshot is the ONE format the overlay reads.
  // The scorer app produces it from its actions; a PlayHQ webhook
  // receiver will produce the same thing from PlayHQ's data.
  function toState(m) {
    return { v: 1, innings: m.innings, current: m.current, status: m.status, result: m.result, winner: m.winner };
  }
  function fromState(setup, s) {
    const m = Object.create(Match.prototype);
    m.cfg = setup;
    m.current = s.current || 0; m.status = s.status || 'live'; m.result = s.result || ''; m.winner = s.winner || null;
    m.innings = list(s.innings).map(i => ({
      ...i,
      extras: { wd: 0, nb: 0, b: 0, lb: 0, ...(i.extras || {}) },
      batters: list(i.batters).map(b => ({ how: '', bow: '', ...b })),
      bowlers: list(i.bowlers), order: list(i.order), bowlHist: list(i.bowlHist),
      thisOver: list(i.thisOver), worm: list(i.worm).length ? list(i.worm) : [{ b: 0, r: 0 }], fow: list(i.fow),
    }));
    if (!m.innings.length) m.innings = [m.newInnings(setup.battingFirst || 'home')];
    return m;
  }
  function normaliseSetup(setup) {
    for (const k of ['home', 'away']) setup.teams[k].players = list(setup.teams[k].players);
    return setup;
  }

  window.CricketEngine = { Match, replay, toState, fromState, normaliseSetup, statusList, other, oversStr, surname, shortName, ordinal, list };
})();
