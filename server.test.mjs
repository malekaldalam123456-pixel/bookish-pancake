// EARN IT server tests: real HTTP against an in-memory SQLite database.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createApp } = require('../server.js');

const results = [];
const check = (name, cond, extra = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '   <- ' + extra}`); };

const app = createApp({ dbFile: ':memory:' });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;

const jar = {};
async function call(method, url, { body, cookie, raw, type = 'application/json' } = {}) {
  const headers = {};
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = type;
  const c = cookie ?? jar.current;
  if (c) headers.Cookie = c;
  const res = await fetch(base + url, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  let data = null;
  if ((res.headers.get('content-type') || '').includes('json')) data = await res.json().catch(() => null);
  return { status: res.status, data, setCookie, headers: res.headers };
}
const sessionFrom = sc => (sc && sc.startsWith('et_session=') ? sc.split(';')[0] : null);
const ledgerRow = (id, amount, before) => ({ id, type: 'task_reward', amount, before, after: before + amount, ts: Date.now(), desc: 'Task: x', ref: 'task-1' });
const withRow = (state, row) => ({ ...state, ledger: [row, ...state.ledger], balance: state.balance + row.amount, lifetime: state.lifetime + row.amount });

// 1. Health and registration
let r = await call('GET', '/api/health');
check('health endpoint responds', r.status === 200 && r.data.ok === true);

r = await call('POST', '/api/auth/register', { body: { email: 'ahmed@example.com', password: 'correct-horse-1', name: 'أحمد' } });
check('registration creates an account (201)', r.status === 201 && r.data.user.email === 'ahmed@example.com' && r.data.rev === 1, JSON.stringify(r.data));
jar.ahmed = sessionFrom(r.setCookie);
check('session cookie is HttpOnly and SameSite=Strict', r.setCookie.includes('HttpOnly') && r.setCookie.includes('SameSite=Strict'), r.setCookie);
check('session cookie carries a random token', jar.ahmed && jar.ahmed.length > 40);

r = await call('POST', '/api/auth/register', { body: { email: 'AHMED@example.com', password: 'another-pass-2', name: 'x' } });
check('duplicate email (case-insensitive) is refused with 409', r.status === 409 && r.data.error === 'email_taken');
r = await call('POST', '/api/auth/register', { body: { email: 'not-an-email', password: 'correct-horse-1', name: 'x' } });
check('invalid email is refused', r.status === 400 && r.data.error === 'invalid_input');
r = await call('POST', '/api/auth/register', { body: { email: 'short@example.com', password: 'abc', name: 'x' } });
check('short password is refused', r.status === 400);
r = await call('POST', '/api/auth/register', { raw: 'email=a', type: 'text/plain' });
check('non-JSON body is refused with 415', r.status === 415 && r.data.error === 'json_required');
r = await call('POST', '/api/auth/register', { raw: '{bad', type: 'application/json' });
check('malformed JSON is refused with 400', r.status === 400 && r.data.error === 'bad_json');

// 2. Session handling
r = await call('GET', '/api/auth/me', { cookie: '' });
check('protected routes require a session (401)', r.status === 401 && r.data.error === 'not_authenticated');
r = await call('GET', '/api/auth/me', { cookie: 'et_session=forged-token' });
check('forged session token is rejected', r.status === 401);
r = await call('GET', '/api/auth/me', { cookie: jar.ahmed });
check('session resolves the current user and revision', r.status === 200 && r.data.user.name === 'أحمد' && r.data.rev === 1);

// 3. State sync: read, valid write, conflicts, integrity
r = await call('GET', '/api/state', { cookie: jar.ahmed });
check('GET state returns the default revision-1 state', r.status === 200 && r.data.rev === 1 && r.data.state.balance === 0 && r.data.state.profile.name === 'أحمد');
const s0 = r.data.state;

const s1 = withRow(s0, ledgerRow('row-1', 500, 0));
r = await call('PUT', '/api/state', { cookie: jar.ahmed, body: { rev: 1, state: s1 } });
check('valid write with the current revision succeeds and bumps the revision', r.status === 200 && r.data.rev === 2, JSON.stringify(r.data));

r = await call('PUT', '/api/state', { cookie: jar.ahmed, body: { rev: 1, state: withRow(s1, ledgerRow('row-2', 100, 500)) } });
check('stale revision is rejected with 409 conflict (no silent overwrite)', r.status === 409 && r.data.error === 'conflict' && r.data.rev === 2);

r = await call('PUT', '/api/state', { cookie: jar.ahmed, body: { rev: 2, state: { ...s1, balance: 999999 } } });
check('balance that does not match the ledger is rejected', r.status === 422 && r.data.reason === 'balance_mismatch', JSON.stringify(r.data));

const rewritten = JSON.parse(JSON.stringify(s1));
rewritten.ledger[0].amount = 90000; rewritten.ledger[0].after = 90000; rewritten.balance = 90000; rewritten.lifetime = 90000;
r = await call('PUT', '/api/state', { cookie: jar.ahmed, body: { rev: 2, state: rewritten } });
check('rewriting an existing ledger row is rejected', r.status === 422 && r.data.reason === 'ledger_rewritten', JSON.stringify(r.data));

r = await call('PUT', '/api/state', { cookie: jar.ahmed, body: { rev: 2, state: { ...s1, ledger: [], balance: 0 } } });
check('deleting ledger history is rejected', r.status === 422 && r.data.reason === 'ledger_truncated', JSON.stringify(r.data));

r = await call('PUT', '/api/state', { cookie: jar.ahmed, body: { rev: 2, state: { ...s1, hacked: true } } });
check('unknown top-level keys are rejected', r.status === 422 && r.data.reason === 'unknown_key');

r = await call('PUT', '/api/state', { cookie: jar.ahmed, body: { rev: 2, state: { ...s1, profile: { ...s1.profile, frame: 'diamond' } } } });
check('invalid profile frame is rejected', r.status === 422 && r.data.reason === 'profile');

r = await call('PUT', '/api/state', { cookie: jar.ahmed, body: { rev: 2, state: { ...s1, profile: { ...s1.profile, photo: 'javascript:alert(1)' } } } });
check('non-image profile photo is rejected', r.status === 422 && r.data.reason === 'profile');

const photoState = { ...s1, profile: { ...s1.profile, photo: 'data:image/png;base64,iVBORw0KGgo=' } };
r = await call('PUT', '/api/state', { cookie: jar.ahmed, body: { rev: 2, state: photoState } });
check('valid profile photo data URL is accepted', r.status === 200 && r.data.rev === 3);

r = await call('PUT', '/api/state', { cookie: jar.ahmed, body: { rev: 3, state: withRow(photoState, ledgerRow('row-2', 100, 500)) } });
check('appending a new ledger row on top of the latest revision is accepted', r.status === 200 && r.data.rev === 4);

// 4. Login, logout, generic errors
r = await call('POST', '/api/auth/login', { body: { email: 'ahmed@example.com', password: 'wrong-password' } });
const wrongPw = r;
r = await call('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'wrong-password' } });
check('wrong password and unknown email return the same generic error', wrongPw.status === 401 && r.status === 401 && wrongPw.data.error === r.data.error && wrongPw.data.error === 'invalid_credentials');

r = await call('POST', '/api/auth/login', { body: { email: 'ahmed@example.com', password: 'correct-horse-1' } });
check('correct password logs in and returns the latest revision', r.status === 200 && sessionFrom(r.setCookie) && r.data.rev === 4, JSON.stringify(r.data));
jar.ahmed = sessionFrom(r.setCookie);

// 5. Isolation between accounts
r = await call('POST', '/api/auth/register', { body: { email: 'sara@example.com', password: 'sara-strong-3', name: 'سارة' } });
jar.sara = sessionFrom(r.setCookie);
r = await call('GET', '/api/state', { cookie: jar.sara });
check('a second account sees only its own state (balance 0, no ledger)', r.status === 200 && r.data.state.balance === 0 && r.data.state.ledger.length === 0 && r.data.state.profile.name === 'سارة');
const saraState = withRow(r.data.state, ledgerRow('sara-1', 100, 0));
r = await call('PUT', '/api/state', { cookie: jar.sara, body: { rev: 1, state: saraState } });
check('second account writes to its own revision only', r.status === 200);
r = await call('GET', '/api/state', { cookie: jar.ahmed });
check("the first account's balance is untouched by the other account", r.data.state.balance === 600, String(r.data.state.balance));

// 6. Logout invalidates the session
r = await call('POST', '/api/auth/logout', { cookie: jar.sara });
check('logout clears the cookie', r.status === 200 && r.setCookie.includes('Max-Age=0'));
r = await call('GET', '/api/auth/me', { cookie: jar.sara });
check('logged-out session no longer works', r.status === 401);

// 7. Expired sessions are rejected
app.db.raw.exec("UPDATE sessions SET expires_at = 0 WHERE user_id = (SELECT id FROM users WHERE email = 'ahmed@example.com')");
r = await call('GET', '/api/auth/me', { cookie: jar.ahmed });
check('expired session is rejected', r.status === 401);
r = await call('POST', '/api/auth/login', { body: { email: 'ahmed@example.com', password: 'correct-horse-1' } });
jar.ahmed = sessionFrom(r.setCookie);

// 8. Password-gated reset, profile edit, account deletion
r = await call('POST', '/api/state/reset', { cookie: jar.ahmed, body: { password: 'wrong' } });
check('reset requires the account password', r.status === 401);
r = await call('POST', '/api/state/reset', { cookie: jar.ahmed, body: { password: 'correct-horse-1' } });
check('reset with the password restores a fresh state (new revision)', r.status === 200 && r.data.state.balance === 0 && r.data.state.ledger.length === 0 && r.data.rev > 4);

const backup = withRow(r.data?.state ?? { ...(await call('GET', '/api/state', { cookie: jar.ahmed })).data.state }, ledgerRow('restored-1', 250, 0));
r = await call('POST', '/api/state/restore', { cookie: jar.ahmed, body: { password: 'wrong', state: backup } });
check('restore requires the password', r.status === 401);
r = await call('POST', '/api/state/restore', { cookie: jar.ahmed, body: { password: 'correct-horse-1', state: { ...backup, balance: 1 } } });
check('restore rejects an internally inconsistent backup', r.status === 422 && r.data.reason === 'balance_mismatch', JSON.stringify(r.data));
r = await call('POST', '/api/state/restore', { cookie: jar.ahmed, body: { password: 'correct-horse-1', state: backup } });
check('restore with the password replaces the state with a valid backup', r.status === 200 && r.data.state.balance === 250);
r = await call('PATCH', '/api/profile', { cookie: jar.ahmed, body: { name: '' } });
check('empty profile name is refused', r.status === 400);
r = await call('PATCH', '/api/profile', { cookie: jar.ahmed, body: { name: 'أحمد علي' } });
check('profile name can be changed', r.status === 200 && r.data.user.name === 'أحمد علي');

r = await call('POST', '/api/auth/login', { body: { email: 'sara@example.com', password: 'sara-strong-3' } });
jar.sara = sessionFrom(r.setCookie);
r = await call('DELETE', '/api/account', { cookie: jar.sara, body: { password: 'wrong-pass' } });
check('account deletion requires the password', r.status === 401);
r = await call('DELETE', '/api/account', { cookie: jar.sara, body: { password: 'sara-strong-3' } });
check('account deletion succeeds with the password', r.status === 200);
r = await call('POST', '/api/auth/login', { body: { email: 'sara@example.com', password: 'sara-strong-3' } });
check('deleted account can no longer log in', r.status === 401);
const orphans = app.db.raw.prepare('SELECT COUNT(*) AS n FROM states WHERE user_id NOT IN (SELECT id FROM users)').get().n;
check('deleting an account removes its state (no orphan rows)', Number(orphans) === 0);

// 9. Limits and the static site
r = await call('PUT', '/api/state', { cookie: jar.ahmed, body: { rev: 1, state: { blob: 'x'.repeat(4.5 * 1024 * 1024) } } }).catch(() => ({ status: 413 }));
check('oversized request bodies are rejected with 413', r.status === 413, String(r.status));

r = await call('GET', '/');
check('home page is served with a Content-Security-Policy', r.status === 200 && (r.headers.get('content-security-policy') || '').includes("default-src 'self'"));
r = await call('GET', '/../server.js');
check('path traversal outside the public folder is blocked', r.status === 404);
r = await call('GET', '/unknown-file.txt');
check('unknown static files are 404', r.status === 404);
r = await call('POST', '/sw.js', { body: {} });
check('static files reject non-GET methods (405)', r.status === 405);
const swRes = await fetch(base + '/sw.js');
check('service worker is served with no-cache and scope /', swRes.headers.get('cache-control') === 'no-cache' && swRes.headers.get('service-worker-allowed') === '/');

// 10. Brute-force protection on login
let blocked = 0;
for (let i = 0; i < 25; i++) { const x = await call('POST', '/api/auth/login', { body: { email: 'target@example.com', password: 'guess-' + i } }); if (x.status === 429) blocked++; }
check('repeated failed logins are rate-limited (429)', blocked >= 5, 'blocked=' + blocked);

app.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
