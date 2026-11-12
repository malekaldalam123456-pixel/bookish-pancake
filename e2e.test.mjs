// End-to-end: the real server (SQLite in memory) and several browser "devices" (jsdom) running the
// production page from earn-it-server/public. Each device has its own cookie jar.
import { JSDOM, VirtualConsole } from 'jsdom';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createApp } = require(path.join(here, '..', 'server.js'));

const results = [];
const check = (name, cond, extra = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '   <- ' + extra}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function untilOk(fn, ms = 6000) { try { return await until(fn, ms); } catch { return false; } }
async function until(fn, ms = 6000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) { last = e; } await sleep(50); }
  throw new Error('timed out' + (last ? ': ' + last.message : ''));
}

const app = createApp({ dbFile: ':memory:' });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const html = fs.readFileSync(path.join(here, '..', 'public', 'earn-it.html'), 'utf8');

function device() {
  const dev = { jar: '', offline: false, errors: [] };
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => dev.errors.push('jsdom: ' + e.message));
  vc.on('error', e => dev.errors.push('console: ' + String(e)));
  dev.dom = new JSDOM(html, {
    url: base + '/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.URL.createObjectURL = () => 'blob:e2e'; w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = function () {};
      w.fetch = async (url, init = {}) => {                       // real HTTP to the live server, with this device's cookie
        if (dev.offline) throw new TypeError('network unreachable');
        const headers = { ...(init.headers || {}) };
        if (dev.jar) headers.Cookie = dev.jar;
        const res = await fetch(new URL(url, base), { method: init.method || 'GET', headers, body: init.body });
        const sc = res.headers.get('set-cookie');
        if (sc) dev.jar = sc.includes('Max-Age=0') ? '' : sc.split(';')[0];
        return res;
      };
    },
  });
  dev.w = dev.dom.window;
  dev.ev = code => dev.w.eval(code);
  dev.st = () => JSON.parse(JSON.stringify(dev.w.eval('S')));
  return dev;
}
const submitForm = (dev, form) => form.dispatchEvent(new dev.w.Event('submit', { bubbles: true, cancelable: true }));
const authVisible = dev => !dev.w.document.querySelector('#authScreen').hidden;
const serverUser = email => app.db.userByEmail(email);
const serverState = email => app.db.stateOf(serverUser(email).id);

async function registerUI(dev, name, email, password) {
  await untilOk(() => authVisible(dev));
  dev.w.document.querySelector('[data-act="auth-switch"][data-mode="register"]').click();
  const f = dev.w.document.querySelector('form[data-form="auth"]');
  f.elements.name.value = name; f.elements.email.value = email; f.elements.password.value = password;
  submitForm(dev, f);
  await untilOk(() => !authVisible(dev));
}
async function loginUI(dev, email, password) {
  await untilOk(() => authVisible(dev));
  const f = dev.w.document.querySelector('form[data-form="auth"]');
  f.elements.email.value = email; f.elements.password.value = password;
  submitForm(dev, f);
  await untilOk(() => !authVisible(dev));
}
const addRead = (dev, reward) => dev.ev(`addTask({ title: 'Read ${reward}', difficulty: 'easy', reward: '${reward / 100}', freq: 'none', due: '' })`);
const completeLast = dev => dev.ev(`completeTask(S.tasks[0].id)`);

// 1. First visit: the server says "not signed in", so the sign-in screen is shown
const a = device();
await untilOk(() => authVisible(a));
check('a visitor without a session sees the sign-in screen', authVisible(a));
check('the sign-in screen offers registration', a.w.document.querySelector('form[data-form="auth"]') !== null);

// 2. Register on device A, data lands on the server
await registerUI(a, 'Ayman', 'ayman@example.com', 'secret-pass-1');
check('registration signs the device in and shows the app', !authVisible(a) && a.ev('!!ui.user'));
check('the signed-in device uses the account name', a.st().profile.name === 'Ayman');
check('the account exists on the server', !!serverUser('ayman@example.com'));

// 3. Changes sync to the server
addRead(a, 30000);
completeLast(a);
await untilOk(() => serverState('ayman@example.com').state.balance === 30000);
check('completing a task on device A reaches the server ledger', serverState('ayman@example.com').state.balance === 30000);
check('device A tracks the server revision', a.ev('ui.rev') === serverState('ayman@example.com').rev);
check('the sync badge reports saved', a.w.document.querySelector('#sync').textContent.includes('✓'));

// 4. A second device sees the same account data after signing in
const b = device();
await loginUI(b, 'ayman@example.com', 'secret-pass-1');
check('a second device loads the same balance after sign-in', b.st().balance === 30000);
check('a wrong password is refused with the generic message', await (async () => {
  const c = device();
  await untilOk(() => authVisible(c));
  const f = c.w.document.querySelector('form[data-form="auth"]');
  f.elements.email.value = 'ayman@example.com'; f.elements.password.value = 'wrong-password';
  submitForm(c, f);
  await untilOk(() => c.w.document.querySelector('#authScreen').textContent.includes('غير صحيحة') || c.w.document.querySelector('#authScreen').textContent.includes('Wrong email'));
  return true;
})());

// 5. Conflict: device B edits from a stale revision after device A changed the account
addRead(a, 20000); completeLast(a);
await untilOk(() => serverState('ayman@example.com').state.balance === 50000);
addRead(b, 1000);                                    // B is still on the old revision
await untilOk(() => b.st().balance === 50000 && !b.st().tasks.some(t => t.title === 'Read 1000'));
check('a stale device is refused and reloads the latest account data', b.st().balance === 50000);
check('the conflict is announced to the user', b.w.document.querySelector('#toast').className.includes('err'));
check('the stale device rolls back to the server copy', !b.st().tasks.some(t => t.title === 'Read 1000'));

// 6. Offline: changes are kept and sent when the connection returns
a.offline = true;
addRead(a, 5000); completeLast(a);
await untilOk(() => a.w.document.querySelector('#sync').textContent.includes('غير متصل') || a.w.document.querySelector('#sync').textContent.includes('Offline'));
check('while offline the device reports it and keeps the change', a.st().balance === 55000 && serverState('ayman@example.com').state.balance === 50000);
a.offline = false;
await untilOk(() => serverState('ayman@example.com').state.balance === 55000, 9000);
check('the queued change reaches the server when the connection returns', serverState('ayman@example.com').state.balance === 55000);

// 7. Password-gated reset from the profile flow
b.ev("ui.user && passwordModal('reset', 'Reset')");
{ const f = b.w.document.querySelector('form[data-form="password"]'); f.elements.password.value = 'wrong-one'; submitForm(b, f); }
await sleep(300);
check('a wrong password does not reset the account', serverState('ayman@example.com').state.balance === 55000);
{ const f = b.w.document.querySelector('form[data-form="password"]'); f.elements.password.value = 'secret-pass-1'; submitForm(b, f); }
await untilOk(() => serverState('ayman@example.com').state.balance === 0);
check('the correct password resets the account on the server', serverState('ayman@example.com').state.balance === 0 && b.st().balance === 0);

// 8. Password-gated restore of a backup
const backup = { ...b.ev('freshState()'), ledger: [{ id: 'imp-1', type: 'task_reward', amount: 700, before: 0, after: 700, ts: Date.now(), desc: 'Imported', ref: null }], balance: 700, lifetime: 700 };
b.ev(`ui.pendingRestore = ${JSON.stringify(backup)}; passwordModal('restore', 'Import')`);
{ const f = b.w.document.querySelector('form[data-form="password"]'); f.elements.password.value = 'secret-pass-1'; submitForm(b, f); }
await untilOk(() => serverState('ayman@example.com').state.balance === 700);
check('a valid backup restores on the server with the password', serverState('ayman@example.com').state.balance === 700 && b.st().balance === 700);

// 9. Sign out removes this device's copy of the data
b.ev("ui.tab = 'profile'; render();");
b.w.document.querySelector('[data-act="logout"]').click();
await untilOk(() => authVisible(b));
check('signing out returns to the sign-in screen', authVisible(b));
check('signing out clears the local copy of the account data', b.w.localStorage.getItem('earnit.v1') === null && b.st().balance === 0);

// 10. Account deletion removes the user and its data
const c2 = device();
await loginUI(c2, 'ayman@example.com', 'secret-pass-1');
c2.ev("ui.tab = 'profile'; render(); passwordModal('delete', 'Delete')");
{ const f = c2.w.document.querySelector('form[data-form="password"]'); f.elements.password.value = 'secret-pass-1'; submitForm(c2, f); }
await untilOk(() => serverUser('ayman@example.com') === null);
check('deleting the account removes the user from the server', serverUser('ayman@example.com') === null);
const orphan = app.db.raw.prepare('SELECT COUNT(*) AS n FROM states').get().n;
check('deleting the account removes its stored state', Number(orphan) === 0);

// 11. Errors from the page never escape
for (const [name, dev] of [['A', a], ['B', b], ['C', c2]]) check(`device ${name} ran without script errors`, dev.errors.length === 0, dev.errors.join(' | '));

app.close();
for (const dev of [a, b]) dev.dom.window.close();
c2.dom.window.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
