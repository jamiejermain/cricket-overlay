// ─────────────────────────────────────────────────────────────
//  sync.js — passes the live match from the scorer to the overlay.
//
//  Cloud mode: a Firebase Realtime Database, talked to over plain
//  REST + EventSource (no SDK). Everything for one stream lives
//  under /ch/<channel>/ so the overlay link never changes.
//
//  Local mode (no database URL): only other tabs in the same
//  browser see updates. Handy for trying things out.
// ─────────────────────────────────────────────────────────────
(function () {
  function setPath(root, path, data) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return data;
    root = root && typeof root === 'object' ? root : {};
    let o = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (data === null) delete o[last]; else o[last] = data;
    return root;
  }

  class CricketSync {
    constructor({ db, ch }) {
      this.db = (db || '').trim().replace(/\/+$/, '');
      this.ch = ch;
      this.mode = this.db ? 'cloud' : 'local';
      this.onStatus = () => {};
      this.pending = {}; this.inflight = {};
      if (this.mode === 'local' && 'BroadcastChannel' in window) this.bc = new BroadcastChannel('cc-' + ch);
    }
    url(path) { return `${this.db}/ch/${encodeURIComponent(this.ch)}/${path}.json`; }
    lkey(path) { return `cc:${this.ch}:${path}`; }
    get busy() { return Object.keys(this.pending).length > 0 || Object.values(this.inflight).some(Boolean); }

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
        const r = await fetch(this.url(path), { method: 'PUT', body: JSON.stringify(p.data) });
        if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'denied' : 'HTTP ' + r.status);
        this.inflight[path] = false;
        if (this.pending[path]) this.flush(path); else if (!this.busy) this.onStatus('ok');
      } catch (e) {
        this.inflight[path] = false;
        if (!this.pending[path]) this.pending[path] = p;
        this.onStatus(e.message === 'denied' ? 'denied' : 'retry');
        setTimeout(() => this.flush(path), 2500);
      }
    }
    async get(path) {
      if (this.mode === 'local') { try { return JSON.parse(localStorage.getItem(this.lkey(path))); } catch (e) { return null; } }
      const r = await fetch(this.url(path));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }

    // Call cb(value) now and on every change.
    listen(path, cb) {
      if (this.mode === 'local') {
        this.get(path).then(cb);
        if (this.bc) this.bc.addEventListener('message', e => { if (e.data.path === path) cb(e.data.data); });
        else addEventListener('storage', e => { if (e.key === this.lkey(path)) cb(e.newValue ? JSON.parse(e.newValue) : null); });
        return;
      }
      let value = null;
      const es = new EventSource(this.url(path));
      es.addEventListener('put', e => { const { path: p, data } = JSON.parse(e.data); value = p === '/' ? data : setPath(value, p, data); cb(value); this.onStatus('ok'); });
      es.addEventListener('patch', e => {
        const { path: p, data } = JSON.parse(e.data);
        for (const k in data) value = setPath(value, `${p === '/' ? '' : p}/${k}`, data[k]);
        cb(value);
      });
      es.addEventListener('cancel', () => this.onStatus('denied'));
      es.onerror = () => this.onStatus('retry');
      return es;
    }
  }
  window.CricketSync = CricketSync;
})();
