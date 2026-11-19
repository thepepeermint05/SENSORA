import {
  AuthUser,
  CameraCaptureRecord,
  DeploymentConfig,
  PermissionState,
  SensorStats,
  StoredSensorReading,
} from '../types/sensor';

const DB_NAME = 'sensora_device_db';
const DB_VERSION = 1;

interface LocalUserRecord extends AuthUser {
  passwordHash: string;
}

interface LocalSessionRecord {
  token: string;
  userId: string;
  expiresAt: string;
}

interface LocalResetRecord {
  id: string;
  email: string;
  code: string;
  expiresAt: string;
  used: boolean;
}

interface LocalReadingRecord extends StoredSensorReading {
  userId: string;
}

interface LocalCaptureRecord extends CameraCaptureRecord {
  userId: string;
  imageBase64: string;
}

function safeUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('users')) {
        const users = db.createObjectStore('users', { keyPath: 'id' });
        users.createIndex('username', 'username', { unique: true });
        users.createIndex('email', 'email', { unique: true });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'token' });
      }
      if (!db.objectStoreNames.contains('resets')) {
        db.createObjectStore('resets', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('permissions')) {
        db.createObjectStore('permissions', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('readings')) {
        const readings = db.createObjectStore('readings', {
          keyPath: 'id',
          autoIncrement: true,
        });
        readings.createIndex('userId', 'userId', { unique: false });
      }
      if (!db.objectStoreNames.contains('camera_captures')) {
        const captures = db.createObjectStore('camera_captures', { keyPath: 'id' });
        captures.createIndex('userId', 'userId', { unique: false });
      }
      if (!db.objectStoreNames.contains('deployment')) {
        db.createObjectStore('deployment', { keyPath: 'userId' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function txPromise<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

function getAllFromStore<T>(storeName: string): Promise<T[]> {
  return txPromise<T[]>(storeName, 'readonly', (s) => s.getAll());
}

async function hashPasswordWeb(password: string): Promise<string> {
  const bytes = new TextEncoder().encode(password);
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(saltBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  try {
    if (crypto.subtle) {
      const key = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: saltBytes, iterations: 10000, hash: 'SHA-256' },
        key,
        256
      );
      const hashHex = Array.from(new Uint8Array(bits))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `pbkdf2:${saltHex}:${hashHex}`;
    }
  } catch {
    // Fallback when subtle crypto is unavailable in WebView
  }
  return `plain:${saltHex}:${btoa(unescape(encodeURIComponent(password)))}`;
}

async function verifyPasswordWeb(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const [scheme, saltHex, expected] = parts;
  if (scheme === 'plain') {
    return btoa(unescape(encodeURIComponent(password))) === expected || btoa(password) === expected;
  }
  try {
    const saltBytes = new Uint8Array(
      saltHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
    );
    const bytes = new TextEncoder().encode(password);
    const key = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: saltBytes, iterations: 10000, hash: 'SHA-256' },
      key,
      256
    );
    const actual = Array.from(new Uint8Array(bits))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return actual === expected;
  } catch {
    return false;
  }
}

function randomToken(): string {
  const arr = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function sanitizeLocalUser(u: LocalUserRecord): AuthUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.displayName,
    authProvider: u.authProvider,
    avatarUrl: u.avatarUrl,
    createdAt: u.createdAt,
  };
}

async function requireLocalUser(token: string): Promise<LocalUserRecord> {
  const session = await txPromise<LocalSessionRecord | undefined>('sessions', 'readonly', (s) =>
    s.get(token)
  );
  if (!session || session.expiresAt <= new Date().toISOString()) {
    throw new Error('Authentication required');
  }
  const user = await txPromise<LocalUserRecord | undefined>('users', 'readonly', (s) =>
    s.get(session.userId)
  );
  if (!user) throw new Error('User not found');
  return user;
}

export async function localRegister(body: {
  username?: string;
  email?: string;
  displayName?: string;
  password?: string;
}): Promise<{ token: string; user: AuthUser }> {
  const cleanEmail = String(body.email || '').trim().toLowerCase();
  const rawUsername = String(body.username || '').trim();
  const normalized = rawUsername
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_.-]/g, '');
  const emailFallback = cleanEmail.split('@')[0]?.replace(/[^a-z0-9_.-]/g, '') || '';
  const cleanUsername = normalized || emailFallback;
  const cleanDisplay = String(body.displayName || rawUsername || cleanUsername).trim();
  const password = String(body.password || '');

  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('Please provide a valid email address.');
  }
  if (cleanUsername.length < 3 || cleanUsername.length > 32) {
    throw new Error('Username must be between 3 and 32 characters.');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters long.');
  }

  const users = await getAllFromStore<LocalUserRecord>('users');
  if (users.some((u) => u.username === cleanUsername || u.email === cleanEmail)) {
    throw new Error('An account with this username or email already exists on this device.');
  }

  const user: LocalUserRecord = {
    id: safeUuid(),
    username: cleanUsername,
    email: cleanEmail,
    displayName: cleanDisplay || cleanUsername,
    authProvider: 'local-device',
    avatarUrl: null,
    createdAt: new Date().toISOString(),
    passwordHash: await hashPasswordWeb(password),
  };

  await txPromise('users', 'readwrite', (s) => s.put(user));
  const token = `local_${randomToken()}`;
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  await txPromise('sessions', 'readwrite', (s) =>
    s.put({ token, userId: user.id, expiresAt } satisfies LocalSessionRecord)
  );
  return { token, user: sanitizeLocalUser(user) };
}

export async function localLogin(body: {
  identifier?: string;
  password?: string;
}): Promise<{ token: string; user: AuthUser }> {
  const cleanId = String(body.identifier || '').trim().toLowerCase();
  const password = String(body.password || '');
  const users = await getAllFromStore<LocalUserRecord>('users');
  const user = users.find((u) => u.username === cleanId || u.email === cleanId);
  if (!user || !(await verifyPasswordWeb(password, user.passwordHash))) {
    throw new Error('Invalid username/email or password.');
  }
  const token = `local_${randomToken()}`;
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  await txPromise('sessions', 'readwrite', (s) =>
    s.put({ token, userId: user.id, expiresAt } satisfies LocalSessionRecord)
  );
  return { token, user: sanitizeLocalUser(user) };
}

export async function localGetMe(token: string): Promise<AuthUser> {
  const user = await requireLocalUser(token);
  return sanitizeLocalUser(user);
}

export async function localLogout(token: string): Promise<void> {
  await txPromise('sessions', 'readwrite', (s) => s.delete(token));
}

export async function localForgotPassword(email: string): Promise<{
  previewCode: string;
  message: string;
}> {
  const cleanEmail = email.trim().toLowerCase();
  const users = await getAllFromStore<LocalUserRecord>('users');
  const user = users.find((u) => u.email === cleanEmail);
  if (!user) {
    throw new Error('No local account found for that email address.');
  }
  const code = String(100000 + Math.floor(Math.random() * 900000));
  const reset: LocalResetRecord = {
    id: safeUuid(),
    email: cleanEmail,
    code,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    used: false,
  };
  await txPromise('resets', 'readwrite', (s) => s.put(reset));
  return {
    previewCode: code,
    message: 'Verification code generated. Enter the 6-digit code below to reset your password.',
  };
}

export async function localResetPassword(body: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<{ message: string }> {
  const cleanEmail = body.email.trim().toLowerCase();
  if (body.newPassword.length < 6) {
    throw new Error('New password must be at least 6 characters long.');
  }
  const resets = await getAllFromStore<LocalResetRecord>('resets');
  const now = new Date().toISOString();
  const match = resets
    .filter((r) => r.email === cleanEmail && r.code === body.code.trim() && !r.used && r.expiresAt > now)
    .pop();
  if (!match) {
    throw new Error('Invalid or expired verification code.');
  }
  const users = await getAllFromStore<LocalUserRecord>('users');
  const user = users.find((u) => u.email === cleanEmail);
  if (!user) throw new Error('Account not found.');

  user.passwordHash = await hashPasswordWeb(body.newPassword);
  match.used = true;
  await txPromise('users', 'readwrite', (s) => s.put(user));
  await txPromise('resets', 'readwrite', (s) => s.put(match));
  return { message: 'Password updated successfully. You can now sign in.' };
}

export async function localGetPermissions(
  token: string
): Promise<Record<string, { state: PermissionState; updatedAt: string }>> {
  const user = await requireLocalUser(token);
  const rows = await getAllFromStore<{ key: string; userId: string; sensorId: string; state: PermissionState; updatedAt: string }>('permissions');
  const map: Record<string, { state: PermissionState; updatedAt: string }> = {};
  for (const r of rows) {
    if (r.userId === user.id) {
      map[r.sensorId] = { state: r.state, updatedAt: r.updatedAt };
    }
  }
  return map;
}

export async function localSetPermission(
  token: string,
  sensorId: string,
  state: PermissionState
): Promise<void> {
  const user = await requireLocalUser(token);
  await txPromise('permissions', 'readwrite', (s) =>
    s.put({
      key: `${user.id}:${sensorId}`,
      userId: user.id,
      sensorId,
      state,
      updatedAt: new Date().toISOString(),
    })
  );
}

export async function localSaveReadings(
  token: string,
  items: Array<{
    deviceId: string;
    sensorId: string;
    primaryValue: number | null;
    unit: string;
    metrics: Record<string, string | number | boolean | null>;
    recordedAt: string;
  }>
): Promise<void> {
  const user = await requireLocalUser(token);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('readings', 'readwrite');
    const store = tx.objectStore('readings');
    for (const item of items) {
      store.add({
        userId: user.id,
        deviceId: item.deviceId,
        sensorId: item.sensorId,
        primaryValue: item.primaryValue,
        unit: item.unit,
        metrics: item.metrics,
        recordedAt: item.recordedAt,
      });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function localGetReadings(
  token: string,
  sensorId: string,
  from?: string
): Promise<{ readings: StoredSensorReading[]; stats: SensorStats }> {
  const user = await requireLocalUser(token);
  const all = await getAllFromStore<LocalReadingRecord>('readings');
  const filtered = all
    .filter((r) => {
      if (r.userId !== user.id) return false;
      if (sensorId !== 'all' && r.sensorId !== sensorId) return false;
      if (from && r.recordedAt < from) return false;
      return true;
    })
    .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))
    .slice(0, 250);

  const vals = filtered
    .map((r) => r.primaryValue)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  const stats: SensorStats = {
    count: filtered.length,
    minVal: vals.length ? Math.min(...vals) : null,
    maxVal: vals.length ? Math.max(...vals) : null,
    avgVal: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
  };

  return { readings: filtered, stats };
}

export async function localGetSummary(token: string): Promise<{
  telemetrySummary: Array<{ sensor_id: string; count: number }>;
  cameraVaultSummary: { count: number };
}> {
  const user = await requireLocalUser(token);
  const readings = await getAllFromStore<LocalReadingRecord>('readings');
  const captures = await getAllFromStore<LocalCaptureRecord>('camera_captures');

  const counts = new Map<string, number>();
  for (const r of readings) {
    if (r.userId === user.id) {
      counts.set(r.sensorId, (counts.get(r.sensorId) || 0) + 1);
    }
  }
  const camCount = captures.filter((c) => c.userId === user.id).length;
  return {
    telemetrySummary: Array.from(counts.entries()).map(([sensor_id, count]) => ({
      sensor_id,
      count,
    })),
    cameraVaultSummary: { count: camCount },
  };
}

export async function localSaveCapture(
  token: string,
  payload: {
    imageBase64: string;
    width: number;
    height: number;
    facingMode: string;
    meanLuminance: number;
    dominantRgb: string;
    fpsEstimate: number;
  }
): Promise<CameraCaptureRecord> {
  const user = await requireLocalUser(token);
  const id = safeUuid();
  const approxBytes = Math.round((payload.imageBase64.length * 3) / 4);
  const record: LocalCaptureRecord = {
    id,
    userId: user.id,
    deviceId: 'android-handset',
    fileName: `${id}.jpg`,
    mimeType: 'image/jpeg',
    fileSizeBytes: approxBytes,
    width: payload.width,
    height: payload.height,
    facingMode: payload.facingMode,
    meanLuminance: payload.meanLuminance,
    dominantRgb: payload.dominantRgb,
    fpsEstimate: payload.fpsEstimate,
    capturedAt: new Date().toISOString(),
    imageBase64: payload.imageBase64,
  };
  await txPromise('camera_captures', 'readwrite', (s) => s.put(record));
  return record;
}

export async function localGetCaptures(
  token: string
): Promise<Array<CameraCaptureRecord & { dataUrl: string }>> {
  const user = await requireLocalUser(token);
  const all = await getAllFromStore<LocalCaptureRecord>('camera_captures');
  return all
    .filter((c) => c.userId === user.id)
    .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))
    .map((c) => ({ ...c, dataUrl: c.imageBase64 }));
}

export async function localDeleteCapture(token: string, id: string): Promise<void> {
  const user = await requireLocalUser(token);
  const existing = await txPromise<LocalCaptureRecord | undefined>('camera_captures', 'readonly', (s) =>
    s.get(id)
  );
  if (existing && existing.userId === user.id) {
    await txPromise('camera_captures', 'readwrite', (s) => s.delete(id));
  }
}

export async function localGetDeployment(token: string): Promise<DeploymentConfig> {
  const user = await requireLocalUser(token);
  const row = await txPromise<(DeploymentConfig & { userId: string }) | undefined>(
    'deployment',
    'readonly',
    (s) => s.get(user.id)
  );
  return row || {
    repoOwner: '',
    repoName: '',
    branch: 'main',
    packageId: 'com.sensora.telemetry',
    updatedAt: null,
  };
}

export async function localSaveDeployment(
  token: string,
  cfg: DeploymentConfig
): Promise<DeploymentConfig> {
  const user = await requireLocalUser(token);
  const updated: DeploymentConfig & { userId: string } = {
    ...cfg,
    userId: user.id,
    updatedAt: new Date().toISOString(),
  };
  await txPromise('deployment', 'readwrite', (s) => s.put(updated));
  return updated;
}
