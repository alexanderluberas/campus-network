import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const decode = row => row ? JSON.parse(row.body) : null;

export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS assets(type TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(type,id));
      CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,target TEXT NOT NULL,at TEXT NOT NULL,body TEXT NOT NULL, UNIQUE(kind,target,at));
      CREATE INDEX IF NOT EXISTS observations_lookup ON observations(kind,target,at);
      CREATE INDEX IF NOT EXISTS observations_baseline ON observations(kind,target,json_extract(body,'$.baselinePeriod.key'),at);
      CREATE TABLE IF NOT EXISTS records(type TEXT NOT NULL,id TEXT NOT NULL,at TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(type,id));
      CREATE INDEX IF NOT EXISTS records_lookup ON records(type,at);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,body TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  transaction(fn) {
    const nested = this.transactionDepth > 0;
    this.transactionDepth = (this.transactionDepth || 0) + 1;
    const savepoint = `nested_${this.transactionDepth}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT'); return result; }
    catch (error) { this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); throw error; }
    finally { this.transactionDepth--; }
  }
  assets(type) { return this.db.prepare('SELECT body FROM assets WHERE type=? ORDER BY id').all(type).map(decode); }
  asset(type, id) { return decode(this.db.prepare('SELECT body FROM assets WHERE type=? AND id=?').get(type, id)); }
  putAsset(type, body) { this.db.prepare('INSERT INTO assets VALUES(?,?,?) ON CONFLICT(type,id) DO UPDATE SET body=excluded.body').run(type, body.id, JSON.stringify(body)); return body; }
  deleteAsset(type, id) { this.db.prepare('DELETE FROM assets WHERE type=? AND id=?').run(type, id); }
  addObservation(o) {
    const body = { ...o, id: randomUUID() };
    const result = this.db.prepare('INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?)').run(body.id, o.kind, o.targetId, o.observedAt, JSON.stringify(body));
    return result.changes > 0;
  }
  latest(kind, target) { return decode(this.db.prepare('SELECT body FROM observations WHERE kind=? AND target=? ORDER BY at DESC LIMIT 1').get(kind, target)); }
  observations(kind, target, since = '1970', until = '9999', limit = 10000) {
    return this.db.prepare('SELECT body FROM observations WHERE kind=? AND target=? AND at>=? AND at<? ORDER BY at DESC LIMIT ?').all(kind, target, since, until, limit).map(decode);
  }
  baselineHistory(target, key, since, until) {
    return this.db.prepare("SELECT body FROM observations WHERE kind='interface' AND target=? AND json_extract(body,'$.baselinePeriod.key')=? AND at>=? AND at<? ORDER BY at").all(target, key, since, until).map(decode);
  }
  record(type, body) {
    body = { id: randomUUID(), createdAt: new Date().toISOString(), ...body };
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(type,id) DO UPDATE SET body=excluded.body').run(type, body.id, body.createdAt, JSON.stringify(body));
    return body;
  }
  records(type, limit = 1000) { return this.db.prepare('SELECT body FROM records WHERE type=? ORDER BY at DESC LIMIT ?').all(type, limit).map(decode); }
  getRecord(type, id) { return decode(this.db.prepare('SELECT body FROM records WHERE type=? AND id=?').get(type, id)); }
  state(key) { return decode(this.db.prepare('SELECT body FROM state WHERE key=?').get(key)); }
  setState(key, value) { this.db.prepare('INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(value)); }
  purge(before) {
    this.db.prepare('DELETE FROM observations WHERE at<?').run(before);
    this.db.prepare("DELETE FROM records WHERE type='syslog' AND at<?").run(before);
  }
  close() { this.db.close(); }
}
