import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = path.resolve(process.cwd(), 'data');
export const CAMERA_STORAGE_DIR = path.join(DATA_DIR, 'camera_captures');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CAMERA_STORAGE_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'sensora.db');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    auth_provider TEXT NOT NULL DEFAULT 'local',
    google_sub TEXT UNIQUE,
    avatar_url TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sensor_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    sensor_id TEXT NOT NULL,
    primary_value REAL,
    unit TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sensor_readings_user_sensor_time
    ON sensor_readings(user_id, sensor_id, recorded_at DESC);

  CREATE TABLE IF NOT EXISTS camera_captures (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    facing_mode TEXT NOT NULL,
    mean_luminance REAL NOT NULL,
    dominant_rgb TEXT NOT NULL,
    fps_estimate REAL,
    captured_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_camera_captures_user_time
    ON camera_captures(user_id, captured_at DESC);

  CREATE TABLE IF NOT EXISTS sensor_permissions (
    user_id TEXT NOT NULL,
    sensor_id TEXT NOT NULL,
    permission_state TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, sensor_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS github_deployments (
    user_id TEXT PRIMARY KEY,
    repo_owner TEXT NOT NULL DEFAULT '',
    repo_name TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT 'main',
    package_id TEXT NOT NULL DEFAULT 'com.sensora.telemetry',
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

export interface DbUser {
  id: string;
  username: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  auth_provider: string;
  google_sub: string | null;
  avatar_url: string | null;
  created_at: string;
}

export function sanitizeUser(user: DbUser) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.display_name,
    authProvider: user.auth_provider,
    avatarUrl: user.avatar_url,
    createdAt: user.created_at,
  };
}
