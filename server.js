'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { openDb } = require('./lib/db');
const { validateState, defaultState } = require('./lib/validate');

const scrypt = promisify(crypto.scrypt);
const PUBLIC = path.join(__dirname, 'public');
const SESSION_MS = 30 * 24 * 3600e3;
const MAX_BODY = 4 * 1024 * 1024;
const STATIC = {
  '/': ['earn-it.html', 'text/html; charset=utf-8'],
  '/earn-it.html': ['earn-it.html', 'text/html; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,100}\.[^\s@]{2,20}$/;

// Fixed-window limiter for sensitive endpoints (login, registration, account deletion).
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    return recent.length <= max;
  };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [, N, r, p, saltB64, keyB64] = stored.split('$');
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = v => String(v ?? '').trim().toLowerCase();

function createApp(opts = {}) {
  const db = openDb(opts.dbFile ?? ':memory:');
  const secure = !!opts.secureCookies;
  const authLimit = makeLimiter(20, 15 * 60e3);
  let dummyPromise = null;
  const getDummy = () => (dummyPromise ??= hashPassword(crypto.randomBytes(12).toString('hex')));

  function send(res, status, body, headers = {}) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    });
    res.end(payload);
  }
  const fail = (res, status, error, extra) => send(res, status, { error, ...extra });

  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return reject({ status: 415, error: 'json_required' });
      let size = 0; const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { reject({ status: 413, error: 'too_large' }); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch { reject({ status: 400, error: 'bad_json' }); }
      });
      req.on('error', () => reject({ status: 400, error: 'bad_request' }));
    });
  }

  function cookieValue(req, name) {
    const found = String(req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
    return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
  }
  const sessionCookie = (token, maxAge) =>
    `et_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

  function currentUser(req) {
    const token = cookieValue(req, 'et_session');
    if (!token) return null;
    const hash = sha256(token);
    const row = db.sessionByHash(hash);
    if (!row) return null;
    if (row.expires_at < Date.now()) { db.deleteSession(hash); return null; }
    return db.userById(row.user_id);
  }
  function issueSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.createSession(sha256(token), userId, Date.now() + SESSION_MS);
    return sessionCookie(token, Math.floor(SESSION_MS / 1000));
  }
  const publicUser = u => ({ id: u.id, email: u.email, name: u.name });

  async function handleApi(req, res, url) {
    const ip = req.socket.remoteAddress || 'local';

    if (req.method === 'GET' && url === '/api/health') return send(res, 200, { ok: true });

    if (req.method === 'POST' && url === '/api/auth/register') {
      const body = await readJson(req);
      const email = normEmail(body.email), name = String(body.name ?? '').trim(), password = String(body.password ?? '');
      if (!EMAIL_RE.test(email) || email.length > 120 || password.length < 8 || password.length > 200 || !name || name.length > 40)
        return fail(res, 400, 'invalid_input');
      if (!authLimit(`reg|${ip}`)) return fail(res, 429, 'too_many_requests');
      if (db.userByEmail(email)) return fail(res, 409, 'email_taken');
      const id = crypto.randomUUID();
      try {
        db.createUser({ id, email, name, hash: await hashPassword(password), now: Date.now(), state: defaultState(name) });
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return fail(res, 409, 'email_taken');
        throw e;
      }
      return send(res, 201, { user: publicUser({ id, email, name }), rev: 1 }, { 'Set-Cookie': issueSession(id) });
    }

    if (req.method === 'POST' && url === '/api/auth/login') {
      const body = await readJson(req);
      const email = normEmail(body.email), password = String(body.password ?? '');
      if (!authLimit(`login|${ip}|${email}`)) return fail(res, 429, 'too_many_requests');
      const user = db.userByEmail(email);
      const ok = user ? await verifyPassword(password, user.pass_hash) : (await verifyPassword(password, await getDummy()), false);
      if (!ok) return fail(res, 401, 'invalid_credentials');
      return send(res, 200, { user: publicUser(user), rev: db.stateOf(user.id)?.rev ?? 0 }, { 'Set-Cookie': issueSession(user.id) });
    }

    if (req.method === 'POST' && url === '/api/auth/logout') {
      const token = cookieValue(req, 'et_session');
      if (token) db.deleteSession(sha256(token));
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }

    // Everything below requires a session.
    const user = currentUser(req);
    if (!user) return fail(res, 401, 'not_authenticated');

    if (req.method === 'GET' && url === '/api/auth/me') {
      return send(res, 200, { user: publicUser(user), rev: db.stateOf(user.id)?.rev ?? 0 });
    }

    if (req.method === 'GET' && url === '/api/state') {
      const st = db.stateOf(user.id);
      if (!st) return fail(res, 404, 'no_state');
      return send(res, 200, st);
    }

    if (req.method === 'PUT' && url === '/api/state') {
      const body = await readJson(req);
      const cur = db.stateOf(user.id);
      if (!cur) return fail(res, 404, 'no_state');
      if (body.rev !== cur.rev) return fail(res, 409, 'conflict', { rev: cur.rev });
      const err = validateState(body.state, cur.state);
      if (err) return fail(res, 422, 'invalid_state', { reason: err });
      if (!db.casState(user.id, cur.rev, body.state, Date.now())) return fail(res, 409, 'conflict', { rev: db.stateOf(user.id).rev });
      return send(res, 200, { rev: cur.rev + 1 });
    }

    if (req.method === 'POST' && url === '/api/state/reset') {
      // Fresh state is allowed only with the password: it discards the ledger history on purpose.
      const body = await readJson(req);
      if (!authLimit(`reset|${user.id}`)) return fail(res, 429, 'too_many_requests');
      if (!(await verifyPassword(String(body.password ?? ''), user.pass_hash))) return fail(res, 401, 'invalid_credentials');
      const fresh = defaultState(user.name);
      db.replaceState(user.id, fresh, Date.now());
      return send(res, 200, { rev: db.stateOf(user.id).rev, state: fresh });
    }

    if (req.method === 'POST' && url === '/api/state/restore') {
      // A restore replaces the whole history on purpose (e.g. importing a backup), so it is
      // password-gated and the imported state must still be internally consistent.
      const body = await readJson(req);
      if (!authLimit(`restore|${user.id}`)) return fail(res, 429, 'too_many_requests');
      if (!(await verifyPassword(String(body.password ?? ''), user.pass_hash))) return fail(res, 401, 'invalid_credentials');
      const err = validateState(body.state, null);
      if (err) return fail(res, 422, 'invalid_state', { reason: err });
      db.replaceState(user.id, body.state, Date.now());
      return send(res, 200, { rev: db.stateOf(user.id).rev, state: body.state });
    }

    if (req.method === 'PATCH' && url === '/api/profile') {
      const body = await readJson(req);
      const name = String(body.name ?? '').trim();
      if (!name || name.length > 40) return fail(res, 400, 'invalid_input');
      db.setName(user.id, name);
      return send(res, 200, { user: publicUser({ ...user, name }) });
    }

    if (req.method === 'DELETE' && url === '/api/account') {
      const body = await readJson(req);
      if (!authLimit(`delete|${user.id}`)) return fail(res, 429, 'too_many_requests');
      if (!(await verifyPassword(String(body.password ?? ''), user.pass_hash))) return fail(res, 401, 'invalid_credentials');
      db.deleteUser(user.id);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }

    return fail(res, 404, 'not_found');
  }

  function serveStatic(req, res, pathname) {
    const entry = STATIC[pathname];
    if (!entry) return send(res, 404, { error: 'not_found' });
    const [file, type] = entry;
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'not_found' });
    fs.readFile(full, (err, data) => {
      if (err) return send(res, 404, { error: 'not_found' });
      const headers = {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': pathname === '/sw.js' ? 'no-cache' : 'public, max-age=300',
      };
      if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
      if (pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/';
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (err && err.status) return fail(res, err.status, err.error);
      console.error('[server]', err);
      return fail(res, 500, 'server_error');
    }
  });

  // Housekeeping: drop expired sessions every hour.
  const sweep = setInterval(() => db.purgeSessions(Date.now()), 3600e3);
  sweep.unref();
  return { server, db, close() { clearInterval(sweep); server.close(); db.close(); } };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  const app = createApp({
    dbFile: process.env.EARN_DB || path.join(__dirname, 'data', 'earn-it.sqlite'),
    secureCookies: process.env.COOKIE_SECURE === '1',
  });
  app.server.listen(port, () => console.log(`EARN IT running on http://localhost:${port}`));
}
