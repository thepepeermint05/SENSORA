import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { CAMERA_STORAGE_DIR, db, sanitizeUser, type DbUser } from './server/db.ts';

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

interface AuthenticatedRequest extends Request {
  user?: DbUser;
  sessionToken?: string;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, storedHash: string | null): boolean {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

function hashOtp(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  ).run(token, userId, expires.toISOString(), now.toISOString());
  return token;
}

function getUserByToken(token: string | undefined): DbUser | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, new Date().toISOString()) as DbUser | undefined;
  return row ?? null;
}

function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (typeof req.query.token === 'string' && req.query.token.length > 0) {
    return req.query.token;
  }
  return undefined;
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = extractToken(req);
  const user = getUserByToken(token);
  if (!user || !token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

function getBaseUrl(req: Request): string {
  const envUrl = process.env.APP_URL;
  if (envUrl && envUrl.startsWith('http')) {
    return envUrl.replace(/\/$/, '');
  }
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

async function startServer() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '10mb' }));

  const server = http.createServer(app);

  // Real-Time WebSocket server keyed by userId
  const wss = new WebSocketServer({ noServer: true });
  const userSockets = new Map<string, Set<WebSocket>>();

  function broadcastToUser(userId: string, event: { type: string; data: unknown }) {
    const sockets = userSockets.get(userId);
    if (!sockets) return;
    const payload = JSON.stringify(event);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws/telemetry') {
      return;
    }
    const token = url.searchParams.get('token') || undefined;
    const user = getUserByToken(token);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, user);
    });
  });

  wss.on('connection', (ws: WebSocket, user: DbUser) => {
    if (!userSockets.has(user.id)) {
      userSockets.set(user.id, new Set());
    }
    userSockets.get(user.id)!.add(ws);
    ws.send(JSON.stringify({ type: 'ws:connected', data: { userId: user.id } }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          payload?: {
            deviceId?: string;
            sensorId?: string;
            primaryValue?: number | null;
            unit?: string;
            metrics?: Record<string, unknown>;
            recordedAt?: string;
          };
        };
        if (msg.type === 'sensor:reading' && msg.payload) {
          const {
            deviceId = 'android-web',
            sensorId,
            primaryValue = null,
            unit = '',
            metrics = {},
            recordedAt = new Date().toISOString(),
          } = msg.payload;
          if (!sensorId || typeof sensorId !== 'string') return;
          const result = db
            .prepare(
              `INSERT INTO sensor_readings (user_id, device_id, sensor_id, primary_value, unit, metrics_json, recorded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              user.id,
              String(deviceId).slice(0, 64),
              sensorId.slice(0, 48),
              typeof primaryValue === 'number' && Number.isFinite(primaryValue) ? primaryValue : null,
              String(unit).slice(0, 24),
              JSON.stringify(metrics),
              recordedAt
            );
          broadcastToUser(user.id, {
            type: 'reading:saved',
            data: {
              id: Number(result.lastInsertRowid),
              sensorId,
              deviceId,
              primaryValue,
              unit,
              metrics,
              recordedAt,
            },
          });
        }
      } catch {
        // Ignore malformed client frames
      }
    });

    ws.on('close', () => {
      const set = userSockets.get(user.id);
      if (set) {
        set.delete(ws);
        if (set.size === 0) userSockets.delete(user.id);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Authentication Routes
  // ---------------------------------------------------------------------------
  app.post('/api/auth/register', (req, res) => {
    const { username, email, password, displayName } = req.body ?? {};
    const cleanUsername = String(username || '').trim().toLowerCase();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanDisplay = String(displayName || username || '').trim();
    const rawPassword = String(password || '');

    if (!/^[a-z0-9_.-]{3,32}$/.test(cleanUsername)) {
      res.status(400).json({ error: 'Username must be 3–32 characters (letters, numbers, _, ., -).' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      res.status(400).json({ error: 'Please provide a valid email address.' });
      return;
    }
    if (rawPassword.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters long.' });
      return;
    }

    const existing = db
      .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
      .get(cleanUsername, cleanEmail);
    if (existing) {
      res.status(409).json({ error: 'An account with this username or email already exists.' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const passwordHash = hashPassword(rawPassword);

    db.prepare(
      `INSERT INTO users (id, username, email, display_name, password_hash, auth_provider, created_at)
       VALUES (?, ?, ?, ?, ?, 'local', ?)`
    ).run(id, cleanUsername, cleanEmail, cleanDisplay || cleanUsername, passwordHash, now);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as DbUser;
    const token = createSession(id);
    res.status(201).json({ token, user: sanitizeUser(user) });
  });

  app.post('/api/auth/login', (req, res) => {
    const { identifier, password } = req.body ?? {};
    const cleanId = String(identifier || '').trim().toLowerCase();
    const rawPassword = String(password || '');

    if (!cleanId || !rawPassword) {
      res.status(400).json({ error: 'Username/email and password are required.' });
      return;
    }

    const user = db
      .prepare('SELECT * FROM users WHERE username = ? OR email = ?')
      .get(cleanId, cleanId) as DbUser | undefined;

    if (!user || !user.password_hash || !verifyPassword(rawPassword, user.password_hash)) {
      res.status(401).json({ error: 'Invalid credentials. Check your username/email and password.' });
      return;
    }

    const token = createSession(user.id);
    res.json({ token, user: sanitizeUser(user) });
  });

  app.post('/api/auth/logout', requireAuth, (req: AuthenticatedRequest, res) => {
    if (req.sessionToken) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    }
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ user: sanitizeUser(req.user!) });
  });

  app.post('/api/auth/forgot-password', (req, res) => {
    const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail) as DbUser | undefined;
    if (!user) {
      res.status(404).json({ error: 'No local account found for that email address.' });
      return;
    }

    const code = String(crypto.randomInt(100000, 999999));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

    db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ?').run(user.id);
    db.prepare(
      `INSERT INTO password_resets (id, user_id, email, code_hash, expires_at, used, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    ).run(crypto.randomUUID(), user.id, cleanEmail, hashOtp(code), expiresAt, now.toISOString());

    res.json({
      ok: true,
      expiresAt,
      deliveryMode: 'in_app_preview',
      previewCode: code,
      message: 'Verification code generated. Enter the 6-digit code below to reset your password.',
    });
  });

  app.post('/api/auth/reset-password', (req, res) => {
    const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    if (!cleanEmail || !/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'Valid email and 6-digit verification code are required.' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: 'New password must be at least 8 characters long.' });
      return;
    }

    const resetRow = db
      .prepare(
        `SELECT * FROM password_resets
         WHERE email = ? AND code_hash = ? AND used = 0 AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(cleanEmail, hashOtp(code), new Date().toISOString()) as
      | { id: string; user_id: string }
      | undefined;

    if (!resetRow) {
      res.status(400).json({ error: 'Invalid or expired verification code.' });
      return;
    }

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      hashPassword(newPassword),
      resetRow.user_id
    );
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(resetRow.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(resetRow.user_id);

    res.json({ ok: true, message: 'Password updated successfully. You can now sign in.' });
  });

  // Google OAuth 2.0 Popup Flow
  app.get('/api/auth/google/status', (req, res) => {
    const configured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    const callbackUrl = `${getBaseUrl(req)}/auth/google/callback`;
    res.json({ configured, callbackUrl });
  });

  app.get('/api/auth/google/url', (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.status(503).json({
        error: 'Google OAuth credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) are not configured on the server.',
        callbackUrl: `${getBaseUrl(req)}/auth/google/callback`,
      });
      return;
    }

    const redirectUri = `${getBaseUrl(req)}/auth/google/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      prompt: 'select_account',
    });

    res.json({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      redirectUri,
    });
  });

  const handleGoogleCallback = async (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!code || !clientId || !clientSecret) {
      res.status(400).send('<p>Google OAuth callback failed: missing code or server credentials.</p>');
      return;
    }

    try {
      const redirectUri = `${getBaseUrl(req)}/auth/google/callback`;
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
      if (!tokenRes.ok || !tokenJson.access_token) {
        throw new Error(tokenJson.error || 'Token exchange failed');
      }

      const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      const profile = (await profileRes.json()) as {
        sub: string;
        email: string;
        name?: string;
        picture?: string;
      };

      const cleanEmail = profile.email.toLowerCase();
      let user = db
        .prepare('SELECT * FROM users WHERE google_sub = ? OR email = ?')
        .get(profile.sub, cleanEmail) as DbUser | undefined;

      if (!user) {
        const id = crypto.randomUUID();
        const baseUsername = cleanEmail.split('@')[0].replace(/[^a-z0-9_.-]/g, '') || 'user';
        const uniqueUsername = `${baseUsername}_${crypto.randomBytes(2).toString('hex')}`;
        db.prepare(
          `INSERT INTO users (id, username, email, display_name, auth_provider, google_sub, avatar_url, created_at)
           VALUES (?, ?, ?, ?, 'google', ?, ?, ?)`
        ).run(
          id,
          uniqueUsername,
          cleanEmail,
          profile.name || baseUsername,
          profile.sub,
          profile.picture || null,
          new Date().toISOString()
        );
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as DbUser;
      } else if (!user.google_sub) {
        db.prepare('UPDATE users SET google_sub = ?, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?').run(
          profile.sub,
          profile.picture || null,
          user.id
        );
      }

      const sessionToken = createSession(user.id);
      res.send(`<!doctype html>
<html>
  <body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
    <p>Google Sign-In successful. Returning to Sensora...</p>
    <script>
      if (window.opener) {
        window.opener.postMessage({ type: 'GOOGLE_OAUTH_SUCCESS', token: ${JSON.stringify(sessionToken)} }, '*');
        window.close();
      } else {
        window.localStorage.setItem('sensora_token', ${JSON.stringify(sessionToken)});
        window.location.href = '/';
      }
    </script>
  </body>
</html>`);
    } catch (err) {
      res.status(500).send(`<p>Google authentication failed: ${err instanceof Error ? err.message : 'Unknown error'}</p>`);
    }
  };

  app.get(['/auth/google/callback', '/auth/google/callback/'], handleGoogleCallback);

  // ---------------------------------------------------------------------------
  // Sensor Permissions & Telemetry Routes
  // ---------------------------------------------------------------------------
  app.get('/api/sensors/permissions', requireAuth, (req: AuthenticatedRequest, res) => {
    const rows = db
      .prepare('SELECT sensor_id, permission_state, updated_at FROM sensor_permissions WHERE user_id = ?')
      .all(req.user!.id) as Array<{ sensor_id: string; permission_state: string; updated_at: string }>;
    const map: Record<string, { state: string; updatedAt: string }> = {};
    for (const r of rows) {
      map[r.sensor_id] = { state: r.permission_state, updatedAt: r.updated_at };
    }
    res.json({ permissions: map });
  });

  app.put('/api/sensors/permissions/:sensorId', requireAuth, (req: AuthenticatedRequest, res) => {
    const { sensorId } = req.params;
    const state = String(req.body?.state || 'prompt');
    if (!['granted', 'denied', 'prompt'].includes(state)) {
      res.status(400).json({ error: 'Invalid permission state' });
      return;
    }
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sensor_permissions (user_id, sensor_id, permission_state, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, sensor_id) DO UPDATE SET permission_state = excluded.permission_state, updated_at = excluded.updated_at`
    ).run(req.user!.id, sensorId, state, now);
    res.json({ sensorId, state, updatedAt: now });
  });

  app.post('/api/sensors/readings', requireAuth, (req: AuthenticatedRequest, res) => {
    const items = Array.isArray(req.body?.readings) ? req.body.readings : [req.body];
    if (items.length === 0 || items.length > 50) {
      res.status(400).json({ error: 'Provide between 1 and 50 readings per batch.' });
      return;
    }

    const insertStmt = db.prepare(
      `INSERT INTO sensor_readings (user_id, device_id, sensor_id, primary_value, unit, metrics_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const saved: Array<Record<string, unknown>> = [];
    for (const item of items) {
      if (!item || typeof item.sensorId !== 'string') continue;
      const recordedAt = typeof item.recordedAt === 'string' ? item.recordedAt : new Date().toISOString();
      const primaryValue =
        typeof item.primaryValue === 'number' && Number.isFinite(item.primaryValue)
          ? item.primaryValue
          : null;
      const unit = String(item.unit || '').slice(0, 24);
      const deviceId = String(item.deviceId || 'android-web').slice(0, 64);
      const metrics = item.metrics && typeof item.metrics === 'object' ? item.metrics : {};

      const info = insertStmt.run(
        req.user!.id,
        deviceId,
        item.sensorId.slice(0, 48),
        primaryValue,
        unit,
        JSON.stringify(metrics),
        recordedAt
      );
      const row = {
        id: Number(info.lastInsertRowid),
        sensorId: item.sensorId,
        deviceId,
        primaryValue,
        unit,
        metrics,
        recordedAt,
      };
      saved.push(row);
      broadcastToUser(req.user!.id, { type: 'reading:saved', data: row });
    }

    res.status(201).json({ count: saved.length, readings: saved });
  });

  app.get('/api/sensors/readings', requireAuth, (req: AuthenticatedRequest, res) => {
    const sensorId = typeof req.query.sensorId === 'string' ? req.query.sensorId : '';
    const from = typeof req.query.from === 'string' ? req.query.from : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 150, 1), 1000);

    const conditions = ['user_id = ?'];
    const params: Array<string | number> = [req.user!.id];

    if (sensorId && sensorId !== 'all') {
      conditions.push('sensor_id = ?');
      params.push(sensorId);
    }
    if (from) {
      conditions.push('recorded_at >= ?');
      params.push(from);
    }

    const whereSql = conditions.join(' AND ');
    const rows = db
      .prepare(
        `SELECT id, device_id, sensor_id, primary_value, unit, metrics_json, recorded_at
         FROM sensor_readings
         WHERE ${whereSql}
         ORDER BY recorded_at DESC
         LIMIT ?`
      )
      .all(...params, limit) as Array<{
      id: number;
      device_id: string;
      sensor_id: string;
      primary_value: number | null;
      unit: string;
      metrics_json: string;
      recorded_at: string;
    }>;

    const stats = db
      .prepare(
        `SELECT
           COUNT(*) as count,
           MIN(primary_value) as minVal,
           MAX(primary_value) as maxVal,
           AVG(primary_value) as avgVal
         FROM sensor_readings
         WHERE ${whereSql} AND primary_value IS NOT NULL`
      )
      .get(...params) as { count: number; minVal: number | null; maxVal: number | null; avgVal: number | null };

    res.json({
      readings: rows.map((r) => ({
        id: r.id,
        deviceId: r.device_id,
        sensorId: r.sensor_id,
        primaryValue: r.primary_value,
        unit: r.unit,
        metrics: JSON.parse(r.metrics_json),
        recordedAt: r.recorded_at,
      })),
      stats,
    });
  });

  app.get('/api/sensors/summary', requireAuth, (req: AuthenticatedRequest, res) => {
    const perSensor = db
      .prepare(
        `SELECT sensor_id, COUNT(*) as count, MAX(recorded_at) as last_recorded_at
         FROM sensor_readings
         WHERE user_id = ?
         GROUP BY sensor_id`
      )
      .all(req.user!.id) as Array<{ sensor_id: string; count: number; last_recorded_at: string }>;

    const cameraStats = db
      .prepare(
        `SELECT COUNT(*) as count, COALESCE(SUM(file_size_bytes), 0) as total_bytes, MAX(captured_at) as last_captured_at
         FROM camera_captures
         WHERE user_id = ?`
      )
      .get(req.user!.id) as { count: number; total_bytes: number; last_captured_at: string | null };

    res.json({
      telemetrySummary: perSensor,
      cameraVaultSummary: {
        count: cameraStats.count,
        totalBytes: cameraStats.total_bytes,
        lastCapturedAt: cameraStats.last_captured_at,
      },
    });
  });

  app.get('/api/sensors/export', requireAuth, (req: AuthenticatedRequest, res) => {
    const sensorId = typeof req.query.sensorId === 'string' ? req.query.sensorId : '';
    const format = req.query.format === 'json' ? 'json' : 'csv';

    const params: Array<string> = [req.user!.id];
    let sql = `SELECT id, device_id, sensor_id, primary_value, unit, metrics_json, recorded_at
               FROM sensor_readings WHERE user_id = ?`;
    if (sensorId && sensorId !== 'all') {
      sql += ' AND sensor_id = ?';
      params.push(sensorId);
    }
    sql += ' ORDER BY recorded_at DESC LIMIT 5000';

    const rows = db.prepare(sql).all(...params) as Array<{
      id: number;
      device_id: string;
      sensor_id: string;
      primary_value: number | null;
      unit: string;
      metrics_json: string;
      recorded_at: string;
    }>;

    if (format === 'json') {
      res.setHeader('Content-Disposition', 'attachment; filename="sensora-telemetry.json"');
      res.json(
        rows.map((r) => ({
          id: r.id,
          deviceId: r.device_id,
          sensorId: r.sensor_id,
          primaryValue: r.primary_value,
          unit: r.unit,
          metrics: JSON.parse(r.metrics_json),
          recordedAt: r.recorded_at,
        }))
      );
      return;
    }

    const header = 'id,device_id,sensor_id,primary_value,unit,metrics_json,recorded_at';
    const lines = rows.map((r) =>
      [
        r.id,
        JSON.stringify(r.device_id),
        JSON.stringify(r.sensor_id),
        r.primary_value ?? '',
        JSON.stringify(r.unit),
        JSON.stringify(r.metrics_json),
        JSON.stringify(r.recorded_at),
      ].join(',')
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sensora-telemetry.csv"');
    res.send([header, ...lines].join('\n'));
  });

  // ---------------------------------------------------------------------------
  // Separate Camera Optical Media Vault Routes
  // (Binary JPEG files stored on disk + metadata indexed in camera_captures)
  // ---------------------------------------------------------------------------
  app.post('/api/camera/captures', requireAuth, (req: AuthenticatedRequest, res) => {
    const {
      imageBase64,
      deviceId = 'android-web',
      width = 0,
      height = 0,
      facingMode = 'environment',
      meanLuminance = 0,
      dominantRgb = 'rgb(0,0,0)',
      fpsEstimate = 30,
      capturedAt = new Date().toISOString(),
    } = req.body ?? {};

    if (typeof imageBase64 !== 'string' || !imageBase64.startsWith('data:image/')) {
      res.status(400).json({ error: 'Valid base64 image frame is required.' });
      return;
    }

    const match = imageBase64.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);
    if (!match) {
      res.status(400).json({ error: 'Unsupported image format. Use JPEG, PNG, or WebP.' });
      return;
    }

    const mimeType = match[1].toLowerCase();
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 5 * 1024 * 1024) {
      res.status(413).json({ error: 'Frame exceeds 5MB storage limit.' });
      return;
    }

    const captureId = crypto.randomUUID();
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
    const fileName = `${captureId}.${ext}`;
    const userDir = path.join(CAMERA_STORAGE_DIR, req.user!.id);
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, fileName), buffer);

    db.prepare(
      `INSERT INTO camera_captures (
        id, user_id, device_id, file_name, mime_type, file_size_bytes,
        width, height, facing_mode, mean_luminance, dominant_rgb, fps_estimate, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      captureId,
      req.user!.id,
      String(deviceId).slice(0, 64),
      fileName,
      mimeType,
      buffer.length,
      Number(width) || 0,
      Number(height) || 0,
      String(facingMode).slice(0, 24),
      Number(meanLuminance) || 0,
      String(dominantRgb).slice(0, 32),
      Number(fpsEstimate) || 0,
      capturedAt
    );

    const record = {
      id: captureId,
      deviceId,
      fileName,
      mimeType,
      fileSizeBytes: buffer.length,
      width: Number(width) || 0,
      height: Number(height) || 0,
      facingMode,
      meanLuminance: Number(meanLuminance) || 0,
      dominantRgb,
      fpsEstimate: Number(fpsEstimate) || 0,
      capturedAt,
    };

    broadcastToUser(req.user!.id, { type: 'camera:captured', data: record });
    res.status(201).json({ capture: record });
  });

  app.get('/api/camera/captures', requireAuth, (req: AuthenticatedRequest, res) => {
    const rows = db
      .prepare(
        `SELECT id, device_id, file_name, mime_type, file_size_bytes, width, height,
                facing_mode, mean_luminance, dominant_rgb, fps_estimate, captured_at
         FROM camera_captures
         WHERE user_id = ?
         ORDER BY captured_at DESC
         LIMIT 60`
      )
      .all(req.user!.id) as Array<{
      id: string;
      device_id: string;
      file_name: string;
      mime_type: string;
      file_size_bytes: number;
      width: number;
      height: number;
      facing_mode: string;
      mean_luminance: number;
      dominant_rgb: string;
      fps_estimate: number | null;
      captured_at: string;
    }>;

    res.json({
      captures: rows.map((r) => ({
        id: r.id,
        deviceId: r.device_id,
        fileName: r.file_name,
        mimeType: r.mime_type,
        fileSizeBytes: r.file_size_bytes,
        width: r.width,
        height: r.height,
        facingMode: r.facing_mode,
        meanLuminance: r.mean_luminance,
        dominantRgb: r.dominant_rgb,
        fpsEstimate: r.fps_estimate,
        capturedAt: r.captured_at,
      })),
    });
  });

  app.get('/api/camera/files/:captureId', requireAuth, (req: AuthenticatedRequest, res) => {
    const row = db
      .prepare('SELECT file_name, mime_type FROM camera_captures WHERE id = ? AND user_id = ?')
      .get(req.params.captureId, req.user!.id) as { file_name: string; mime_type: string } | undefined;

    if (!row) {
      res.status(404).json({ error: 'Optical capture not found' });
      return;
    }

    const filePath = path.join(CAMERA_STORAGE_DIR, req.user!.id, path.basename(row.file_name));
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Stored binary frame missing on disk' });
      return;
    }

    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(filePath);
  });

  app.delete('/api/camera/captures/:captureId', requireAuth, (req: AuthenticatedRequest, res) => {
    const row = db
      .prepare('SELECT file_name FROM camera_captures WHERE id = ? AND user_id = ?')
      .get(req.params.captureId, req.user!.id) as { file_name: string } | undefined;

    if (!row) {
      res.status(404).json({ error: 'Capture not found' });
      return;
    }

    const filePath = path.join(CAMERA_STORAGE_DIR, req.user!.id, path.basename(row.file_name));
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    db.prepare('DELETE FROM camera_captures WHERE id = ? AND user_id = ?').run(
      req.params.captureId,
      req.user!.id
    );
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // GitHub & Capacitor APK Deployment Config Routes
  // ---------------------------------------------------------------------------
  app.get('/api/deployment/config', requireAuth, (req: AuthenticatedRequest, res) => {
    const row = db
      .prepare('SELECT repo_owner, repo_name, branch, package_id, updated_at FROM github_deployments WHERE user_id = ?')
      .get(req.user!.id) as
      | { repo_owner: string; repo_name: string; branch: string; package_id: string; updated_at: string }
      | undefined;

    let workflowYaml = '';
    try {
      workflowYaml = fs.readFileSync(path.resolve(process.cwd(), '.github/workflows/android-apk.yml'), 'utf8');
    } catch {
      workflowYaml = '';
    }

    res.json({
      config: row
        ? {
            repoOwner: row.repo_owner,
            repoName: row.repo_name,
            branch: row.branch,
            packageId: row.package_id,
            updatedAt: row.updated_at,
          }
        : {
            repoOwner: '',
            repoName: '',
            branch: 'main',
            packageId: 'com.sensora.telemetry',
            updatedAt: null,
          },
      workflowYaml,
    });
  });

  app.put('/api/deployment/config', requireAuth, (req: AuthenticatedRequest, res) => {
    const repoOwner = String(req.body?.repoOwner || '').trim().slice(0, 64);
    const repoName = String(req.body?.repoName || '').trim().slice(0, 64);
    const branch = String(req.body?.branch || 'main').trim().slice(0, 48) || 'main';
    const packageId = String(req.body?.packageId || 'com.sensora.telemetry').trim().slice(0, 80);
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO github_deployments (user_id, repo_owner, repo_name, branch, package_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         repo_owner = excluded.repo_owner,
         repo_name = excluded.repo_name,
         branch = excluded.branch,
         package_id = excluded.package_id,
         updated_at = excluded.updated_at`
    ).run(req.user!.id, repoOwner, repoName, branch, packageId, now);

    res.json({
      config: { repoOwner, repoName, branch, packageId, updatedAt: now },
    });
  });

  // ---------------------------------------------------------------------------
  // Vite Dev Middleware / Production Static Assets
  // ---------------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sensora server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Sensora server:', err);
  process.exit(1);
});
