import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const migrations = [
  { version: 1, name: 'initial', url: new URL('./migrations/001-initial.sql', import.meta.url) },
  { version: 2, name: 'tag-vocabulary', url: new URL('./migrations/002-tag-vocabulary.sql', import.meta.url) },
  { version: 3, name: 'object-detection', url: new URL('./migrations/003-object-detection.sql', import.meta.url) }
];

const sha256 = value => createHash('sha256').update(value).digest('hex');
const migrationChecksum = sql => sha256(String(sql).replace(/\r\n?/g, '\n'));
const legacyMigrationChecksum = sql => sha256(String(sql));

function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

async function applyMigrations(db, readMigration) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);
  const applied = new Map(db.prepare('SELECT version, checksum FROM migrations').all().map(row => [row.version, row.checksum]));
  const latest = migrations.at(-1)?.version ?? 0;
  const unexpected = [...applied.keys()].filter(version => version > latest);
  if (unexpected.length) throw new Error(`Catalog schema ${Math.max(...unexpected)} is newer than this MythiCut build supports (${latest})`);
  for (const migration of migrations) {
    const sql = await readMigration(migration.url);
    const checksum = migrationChecksum(sql);
    if (applied.has(migration.version)) {
      if (applied.get(migration.version) === checksum) continue;
      if (applied.get(migration.version) === legacyMigrationChecksum(sql)) {
        transaction(db, () => {
          db.prepare('UPDATE migrations SET checksum = ? WHERE version = ?').run(checksum, migration.version);
        });
        continue;
      }
      throw new Error(`Catalog migration ${migration.version} checksum mismatch`);
    }
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, checksum, new Date().toISOString());
    });
  }
}

export async function openCatalogDatabase(path, { name = 'Untitled image catalog', clock = () => new Date(), id = randomUUID, readMigration = url => readFile(url, 'utf8') } = {}) {
  if (path !== ':memory:') {
    if (typeof path !== 'string' || !path.trim()) throw new Error('A catalog path is required');
    await mkdir(dirname(resolve(path)), { recursive: true });
  }
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    await applyMigrations(db, readMigration);
    const existing = db.prepare('SELECT id FROM catalogs LIMIT 1').get();
    if (!existing) {
      const now = clock().toISOString();
      db.prepare('INSERT INTO catalogs(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(id(), String(name).trim() || 'Untitled image catalog', now, now);
    }
    return {
      db,
      transaction: callback => transaction(db, callback),
      async backupTo(destination) {
        if (path === ':memory:' && !destination) throw new Error('A backup destination is required');
        await mkdir(dirname(resolve(destination)), { recursive: true });
        return backup(db, resolve(destination));
      },
      close() { if (db.isOpen) db.close(); },
      path: path === ':memory:' ? path : resolve(path)
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
