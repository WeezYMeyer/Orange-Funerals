// Keeps logins and "already entered my email" in the SQLite database, so they
// survive deploys and restarts. (The old in-memory store forgot everyone each
// time Render restarted the app.) The database lives on the persistent disk.

const session = require("express-session");
const db = require("./db");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    sess    TEXT NOT NULL,
    expires INTEGER NOT NULL          -- ms since epoch
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
`);

const DAY = 24 * 60 * 60 * 1000;

class SqliteStore extends session.Store {
  constructor() {
    super();
    this.getStmt = db.prepare("SELECT sess, expires FROM sessions WHERE sid = ?");
    this.setStmt = db.prepare(
      `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`
    );
    this.touchStmt = db.prepare("UPDATE sessions SET expires = ? WHERE sid = ?");
    this.delStmt = db.prepare("DELETE FROM sessions WHERE sid = ?");
    // Clear out expired sessions once an hour.
    const prune = () => {
      try { db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now()); } catch (e) {}
    };
    prune();
    setInterval(prune, 60 * 60 * 1000).unref();
  }

  expiry(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : Date.now() + DAY;
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), this.expiry(sess));
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.touchStmt.run(this.expiry(sess), sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.delStmt.run(sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }
}

module.exports = SqliteStore;
