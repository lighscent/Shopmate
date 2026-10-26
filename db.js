const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(path.join(dbDir, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    pseudo TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(email)
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL,
    name TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    checked INTEGER DEFAULT 0,
    added_by TEXT DEFAULT 'Anonyme',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT,
    FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    expires TEXT,
    data TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS list_members (
    list_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    joined_at TEXT DEFAULT (datetime('now')),
    can_edit INTEGER DEFAULT 1,
    PRIMARY KEY (list_id, user_email),
    FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
    FOREIGN KEY (user_email) REFERENCES users(email)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pseudo_changes (
    user_email TEXT NOT NULL,
    changed_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS article_info (
    user_email TEXT NOT NULL,
    name TEXT NOT NULL,
    display TEXT NOT NULL,
    price REAL,
    store TEXT,
    manual INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT,
    PRIMARY KEY (user_email, name)
  )
`);
// Catalogue 100% manuel : les lignes auto-alimentées (anciens backfill / ajouts en liste, manual=0)
// sont purgées une fois pour toutes. Les écritures futures posent toujours manual=1.
try { db.exec("ALTER TABLE article_info ADD COLUMN manual INTEGER"); } catch {}
try { db.exec("UPDATE article_info SET manual = 1 WHERE price IS NOT NULL"); } catch {}
try { db.exec("DELETE FROM article_info WHERE COALESCE(manual, 0) = 0"); } catch {}
// Tri par date de création : colonne nue (pas de DEFAULT non-constant, cf. gotcha SQLite) + backfill
try { db.exec("ALTER TABLE article_info ADD COLUMN created_at TEXT"); } catch {}
try { db.exec("UPDATE article_info SET created_at = COALESCE(updated_at, CURRENT_TIMESTAMP) WHERE created_at IS NULL"); } catch {}
// Tri des items par modification : même pattern, backfill sur created_at
try { db.exec("ALTER TABLE items ADD COLUMN updated_at TEXT"); } catch {}
try { db.exec("UPDATE items SET updated_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS family_members (
    owner_email TEXT NOT NULL,
    member_email TEXT NOT NULL,
    added_at TEXT DEFAULT (datetime('now')),
    can_edit INTEGER DEFAULT 1,
    PRIMARY KEY (owner_email, member_email)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS family_invites (
    owner_email TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    created_at TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS calc_sessions (
    id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    list_id TEXT,
    total REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS calc_lines (
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    price REAL NOT NULL DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES calc_sessions(id) ON DELETE CASCADE
  )
`);

// NOTE: no DEFAULT on ADD COLUMN — SQLite refuses non-constant defaults
// (e.g. CURRENT_TIMESTAMP) when the table already has rows (constant DEFAULT 1 is fine,
// but plain column + backfill below keeps it uniform and risk-free)
try { db.exec("ALTER TABLE family_members ADD COLUMN can_edit INTEGER"); } catch {}
try { db.exec("ALTER TABLE list_members ADD COLUMN can_edit INTEGER"); } catch {}
db.prepare("UPDATE family_members SET can_edit = 1 WHERE can_edit IS NULL").run();
db.prepare("UPDATE list_members SET can_edit = 1 WHERE can_edit IS NULL").run();
try { db.exec("ALTER TABLE family_invites ADD COLUMN created_at TEXT"); } catch {}
try { db.exec("ALTER TABLE lists ADD COLUMN share_token_created_at TEXT"); } catch {}
// backfill timestamps so pre-existing invites stay valid 30 min after deploy
db.prepare("UPDATE family_invites SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL").run();
db.prepare("UPDATE lists SET share_token_created_at = CURRENT_TIMESTAMP WHERE share_token IS NOT NULL AND share_token_created_at IS NULL").run();

try { db.exec("ALTER TABLE users ADD COLUMN pseudo TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE lists ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP"); } catch {}
try { db.exec("ALTER TABLE lists ADD COLUMN share_token TEXT"); } catch {}
try { db.exec("ALTER TABLE lists ADD COLUMN archived INTEGER DEFAULT 0"); } catch {}
db.prepare("UPDATE lists SET archived = 0 WHERE archived IS NULL").run();

const SessionStore = require('express-session').Store;

class SQLiteStore extends SessionStore {
  get(sid, cb) {
    const row = db.prepare("SELECT data FROM sessions WHERE sid = ? AND (expires IS NULL OR expires > datetime('now'))").get(sid);
    cb(null, row ? JSON.parse(row.data) : null);
  }

  set(sid, session, cb) {
    const expires = session.cookie && session.cookie.expires ? new Date(session.cookie.expires).toISOString() : null;
    db.prepare('INSERT OR REPLACE INTO sessions (sid, expires, data) VALUES (?, ?, ?)').run(sid, expires, JSON.stringify(session));
    cb(null);
  }

  destroy(sid, cb) {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    cb(null);
  }

  touch(sid, session, cb) {
    const expires = session.cookie && session.cookie.expires ? new Date(session.cookie.expires).toISOString() : null;
    db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(expires, sid);
    cb(null);
  }
}

module.exports = { db, SQLiteStore };
