'use strict';
// Integrity rules for the EARN IT state. The server never trusts client arithmetic:
// every saved state must be internally consistent, and its ledger must extend the stored
// ledger without rewriting, truncating, or reordering any earlier row.

const CAP = 1e9;                     // piastres: sanity cap for a single amount or balance
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,/;
const TYPES = new Set(['task_reward', 'habit_reward', 'challenge_reward', 'achievement_bonus', 'streak_bonus',
  'level_up_bonus', 'shop_purchase', 'savings_deposit', 'savings_withdrawal', 'admin_adjustment', 'reversal', 'refund']);
const KEYS = new Set(['v', 'balance', 'savings', 'lifetime', 'spending', 'xp', 'achievements', 'focus', 'habits',
  'profile', 'claims', 'cos', 'tasks', 'rewards', 'purchases', 'goals', 'ledger', 'used']);
const FRAMES = new Set(['rare', 'epic', 'legendary']);
const GOAL_STATUS = new Set(['active', 'completed', 'archived']);
const TASK_STATUS = new Set(['pending', 'completed']);
const FREQ = new Set(['none', 'daily', 'weekly']);

const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const str = (v, max) => typeof v === 'string' && v.length <= max;
const arr = (v, max) => Array.isArray(v) && v.length <= max;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function defaultState(name = '') {
  return {
    v: 1, balance: 0, savings: 0, lifetime: 0, spending: 0, xp: 0, achievements: [], focus: [], habits: [],
    profile: { name, avatar: '🧑‍🚀', bio: '', photo: '', frame: 'rare' }, claims: [],
    cos: { owned: ['pal_gold', 'amb_none', 'fx_none'], eq: { palette: 'pal_gold', title: '', ambient: 'amb_none', fx: 'fx_none' } },
    tasks: [], rewards: [], purchases: [], goals: [], ledger: [], used: {},
  };
}

function sameRow(a, b) {
  return a.id === b.id && a.type === b.type && a.amount === b.amount && a.before === b.before &&
    a.after === b.after && a.ts === b.ts && a.desc === b.desc && (a.ref ?? null) === (b.ref ?? null);
}

// Returns null when valid, otherwise a short machine-readable error code.
function validateState(s, prev) {
  if (!plain(s)) return 'shape';
  for (const k of Object.keys(s)) if (!KEYS.has(k)) return 'unknown_key';
  if (!isInt(s.balance, 0, CAP) || !isInt(s.savings, 0, CAP) || !isInt(s.lifetime, 0, CAP * 1000) ||
      !isInt(s.spending, 0, CAP * 1000) || !isInt(s.xp, 0, 1e9)) return 'numbers';

  // Ledger: each row self-consistent, chained, and summing to the balance.
  if (!arr(s.ledger, 200000)) return 'ledger';
  for (const e of s.ledger) {
    if (!plain(e) || !str(e.id, 64) || !TYPES.has(e.type) || !isInt(e.amount, -CAP, CAP) || e.amount === 0 ||
        !isInt(e.before, 0, CAP) || !isInt(e.after, 0, CAP) || e.after !== e.before + e.amount ||
        !isInt(e.ts, 0, 8.64e15) || !str(e.desc, 300) || (e.ref != null && !str(e.ref, 128))) return 'ledger_row';
  }
  for (let i = 0; i < s.ledger.length; i++) {
    const e = s.ledger[i], next = s.ledger[i + 1];
    if (next ? e.before !== next.after : e.before !== 0) return 'ledger_chain';
  }
  if (s.ledger.reduce((a, e) => a + e.amount, 0) !== s.balance) return 'balance_mismatch';

  // Append-only: the stored ledger must still be the tail of the new ledger.
  if (prev && Array.isArray(prev.ledger)) {
    if (s.ledger.length < prev.ledger.length) return 'ledger_truncated';
    const tail = s.ledger.slice(s.ledger.length - prev.ledger.length);
    for (let i = 0; i < prev.ledger.length; i++) if (!sameRow(tail[i], prev.ledger[i])) return 'ledger_rewritten';
  }

  if (!arr(s.goals, 2000)) return 'goals';
  for (const g of s.goals) {
    if (!plain(g) || !str(g.id, 64) || !str(g.name, 120) || !isInt(g.target, 1, CAP) || !isInt(g.saved, 0, CAP) ||
        g.saved > g.target || !GOAL_STATUS.has(g.status) || (g.status === 'completed' && g.saved < g.target)) return 'goal';
  }
  if (s.savings !== s.goals.reduce((a, g) => a + g.saved, 0)) return 'savings_mismatch';

  if (!arr(s.tasks, 5000)) return 'tasks';
  for (const t of s.tasks) {
    if (!plain(t) || !str(t.id, 64) || !str(t.title, 200) || !isInt(t.reward, 0, 1e6) || !TASK_STATUS.has(t.status) ||
        !FREQ.has(t.freq) || !(t.due === '' || t.due == null || DATE_RE.test(t.due)) || !arr(t.history, 20000)) return 'task';
  }
  if (!arr(s.rewards, 1000)) return 'rewards';
  for (const r of s.rewards) if (!plain(r) || !str(r.id, 64) || !str(r.name, 120) || !isInt(r.price, 1, 1e9)) return 'reward';
  if (!arr(s.purchases, 20000)) return 'purchases';
  for (const p of s.purchases) if (!plain(p) || !str(p.id, 64) || !str(p.name, 120)) return 'purchase';
  if (!arr(s.focus, 20000)) return 'focus';
  for (const f of s.focus) if (!plain(f) || !isInt(f.min, 1, 1440) || !isInt(f.ts, 0, 8.64e15)) return 'focus_row';
  if (!arr(s.habits, 200)) return 'habits';
  for (const h of s.habits) {
    if (!plain(h) || !str(h.id, 64) || !str(h.name, 80) || !arr(h.logs, 4000) || !h.logs.every(d => DATE_RE.test(d))) return 'habit';
  }
  if (!arr(s.claims, 20000) || !s.claims.every(c => str(c, 128))) return 'claims';
  if (!arr(s.achievements, 200) || !s.achievements.every(c => str(c, 64))) return 'achievements';

  const p = s.profile;
  if (!plain(p) || !str(p.name, 40) || !str(p.bio ?? '', 180) || !str(p.avatar ?? '', 16) ||
      !(p.photo === '' || p.photo == null || (PHOTO_RE.test(p.photo) && p.photo.length <= 300000)) ||
      !FRAMES.has(p.frame ?? 'rare')) return 'profile';

  if (!plain(s.cos) || !arr(s.cos.owned, 500) || !s.cos.owned.every(c => str(c, 64)) || !plain(s.cos.eq ?? {})) return 'cosmetics';
  for (const v of Object.values(s.cos.eq ?? {})) if (!str(v, 64)) return 'cosmetics';

  if (!plain(s.used ?? {}) || Object.keys(s.used ?? {}).length > 50000) return 'used';
  return null;
}

module.exports = { validateState, defaultState, CAP };
