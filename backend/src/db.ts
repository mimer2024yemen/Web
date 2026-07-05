import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { env } from './env.js';
import { availablePermissions } from './rbac.js';

fs.mkdirSync(env.dataDir, { recursive: true });
fs.mkdirSync(env.uploadDir, { recursive: true });

const dbPath = path.join(env.dataDir, 'newshub.sqlite');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function nowIso() {
  return new Date().toISOString();
}

function hasColumn(table: string, column: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function addColumn(table: string, column: string, sql: string) {
  if (!hasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sql}`);
  }
}

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      status TEXT NOT NULL DEFAULT 'active',
      permissions_json TEXT NOT NULL DEFAULT '[]',
      two_factor_enabled INTEGER NOT NULL DEFAULT 0,
      two_factor_secret TEXT,
      last_login_at TEXT,
      failed_logins INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT,
      secret_key TEXT,
      username TEXT,
      app_password TEXT,
      cms TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      summary TEXT,
      content TEXT NOT NULL,
      author TEXT,
      seo_title TEXT,
      seo_description TEXT,
      categories_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      featured_image TEXT,
      gallery_json TEXT NOT NULL DEFAULT '[]',
      video_url TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      schedule_at TEXT,
      published_at TEXT,
      publish_results_json TEXT NOT NULL DEFAULT '[]',
      target_site_ids_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      local_path TEXT NOT NULL,
      storage_provider TEXT NOT NULL DEFAULT 'local',
      storage_key TEXT,
      public_url TEXT NOT NULL,
      alt_text TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS publish_queue (
      id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL,
      site_id TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      scheduled_for TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_logs (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      site_id TEXT,
      status TEXT NOT NULL,
      message TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      target_url TEXT NOT NULL,
      secret TEXT,
      events_json TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  addColumn('users', 'status', "TEXT NOT NULL DEFAULT 'active'");
  addColumn('users', 'permissions_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('users', 'two_factor_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'two_factor_secret', 'TEXT');
  addColumn('users', 'last_login_at', 'TEXT');
  addColumn('users', 'failed_logins', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'locked_until', 'TEXT');
  addColumn('users', 'avatar_url', 'TEXT');
  addColumn('articles', 'publish_results_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('media', 'storage_provider', "TEXT NOT NULL DEFAULT 'local'");
  addColumn('media', 'storage_key', 'TEXT');

  const admin = db.prepare('SELECT id FROM users WHERE email = ?').get(env.adminEmail) as { id: string } | undefined;
  if (!admin) {
    const id = 'usr_admin';
    const ts = nowIso();
    db.prepare(`INSERT INTO users (id, name, email, password_hash, role, status, permissions_json, two_factor_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'super-admin', 'active', ?, 0, ?, ?)`)
      .run(id, env.adminName, env.adminEmail, bcrypt.hashSync(env.adminPassword, 10), JSON.stringify(['*']), ts, ts);
  } else {
    db.prepare(`UPDATE users SET role = COALESCE(role, 'super-admin'), status = COALESCE(status, 'active'),
      permissions_json = CASE WHEN permissions_json IS NULL OR permissions_json = '' THEN permissions_json ELSE permissions_json END
      WHERE id = ?`).run(admin.id);
  }

  const defaults = [
    ['branding', { appName: 'NewsHub Pro', logo: 'N', theme: 'midnight' }],
    ['publishing', { autoProcessQueue: true, retryAttempts: 3, retryBackoffMinutes: 5, publishToAllOnDemand: true }],
    ['security', { rateLimitPerMinute: 120, enableAuditLog: true, lockAfterFailedAttempts: 5, lockMinutes: 15, availablePermissions: availablePermissions() }],
  ];
  for (const [key, value] of defaults) {
    db.prepare('INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(value), nowIso());
  }
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
