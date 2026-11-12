// Service worker checks: shell caching, offline fallback, and that API data is never cached.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'public', 'sw.js'), 'utf8');

const results = [];
const check = (name, cond, extra = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '   <- ' + extra}`); };
const origin = 'http://localhost';
const listeners = {}, stores = new Map(), network = new Map();
let offline = false, skipped = false, claimed = false;
const shellBody = { '/earn-it.html': 'APP-HTML', '/manifest.webmanifest': '{}', '/icon.svg': '<svg/>', '/icon-192.png': 'png', '/icon-512.png': 'png', '/': 'APP-HTML' };
const ctx = {
  self: {
    location: { origin },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: async () => { skipped = true; },
    clients: { claim: async () => { claimed = true; } },
  },
  URL,
  Promise,
  caches: {
    open: async name => {
      const cache = stores.get(name) ?? (stores.set(name, new Map()), stores.get(name));
      return {
        addAll: async urls => { for (const u of urls) cache.set(new URL(u, origin).href, shellBody[u] ?? ''); },
        put: async (req, res) => { cache.set(typeof req === 'string' ? new URL(req, origin).href : req.url, res.body); },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async k => stores.delete(k),
    match: async req => {
      const url = typeof req === 'string' ? new URL(req, origin).href : req.url;
      for (const c of stores.values()) if (c.has(url)) return { body: c.get(url), ok: true };
      return undefined;
    },
  },
  fetch: async req => {
    if (offline) throw new TypeError('offline');
    return { ok: true, body: 'LIVE:' + req.url, clone() { return this; } };
  },
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

let respondWith;
const evt = (url, method = 'GET', mode = 'cors') => ({ request: { url, method, mode }, respondWith: p => { respondWith = p; } });
const run = async (url, method, mode) => { respondWith = undefined; listeners.fetch(evt(url, method, mode)); return respondWith === undefined ? undefined : respondWith; };

let pInstall;
listeners.install({ waitUntil: p => { pInstall = p; } });
await pInstall;
check('install pre-caches the app shell', stores.get('earn-it-shell-v4')?.has(origin + '/earn-it.html'));
check('install skips waiting', skipped);
let pAct;
listeners.activate({ waitUntil: p => { pAct = p; } });
await pAct;
check('activate claims open pages', claimed);

const cachedRes = await run(origin + '/earn-it.html', 'GET', 'same-origin');
check('a cached page is served from the shell', cachedRes && (await cachedRes).body === 'APP-HTML');

offline = true;
const nav = await run(origin + '/some/page', 'GET', 'navigate');
check('offline navigation falls back to the cached app', nav && (await nav).body === 'APP-HTML');
check('API responses are never intercepted (no caching of account data)', (await run(origin + '/api/state', 'GET', 'cors')) === undefined);
check('API responses for other users cannot come from cache', (await run(origin + '/api/auth/me', 'GET', 'cors')) === undefined);
check('non-GET requests are left to the network', (await run(origin + '/api/state', 'PUT', 'cors')) === undefined);
check('cross-origin requests are left alone', (await run('https://cdn.example.com/x.js', 'GET', 'cors')) === undefined);
offline = false;

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
