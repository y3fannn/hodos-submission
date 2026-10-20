// Accounts: everything this server keeps about a person, and nothing else.
// design/2026-09-19-security.md §1: an email address, the public half of each passkey, a fingerprint
// of the recovery key, sessions, and what AI has cost this month. There is no table for money data,
// so there is nowhere for it to land by mistake.
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function openAccounts(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, google_sub TEXT UNIQUE, recovery_fp TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, device_verified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS ai_usage (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, month TEXT NOT NULL,
      cost_micro INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, unknown_calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, month));
  `);
  // Old sessions are identity-only until an account-owned device credential is verified.
  if (!db.prepare("PRAGMA table_info(sessions)").all().some((c) => c.name === "device_verified")) db.exec("ALTER TABLE sessions ADD COLUMN device_verified INTEGER NOT NULL DEFAULT 0");
  // Earlier counters did not retain missing usage/cache coverage; preserve their subtotal, mark it partial.
  if (!db.prepare("PRAGMA table_info(ai_usage)").all().some(c => c.name === "unknown_calls")) {
    db.exec("ALTER TABLE ai_usage ADD COLUMN unknown_calls INTEGER NOT NULL DEFAULT 0; UPDATE ai_usage SET unknown_calls = calls");
  }
  const q = (sql) => db.prepare(sql);
  const byId = (id) => q("SELECT * FROM accounts WHERE id = ?").get(id) || null;

  return {
    byId,
    byEmail: (email) => q("SELECT * FROM accounts WHERE email = ?").get(email) || null,
    byGoogle: (sub) => q("SELECT * FROM accounts WHERE google_sub = ?").get(sub) || null,
    create(email) {
      const id = crypto.randomUUID();
      q("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)").run(id, email, Date.now());
      return byId(id);
    },
    linkGoogle: (id, sub) => q("UPDATE accounts SET google_sub = ? WHERE id = ?").run(sub, id),
    setRecovery: (id, fp) => q("UPDATE accounts SET recovery_fp = ? WHERE id = ?").run(fp, id),
    // Deleting an account deletes everything held about it: passkeys, sessions, usage.
    remove: (id) => q("DELETE FROM accounts WHERE id = ?").run(id),

    passkeys: {
      list: (accountId) => q("SELECT * FROM passkeys WHERE account_id = ? ORDER BY created_at").all(accountId),
      get: (credId) => q("SELECT * FROM passkeys WHERE id = ?").get(credId) || null,
      add: ({ id, accountId, publicKey, counter, transports }) =>
        q("INSERT INTO passkeys (id, account_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, accountId, publicKey, counter, JSON.stringify(transports || []), Date.now()),
      used: (credId, counter) => q("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(counter, Date.now(), credId),
    },

    // The browser holds the session token; this table holds only its hash, so a copy of the database
    // signs nobody in.
    sessions: {
      create(accountId, ttlMs, deviceVerified = false) {
        const token = crypto.randomBytes(32).toString("base64url"), now = Date.now();
        q("INSERT INTO sessions (token_hash, account_id, created_at, expires_at, device_verified) VALUES (?, ?, ?, ?, ?)").run(sha256(token), accountId, now, now + ttlMs, Number(deviceVerified));
        return token;
      },
      account(token) {
        if (!token) return null;
        const s = q("SELECT * FROM sessions WHERE token_hash = ?").get(sha256(token));
        if (!s) return null;
        if (s.expires_at <= Date.now()) { q("DELETE FROM sessions WHERE token_hash = ?").run(s.token_hash); return null; }
        return byId(s.account_id);
      },
      verified: (token) => Boolean(q("SELECT device_verified FROM sessions WHERE token_hash = ? AND expires_at > ?").get(sha256(token || ""), Date.now())?.device_verified),
      remembered: (token) => Boolean(q("SELECT expires_at - created_at > 43200000 AS remembered FROM sessions WHERE token_hash = ? AND expires_at > ?").get(sha256(token || ""), Date.now())?.remembered),
      end: (token) => q("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token || "")),
      endAll: (accountId) => q("DELETE FROM sessions WHERE account_id = ?").run(accountId),
      count: (accountId) => q("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ? AND expires_at > ?").get(accountId, Date.now()).n,
      sweep: () => q("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now()),
    },

    // One running number per person per month, in millionths of a US dollar. Never what was asked.
    usage: {
      get: (accountId, month) => q("SELECT cost_micro, calls, unknown_calls FROM ai_usage WHERE account_id = ? AND month = ?").get(accountId, month) || { cost_micro: 0, calls: 0, unknown_calls: 0 },
      add: (accountId, month, costMicro) =>
        q("INSERT INTO ai_usage (account_id, month, cost_micro, calls, unknown_calls) VALUES (?, ?, ?, 1, ?) ON CONFLICT (account_id, month) DO UPDATE SET cost_micro = cost_micro + excluded.cost_micro, calls = calls + 1, unknown_calls = unknown_calls + excluded.unknown_calls").run(accountId, month, costMicro ?? 0, Number(costMicro == null)),
    },
    close: () => db.close(),
  };
}
