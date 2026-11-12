'use strict';
// Storage on Node's built-in SQLite. Every state write is a compare-and-swap on the revision,
// so two devices can never silently overwrite each other.
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS states (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      rev INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, email, name, pass_hash FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (id, email, name, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)'),
    updateName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    sessionByHash: db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    insertState: db.prepare('INSERT INTO states (user_id, rev, data, updated_at) VALUES (?, ?, ?, ?)'),
    stateOf: db.prepare('SELECT rev, data FROM states WHERE user_id = ?'),
    casState: db.prepare('UPDATE states SET rev = ?, data = ?, updated_at = ? WHERE user_id = ? AND rev = ?'),
  };
  return {
    raw: db,
    userByEmail: email => q.userByEmail.get(email) ?? null,
    userById: id => q.userById.get(id) ?? null,
    createUser(u) {
      q.insertUser.run(u.id, u.email, u.name, u.hash, u.now);
      q.insertState.run(u.id, 1, JSON.stringify(u.state), u.now);
    },
    setName: (id, name) => q.updateName.run(name, id),
    deleteUser: id => q.deleteUser.run(id),
    createSession: (hash, userId, expiresAt) => q.insertSession.run(hash, userId, expiresAt),
    sessionByHash: hash => q.sessionByHash.get(hash) ?? null,
    deleteSession: hash => q.deleteSession.run(hash),
    purgeSessions: now => q.purgeSessions.run(now),
    stateOf(userId) {
      const row = q.stateOf.get(userId);
      return row ? { rev: row.rev, state: JSON.parse(row.data) } : null;
    },
    // Compare-and-swap: succeeds only if the stored revision is still `expectedRev`.
    casState(userId, expectedRev, state, now) {
      const res = q.casState.run(expectedRev + 1, JSON.stringify(state), now, userId, expectedRev);
      return res.changes === 1;
    },
    replaceState(userId, state, now) {
      const cur = q.stateOf.get(userId);
      return q.casState.run((cur?.rev ?? 0) + 1, JSON.stringify(state), now, userId, cur?.rev ?? 0).changes === 1;
    },
    close: () => db.close(),
  };
}

module.exports = { openDb };
