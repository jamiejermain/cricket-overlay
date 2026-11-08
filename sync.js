// ─────────────────────────────────────────────────────────────
//  sync.js — passes the live match from the scorer to the overlay.
//
//  Cloud mode: the cricket-live API on AWS (address in backend.js).
//    put/get   → PUT/GET /ch/<code>/doc/<path>   (writes need the scorer key)
//    listen    → polls /ch/<code>/feed about once a second; only
//                'live', 'cmd' and 'prefs' can be listened to.
//  Local mode (no backend, or ?local): only other tabs in the same
//  browser see updates. Handy for trying things out offline.
// ─────────────────────────────────────────────────────────────
(function () {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const B = window.CRICKET_BACKEND || {};

  class CricketSync {
    constructor({ api, ch, key }) {
      this.api = String(api !== undefined ? api : B.api || '').trim().replace(/\/+$/, '');
      this.ch = ch; this.key = key || '';
      this.mode = this.api ? 'cloud' : 'local';
      this.onStatus = () => {};
      this.pending = {}; this.inflight = {};
      this.subs = {}; this.polling = false; this.interval = 1000;
      if (this.mode === 'local' && 'BroadcastChannel' in window) this.bc = new BroadcastChannel('cc-' + ch);
    }
    url(path) { return `${this.api}/ch/${encodeURIComponent(this.ch)}/doc/${path}`; }
    lkey(path) { return `cc:${this.ch}:${path}`; }
    get busy() { return Object.keys(this.pending).length > 0 || Object.values(this.inflight).some(Boolean); }
    headers() { return { 'content-type': 'application/json', ...(this.key ? { 'x-scorer-key': this.key } : {}) }; }

    // Write a value. Latest value wins; failed writes retry until they land.
    put(path, data) {
      if (this.mode === 'local') {
        try { localStorage.setItem(this.lkey(path), JSON.stringify(data)); } catch (e) {}
        if (this.bc) this.bc.postMessage({ path, data });
        this.onStatus('local');
        return;
      }
      this.pending[path] = { data };
      this.flush(path);
    }
    async flush(path) {
      if (this.inflight[path] || !this.pending[path]) return;
      const p = this.pending[path]; delete this.pending[path];
      this.inflight[path] = true; this.onStatus('saving');
      try {
        const r = await fetch(this.url(path), { method: 'PUT', headers: this.headers(), body: JSON.stringify(p.data) });
        if (r.status === 401 || r.status === 403) throw new Error('denied');
        if (r.status === 413) throw new Error('toobig');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        this.inflight[path] = false;
        if (this.pending[path]) this.flush(path); else if (!this.busy) this.onStatus('ok');
      } catch (e) {
        this.inflight[path] = false;
        if (e.message === 'toobig') { this.onStatus('toobig'); return; }   // retrying won't help
        if (!this.pending[path]) this.pending[path] = p;
        this.onStatus(e.message === 'denied' ? 'denied' : 'retry');
        setTimeout(() => this.flush(path), 2500);
      }
    }
    async get(path) {
      if (this.mode === 'local') { try { return JSON.parse(localStorage.getItem(this.lkey(path))); } catch (e) { return null; } }
      const r = await fetch(this.url(path), { headers: this.headers(), cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }

    // Call cb(value) now and whenever it changes.
    listen(path, cb) {
      if (this.mode === 'local') {
        this.get(path).then(cb);
        if (this.bc) this.bc.addEventListener('message', e => { if (e.data.path === path) cb(e.data.data); });
        else addEventListener('storage', e => { if (e.key === this.lkey(path)) cb(e.newValue ? JSON.parse(e.newValue) : null); });
        return;
      }
      this.subs[path] = cb;
      if (!this.polling) { this.polling = true; this.poll(); }
    }
    async poll() {
      let rev = -1, srev = -1, setup = null, first = true; const seen = {};
      for (;;) {
        try {
          const r = await fetch(`${this.api}/ch/${encodeURIComponent(this.ch)}/feed?rev=${rev}&srev=${srev}`, { cache: 'no-store' });
          if (r.status === 200) {
            const f = await r.json();
            if (f.live && f.live.setup) setup = f.live.setup;
            if (!f.live) setup = null;
            srev = f.revs.setup;
            const docs = { live: f.live ? { setup, tick: f.live.tick } : null, cmd: f.cmd, prefs: f.prefs };
            for (const k of ['live', 'cmd', 'prefs']) {
              if (first || f.revs[k] !== seen[k]) { seen[k] = f.revs[k]; if (this.subs[k]) this.subs[k](docs[k]); }
            }
            rev = f.rev; first = false;
          } else if (r.status !== 204) throw new Error('HTTP ' + r.status);
          this.onStatus('ok');
          await sleep(this.interval);
        } catch (e) {
          this.onStatus('retry');
          await sleep(2500);
        }
      }
    }
  }
  window.CricketSync = CricketSync;
})();
