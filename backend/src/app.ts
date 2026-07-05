import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import staticPlugin from '@fastify/static';
import bcrypt from 'bcryptjs';
import slugify from 'slugify';
import { customAlphabet } from 'nanoid';
import cron from 'node-cron';
import jsonwebtoken from 'jsonwebtoken';
import axios from 'axios';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { env } from './env.js';
import { db, initDatabase, nowIso, parseJson } from './db.js';
import { availablePermissions, hasPermission, resolvePermissions } from './rbac.js';
import { createMask, decryptSecret, encryptSecret, generateTwoFactorSecret, verifyTwoFactorToken } from './security.js';
import { storeBuffer } from './storage.js';
import { publishToWordPress, syncWordPressTaxonomies, testWordPressConnection } from './services/wordpress.js';

const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyz', 12);
const redis = env.redisUrl ? new (Redis as any)(env.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false }) : null;
const publishQueue = redis ? new Queue('newshub-publish', { connection: redis }) : null;
let publishWorker: Worker | null = null;

type DbRow = Record<string, any>;

type PublishResult = {
  siteId: string;
  siteName: string;
  status: 'success' | 'failed' | 'skipped';
  message: string;
  link?: string;
  wpResponseId?: number;
};

function rowToArticle(row: DbRow): DbRow {
  return {
    ...row,
    categories: parseJson<string[]>(String(row.categories_json ?? '[]'), []),
    tags: parseJson<string[]>(String(row.tags_json ?? '[]'), []),
    gallery: parseJson<string[]>(String(row.gallery_json ?? '[]'), []),
    targetSiteIds: parseJson<string[]>(String(row.target_site_ids_json ?? '[]'), []),
    publishResults: parseJson<PublishResult[]>(String(row.publish_results_json ?? '[]'), []),
  };
}

function rowToSite(row: DbRow): DbRow {
  const config = parseJson<Record<string, any>>(String(row.config_json ?? '{}'), {});
  return {
    ...row,
    config,
    baseUrl: row.base_url,
    username: row.username,
    appPasswordMasked: createMask(decryptSecret(String(row.app_password ?? ''), env.encryptionKey)),
    secretKeyMasked: createMask(decryptSecret(String(row.secret_key ?? ''), env.encryptionKey)),
    app_password: undefined,
    secret_key: undefined,
  };
}

function rowToWebhook(row: DbRow): DbRow {
  return {
    ...row,
    events: parseJson<string[]>(String(row.events_json ?? '[]'), []),
    isActive: Boolean(row.is_active),
  };
}

function rowToUser(row: DbRow): DbRow {
  const permissions = resolvePermissions(String(row.role ?? 'viewer'), parseJson<string[]>(String(row.permissions_json ?? '[]'), []));
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status ?? 'active',
    permissions,
    twoFactorEnabled: Boolean(row.two_factor_enabled),
    lastLoginAt: row.last_login_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function audit(userId: string | null, action: string, entityType: string, entityId: string | null, metadata: unknown = {}) {
  db.prepare(`INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`aud_${nanoid()}`, userId, action, entityType, entityId, JSON.stringify(metadata), nowIso());
}

function syncLog(entityType: string, entityId: string, siteId: string | null, status: string, message: string, metadata: unknown = {}) {
  db.prepare(`INSERT INTO sync_logs (id, entity_type, entity_id, site_id, status, message, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(`log_${nanoid()}`, entityType, entityId, siteId, status, message, JSON.stringify(metadata), nowIso());
}

function articleSlug(title: string, fallbackId?: string) {
  const base = slugify(title, { lower: true, strict: true, trim: true, locale: 'ar' });
  return base || `article-${fallbackId ?? nanoid()}`;
}

function securitySettings() {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get('security') as { value_json?: string } | undefined;
  return parseJson<Record<string, any>>(row?.value_json ?? '', { lockAfterFailedAttempts: 5, lockMinutes: 15, rateLimitPerMinute: 120 });
}

async function emitWebhookEvent(event: string, payload: Record<string, any>) {
  const hooks = db.prepare('SELECT * FROM webhooks WHERE is_active = 1').all() as DbRow[];
  for (const hook of hooks) {
    const events = parseJson<string[]>(String(hook.events_json ?? '[]'), []);
    if (!events.includes(event)) continue;
    const body = { event, payload, timestamp: nowIso() };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (hook.secret) {
      headers['x-newshub-signature'] = crypto.createHmac('sha256', String(hook.secret)).update(JSON.stringify(body)).digest('hex');
    }
    try {
      await axios.post(String(hook.target_url), body, { headers, timeout: 10000 });
    } catch (error) {
      syncLog('webhook', String(hook.id), null, 'failed', error instanceof Error ? error.message : 'Webhook delivery failed', { event });
    }
  }
}

function userPermissions(userId: string) {
  const user = db.prepare('SELECT role, permissions_json FROM users WHERE id = ?').get(userId) as DbRow | undefined;
  if (!user) return [];
  return resolvePermissions(String(user.role ?? 'viewer'), parseJson<string[]>(String(user.permissions_json ?? '[]'), []));
}

async function processQueueJob(queueId: string) {
  const job = db.prepare('SELECT * FROM publish_queue WHERE id = ?').get(queueId) as DbRow | undefined;
  if (!job) return;
  if (job.status === 'done') return;

  try {
    db.prepare('UPDATE publish_queue SET status = ?, updated_at = ? WHERE id = ?').run('processing', nowIso(), queueId);
    if (job.action === 'publish') {
      await publishArticle(String(job.article_id), job.site_id ? String(job.site_id) : null);
    }
    db.prepare('UPDATE publish_queue SET status = ?, updated_at = ?, last_error = ? WHERE id = ?').run('done', nowIso(), '', queueId);
  } catch (error) {
    const attempts = Number(job.attempts ?? 0) + 1;
    const maxAttempts = Number(parseJson<Record<string, any>>((db.prepare('SELECT value_json FROM settings WHERE key = ?').get('publishing') as DbRow | undefined)?.value_json ?? '', { retryAttempts: 3 }).retryAttempts ?? 3);
    db.prepare('UPDATE publish_queue SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(attempts >= maxAttempts ? 'failed' : 'pending', attempts, error instanceof Error ? error.message : 'unknown error', nowIso(), queueId);
    throw error;
  }
}

async function enqueueQueueRecord(queueId: string) {
  const row = db.prepare('SELECT * FROM publish_queue WHERE id = ?').get(queueId) as DbRow | undefined;
  if (!row) return;
  if (publishQueue) {
    const delay = row.scheduled_for ? Math.max(0, new Date(String(row.scheduled_for)).getTime() - Date.now()) : 0;
    await publishQueue.add('publish', { jobId: queueId }, { jobId: queueId, delay, removeOnComplete: 200, removeOnFail: 200 });
    return;
  }
  if (!row.scheduled_for || new Date(String(row.scheduled_for)).getTime() <= Date.now()) {
    await processQueueJob(queueId).catch(() => undefined);
  }
}

async function processPendingQueue() {
  const jobs = db.prepare(`SELECT * FROM publish_queue
    WHERE status = 'pending' AND (scheduled_for IS NULL OR scheduled_for <= ?)
    ORDER BY created_at ASC LIMIT 25`).all(nowIso()) as DbRow[];
  for (const job of jobs) {
    try {
      await processQueueJob(String(job.id));
    } catch {
      // handled in processQueueJob
    }
  }
}

function featuredImageInput(article: DbRow): { source: string; fileName?: string; mimeType?: string } | null {
  const featured = String(article.featured_image ?? '').trim();
  if (!featured) return null;
  const mediaRow = db.prepare('SELECT * FROM media WHERE id = ? OR public_url = ?').get(featured, featured) as DbRow | undefined;
  if (mediaRow?.local_path) {
    return { source: String(mediaRow.local_path), fileName: String(mediaRow.original_name ?? mediaRow.file_name), mimeType: String(mediaRow.mime_type ?? 'image/jpeg') };
  }
  if (featured.startsWith('/uploads/')) {
    return { source: path.join(env.uploadDir, path.basename(featured)) };
  }
  if (/^https?:\/\//.test(featured)) return { source: featured };
  return null;
}

async function publishArticle(articleId: string, siteId?: string | null) {
  const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId) as DbRow | undefined;
  if (!row) throw new Error('Article not found');
  const article = rowToArticle(row);
  const targetSiteIds = siteId
    ? [siteId]
    : article.targetSiteIds.length
      ? article.targetSiteIds
      : (db.prepare("SELECT id FROM sites WHERE status != ?").all('inactive') as { id: string }[]).map((item) => item.id);

  const results: PublishResult[] = [];

  for (const targetId of targetSiteIds) {
    const siteRow = db.prepare('SELECT * FROM sites WHERE id = ?').get(targetId) as DbRow | undefined;
    if (!siteRow) continue;
    const site = rowToSite(siteRow);
    if (site.type !== 'wordpress') {
      const result = { siteId: String(site.id), siteName: String(site.name), status: 'skipped' as const, message: 'Adapter not implemented for this site type yet' };
      results.push(result);
      syncLog('article', String(article.id), String(site.id), 'skipped', result.message);
      continue;
    }

    const username = String(siteRow.username ?? '');
    const appPassword = decryptSecret(String(siteRow.app_password ?? ''), env.encryptionKey);
    if (!username || !appPassword) {
      const result = { siteId: String(site.id), siteName: String(site.name), status: 'failed' as const, message: 'WordPress credentials missing' };
      results.push(result);
      syncLog('article', String(article.id), String(site.id), 'failed', result.message);
      continue;
    }

    try {
      const config = parseJson<Record<string, any>>(String(siteRow.config_json ?? '{}'), {});
      const wpResponse = await publishToWordPress(String(site.base_url), username, appPassword, {
        title: String(article.title),
        content: String(article.content),
        excerpt: String(article.summary ?? ''),
        slug: String(article.slug),
        seoTitle: String(article.seo_title ?? ''),
        seoDescription: String(article.seo_description ?? ''),
        categories: (article.categories as string[]) ?? config.defaultCategories ?? [],
        tags: (article.tags as string[]) ?? config.defaultTags ?? [],
        categoryIds: Array.isArray(config.defaultCategoryIds) ? config.defaultCategoryIds.map(Number) : [],
        tagIds: Array.isArray(config.defaultTagIds) ? config.defaultTagIds.map(Number) : [],
        featuredImage: featuredImageInput(article),
        status: article.schedule_at ? 'future' : 'publish',
        date: article.schedule_at ? String(article.schedule_at) : null,
      });
      const result = { siteId: String(site.id), siteName: String(site.name), status: 'success' as const, message: 'Published to WordPress', link: String(wpResponse.link ?? ''), wpResponseId: Number(wpResponse.id ?? 0) };
      results.push(result);
      syncLog('article', String(article.id), String(site.id), 'success', 'Published to WordPress', { wpResponseId: wpResponse.id, link: wpResponse.link });
      await emitWebhookEvent('article.published', { articleId: article.id, siteId: site.id, link: wpResponse.link });
    } catch (error) {
      const result = { siteId: String(site.id), siteName: String(site.name), status: 'failed' as const, message: error instanceof Error ? error.message : 'Publish failed' };
      results.push(result);
      syncLog('article', String(article.id), String(site.id), 'failed', result.message);
    }
  }

  db.prepare('UPDATE articles SET status = ?, published_at = ?, publish_results_json = ?, updated_at = ? WHERE id = ?')
    .run(article.schedule_at ? 'scheduled' : 'published', nowIso(), JSON.stringify(results), nowIso(), articleId);
}

async function bootstrapQueue() {
  if (publishQueue && redis && !publishWorker) {
    publishWorker = new Worker('newshub-publish', async (job) => {
      await processQueueJob(String(job.data.jobId));
    }, { connection: redis, concurrency: env.queueConcurrency });
  }

  cron.schedule('* * * * *', async () => {
    const pending = db.prepare(`SELECT id FROM publish_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50`).all() as Array<{ id: string }>;
    for (const item of pending) {
      try {
        await enqueueQueueRecord(item.id);
      } catch {
        // ignored intentionally, state remains visible in DB
      }
    }
    if (!publishQueue) await processPendingQueue();
  });
}

function buildTokenPayload(user: DbRow) {
  const permissions = resolvePermissions(String(user.role ?? 'viewer'), parseJson<string[]>(String(user.permissions_json ?? '[]'), []));
  return { id: String(user.id), email: String(user.email), role: String(user.role), permissions };
}

export async function buildApp() {
  initDatabase();
  await bootstrapQueue();

  const app = Fastify({ logger: true, trustProxy: true });
  const security = securitySettings();

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || !env.isProduction) return cb(null, true);
      cb(null, env.allowedOrigins.includes(origin));
    },
    credentials: false,
  });
  await app.register(helmet, { global: true, contentSecurityPolicy: false });
  await app.register(rateLimit, { max: Number(security.rateLimitPerMinute ?? 120), timeWindow: '1 minute' });
  await app.register(jwt, { secret: env.jwtSecret });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'NewsHub Pro API',
        version: '2.0.0',
        description: 'Central publishing and site-connection platform API',
      },
      servers: [{ url: env.appUrl }],
    },
  });
  await app.register(swaggerUI, { routePrefix: '/docs' });
  if (!env.s3Enabled) {
    await app.register(staticPlugin, { root: env.uploadDir, prefix: '/uploads/' });
  }

  app.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.user.id) as DbRow | undefined;
      if (!user || user.status !== 'active') {
        return reply.code(401).send({ message: 'Unauthorized' });
      }
      request.currentUser = user;
    } catch {
      return reply.code(401).send({ message: 'Unauthorized' });
    }
  });

  function authorize(permission: string) {
    return async (request: any, reply: any) => {
      const permissions = userPermissions(String(request.user.id));
      if (!hasPermission(permissions, permission)) {
        return reply.code(403).send({ message: 'Forbidden', permission });
      }
      request.permissions = permissions;
    };
  }

  app.setErrorHandler((error: any, _request, reply) => {
    app.log.error(error);
    reply.code(error?.statusCode ?? 500).send({ message: error?.message ?? 'Internal Server Error' });
  });

  app.get('/health', async () => ({ ok: true, service: 'newshub-pro-api', timestamp: nowIso(), redis: Boolean(env.redisUrl), objectStorage: env.s3Enabled ? 's3' : 'local' }));

  app.post('/api/v1/auth/login', async (request: any, reply: any) => {
    const { email, password, twoFactorCode } = request.body as { email?: string; password?: string; twoFactorCode?: string };
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as DbRow | undefined;
    if (!user || !password || !bcrypt.compareSync(password, String(user.password_hash))) {
      if (user) {
        const failedAttempts = Number(user.failed_logins ?? 0) + 1;
        const lockAfter = Number(security.lockAfterFailedAttempts ?? 5);
        const lockMinutes = Number(security.lockMinutes ?? 15);
        const lockedUntil = failedAttempts >= lockAfter ? new Date(Date.now() + lockMinutes * 60_000).toISOString() : null;
        db.prepare('UPDATE users SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = ?').run(failedAttempts, lockedUntil, nowIso(), user.id);
      }
      return reply.code(401).send({ message: 'Invalid credentials' });
    }
    if (user.locked_until && new Date(String(user.locked_until)).getTime() > Date.now()) {
      return reply.code(423).send({ message: 'Account locked temporarily', lockedUntil: user.locked_until });
    }
    if (user.status !== 'active') {
      return reply.code(403).send({ message: 'User is inactive' });
    }
    if (Boolean(user.two_factor_enabled) && !verifyTwoFactorToken(String(user.two_factor_secret ?? ''), twoFactorCode)) {
      return reply.code(401).send({ message: 'Two-factor code required or invalid', requiresTwoFactor: true });
    }
    const tokenPayload = buildTokenPayload(user);
    const accessToken = await reply.jwtSign(tokenPayload, { expiresIn: '8h' });
    const refreshToken = jsonwebtoken.sign(tokenPayload, env.jwtRefreshSecret, { expiresIn: '7d' });
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), user.id);
    audit(String(user.id), 'login', 'auth', String(user.id), { ip: request.ip });
    return { accessToken, refreshToken, user: rowToUser(user) };
  });

  app.post('/api/v1/auth/refresh', async (request: any, reply: any) => {
    const { token } = request.body as { token?: string };
    if (!token) return reply.code(400).send({ message: 'Refresh token required' });
    try {
      const decoded = jsonwebtoken.verify(token, env.jwtRefreshSecret) as { id: string; email: string; role: string; permissions?: string[] };
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id) as DbRow | undefined;
      if (!user || user.status !== 'active') return reply.code(401).send({ message: 'Invalid refresh token' });
      const accessToken = await reply.jwtSign(buildTokenPayload(user), { expiresIn: '8h' });
      return { accessToken };
    } catch {
      return reply.code(401).send({ message: 'Invalid refresh token' });
    }
  });

  app.get('/api/v1/auth/me', { preHandler: [(app as any).authenticate] }, async (request: any) => ({ user: rowToUser(request.currentUser) }));

  app.post('/api/v1/auth/change-password', { preHandler: [(app as any).authenticate] }, async (request: any, reply: any) => {
    const { currentPassword, newPassword } = request.body as { currentPassword?: string; newPassword?: string };
    const user = request.currentUser as DbRow;
    if (!currentPassword || !newPassword || newPassword.length < 10) return reply.code(400).send({ message: 'Password policy requires at least 10 characters' });
    if (!bcrypt.compareSync(currentPassword, String(user.password_hash))) return reply.code(400).send({ message: 'Current password is invalid' });
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), nowIso(), user.id);
    audit(String(user.id), 'change_password', 'user', String(user.id));
    return { success: true };
  });

  app.post('/api/v1/auth/2fa/setup', { preHandler: [(app as any).authenticate] }, async (request: any) => {
    const user = request.currentUser as DbRow;
    const setup = generateTwoFactorSecret(String(user.email));
    db.prepare('UPDATE users SET two_factor_secret = ?, updated_at = ? WHERE id = ?').run(setup.secret, nowIso(), user.id);
    audit(String(user.id), '2fa_setup', 'user', String(user.id));
    return { secret: setup.secret, otpauthUrl: setup.otpauthUrl };
  });

  app.post('/api/v1/auth/2fa/enable', { preHandler: [(app as any).authenticate] }, async (request: any, reply: any) => {
    const { token } = request.body as { token?: string };
    const user = request.currentUser as DbRow;
    if (!verifyTwoFactorToken(String(user.two_factor_secret ?? ''), token)) {
      return reply.code(400).send({ message: 'Invalid two-factor token' });
    }
    db.prepare('UPDATE users SET two_factor_enabled = 1, updated_at = ? WHERE id = ?').run(nowIso(), user.id);
    audit(String(user.id), '2fa_enable', 'user', String(user.id));
    return { success: true };
  });

  app.post('/api/v1/auth/2fa/disable', { preHandler: [(app as any).authenticate] }, async (request: any, reply: any) => {
    const { token } = request.body as { token?: string };
    const user = request.currentUser as DbRow;
    if (Boolean(user.two_factor_enabled) && !verifyTwoFactorToken(String(user.two_factor_secret ?? ''), token)) {
      return reply.code(400).send({ message: 'Invalid two-factor token' });
    }
    db.prepare('UPDATE users SET two_factor_enabled = 0, two_factor_secret = NULL, updated_at = ? WHERE id = ?').run(nowIso(), user.id);
    audit(String(user.id), '2fa_disable', 'user', String(user.id));
    return { success: true };
  });

  app.get('/api/v1/security/permissions', { preHandler: [(app as any).authenticate, authorize('security.read')] }, async () => ({ permissions: availablePermissions() }));

  app.get('/api/v1/dashboard/stats', { preHandler: [(app as any).authenticate, authorize('dashboard.read')] }, async () => {
    const [articles, published, sites, media, queuePending, failed, users] = [
      Number((db.prepare('SELECT COUNT(*) AS value FROM articles').get() as any).value),
      Number((db.prepare("SELECT COUNT(*) AS value FROM articles WHERE status IN ('published', 'scheduled')").get() as any).value),
      Number((db.prepare('SELECT COUNT(*) AS value FROM sites').get() as any).value),
      Number((db.prepare('SELECT COUNT(*) AS value FROM media').get() as any).value),
      Number((db.prepare("SELECT COUNT(*) AS value FROM publish_queue WHERE status = 'pending'").get() as any).value),
      Number((db.prepare("SELECT COUNT(*) AS value FROM publish_queue WHERE status = 'failed'").get() as any).value),
      Number((db.prepare("SELECT COUNT(*) AS value FROM users WHERE status = 'active'").get() as any).value),
    ];
    const chart = (db.prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS total
      FROM articles GROUP BY substr(created_at, 1, 10) ORDER BY day DESC LIMIT 7`).all() as any[]).reverse();
    return { stats: { articles, published, sites, media, queuePending, failed, users }, chart, infrastructure: { redis: Boolean(env.redisUrl), objectStorage: env.s3Enabled ? 's3' : 'local' } };
  });

  app.get('/api/v1/sites', { preHandler: [(app as any).authenticate, authorize('sites.read')] }, async () => {
    const rows = db.prepare('SELECT * FROM sites ORDER BY created_at DESC').all() as DbRow[];
    return { items: rows.map(rowToSite) };
  });

  app.post('/api/v1/sites', { preHandler: [(app as any).authenticate, authorize('sites.write')] }, async (request: any) => {
    const body = request.body as Record<string, any>;
    const id = `site_${nanoid()}`;
    const ts = nowIso();
    db.prepare(`INSERT INTO sites (id, name, type, base_url, api_key, secret_key, username, app_password, cms, notes, status, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        body.name,
        body.type ?? 'wordpress',
        body.baseUrl,
        body.apiKey ? encryptSecret(String(body.apiKey), env.encryptionKey) : '',
        body.secretKey ? encryptSecret(String(body.secretKey), env.encryptionKey) : '',
        body.username ?? '',
        body.appPassword ? encryptSecret(String(body.appPassword), env.encryptionKey) : '',
        body.cms ?? 'wordpress',
        body.notes ?? '',
        body.status ?? 'active',
        JSON.stringify(body.config ?? {}),
        ts,
        ts,
      );
    audit(request.user.id, 'create', 'site', id, { name: body.name, baseUrl: body.baseUrl });
    return { item: rowToSite(db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as DbRow) };
  });

  app.put('/api/v1/sites/:id', { preHandler: [(app as any).authenticate, authorize('sites.write')] }, async (request: any) => {
    const body = request.body as Record<string, any>;
    const id = request.params.id as string;
    const current = db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as DbRow | undefined;
    db.prepare(`UPDATE sites SET name = ?, type = ?, base_url = ?, api_key = ?, secret_key = ?, username = ?, app_password = ?, cms = ?, notes = ?, status = ?, config_json = ?, updated_at = ? WHERE id = ?`)
      .run(
        body.name,
        body.type ?? 'wordpress',
        body.baseUrl,
        body.apiKey ? encryptSecret(String(body.apiKey), env.encryptionKey) : (current?.api_key ?? ''),
        body.secretKey ? encryptSecret(String(body.secretKey), env.encryptionKey) : (current?.secret_key ?? ''),
        body.username ?? '',
        body.appPassword ? encryptSecret(String(body.appPassword), env.encryptionKey) : (current?.app_password ?? ''),
        body.cms ?? 'wordpress',
        body.notes ?? '',
        body.status ?? 'active',
        JSON.stringify(body.config ?? {}),
        nowIso(),
        id,
      );
    audit(request.user.id, 'update', 'site', id, { name: body.name, baseUrl: body.baseUrl });
    return { item: rowToSite(db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as DbRow) };
  });

  app.delete('/api/v1/sites/:id', { preHandler: [(app as any).authenticate, authorize('sites.write')] }, async (request: any) => {
    const id = request.params.id as string;
    db.prepare('DELETE FROM sites WHERE id = ?').run(id);
    audit(request.user.id, 'delete', 'site', id);
    return { success: true };
  });

  app.post('/api/v1/sites/:id/test', { preHandler: [(app as any).authenticate, authorize('sites.test')] }, async (request: any, reply: any) => {
    const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(request.params.id) as DbRow | undefined;
    if (!row) return reply.code(404).send({ message: 'Site not found' });
    try {
      const data = await testWordPressConnection(String(row.base_url), row.username ? String(row.username) : undefined, row.app_password ? decryptSecret(String(row.app_password), env.encryptionKey) : undefined);
      db.prepare('UPDATE sites SET status = ?, updated_at = ? WHERE id = ?').run('connected', nowIso(), row.id);
      syncLog('site', String(row.id), String(row.id), 'success', 'Connection test succeeded');
      await emitWebhookEvent('site.connected', { siteId: row.id, siteName: row.name, baseUrl: row.base_url });
      return { success: true, data };
    } catch (error) {
      db.prepare('UPDATE sites SET status = ?, updated_at = ? WHERE id = ?').run('failed', nowIso(), row.id);
      syncLog('site', String(row.id), String(row.id), 'failed', error instanceof Error ? error.message : 'Unknown error');
      return reply.code(400).send({ success: false, message: error instanceof Error ? error.message : 'Connection failed' });
    }
  });

  app.post('/api/v1/sites/:id/sync-taxonomies', { preHandler: [(app as any).authenticate, authorize('sites.sync')] }, async (request: any, reply: any) => {
    const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(request.params.id) as DbRow | undefined;
    if (!row) return reply.code(404).send({ message: 'Site not found' });
    const { categories = [], tags = [] } = request.body as { categories?: string[]; tags?: string[] };
    try {
      const result = await syncWordPressTaxonomies(String(row.base_url), String(row.username ?? ''), decryptSecret(String(row.app_password ?? ''), env.encryptionKey), categories, tags);
      syncLog('site', String(row.id), String(row.id), 'success', 'Taxonomies synchronized', result);
      return { success: true, ...result };
    } catch (error) {
      syncLog('site', String(row.id), String(row.id), 'failed', error instanceof Error ? error.message : 'Taxonomy synchronization failed');
      return reply.code(400).send({ success: false, message: error instanceof Error ? error.message : 'Taxonomy synchronization failed' });
    }
  });

  app.get('/api/v1/articles', { preHandler: [(app as any).authenticate, authorize('articles.read')] }, async () => {
    const rows = db.prepare('SELECT * FROM articles ORDER BY created_at DESC').all() as DbRow[];
    return { items: rows.map(rowToArticle) };
  });

  app.post('/api/v1/articles', { preHandler: [(app as any).authenticate, authorize('articles.write')] }, async (request: any) => {
    const body = request.body as Record<string, any>;
    const id = `art_${nanoid()}`;
    const ts = nowIso();
    const slug = body.slug?.trim() ? body.slug : articleSlug(String(body.title ?? ''), id);
    db.prepare(`INSERT INTO articles (id, title, slug, summary, content, author, seo_title, seo_description, categories_json, tags_json, featured_image, gallery_json, video_url, status, schedule_at, published_at, publish_results_json, target_site_ids_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      body.title,
      slug,
      body.summary ?? '',
      body.content ?? '',
      body.author ?? '',
      body.seoTitle ?? '',
      body.seoDescription ?? '',
      JSON.stringify(body.categories ?? []),
      JSON.stringify(body.tags ?? []),
      body.featuredImage ?? '',
      JSON.stringify(body.gallery ?? []),
      body.videoUrl ?? '',
      body.status ?? (body.scheduleAt ? 'scheduled' : 'draft'),
      body.scheduleAt ?? null,
      null,
      '[]',
      JSON.stringify(body.targetSiteIds ?? []),
      request.user.id,
      ts,
      ts,
    );
    audit(request.user.id, 'create', 'article', id, { title: body.title });
    const item = rowToArticle(db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as DbRow);
    if (body.scheduleAt) {
      const jobId = `job_${nanoid()}`;
      db.prepare(`INSERT INTO publish_queue (id, article_id, site_id, action, status, scheduled_for, attempts, last_error, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, 'publish', 'pending', ?, 0, '', '{}', ?, ?)`).run(jobId, id, null, body.scheduleAt, nowIso(), nowIso());
      await enqueueQueueRecord(jobId);
    }
    return { item };
  });

  app.put('/api/v1/articles/:id', { preHandler: [(app as any).authenticate, authorize('articles.write')] }, async (request: any) => {
    const body = request.body as Record<string, any>;
    const id = request.params.id as string;
    const slug = body.slug?.trim() ? body.slug : articleSlug(String(body.title ?? ''), id);
    db.prepare(`UPDATE articles SET title = ?, slug = ?, summary = ?, content = ?, author = ?, seo_title = ?, seo_description = ?, categories_json = ?, tags_json = ?, featured_image = ?, gallery_json = ?, video_url = ?, status = ?, schedule_at = ?, target_site_ids_json = ?, updated_at = ? WHERE id = ?`).run(
      body.title,
      slug,
      body.summary ?? '',
      body.content ?? '',
      body.author ?? '',
      body.seoTitle ?? '',
      body.seoDescription ?? '',
      JSON.stringify(body.categories ?? []),
      JSON.stringify(body.tags ?? []),
      body.featuredImage ?? '',
      JSON.stringify(body.gallery ?? []),
      body.videoUrl ?? '',
      body.status ?? (body.scheduleAt ? 'scheduled' : 'draft'),
      body.scheduleAt ?? null,
      JSON.stringify(body.targetSiteIds ?? []),
      nowIso(),
      id,
    );
    audit(request.user.id, 'update', 'article', id, { title: body.title });
    return { item: rowToArticle(db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as DbRow) };
  });

  app.delete('/api/v1/articles/:id', { preHandler: [(app as any).authenticate, authorize('articles.write')] }, async (request: any) => {
    const id = request.params.id as string;
    db.prepare('DELETE FROM articles WHERE id = ?').run(id);
    db.prepare('DELETE FROM publish_queue WHERE article_id = ?').run(id);
    audit(request.user.id, 'delete', 'article', id);
    return { success: true };
  });

  app.post('/api/v1/articles/:id/publish', { preHandler: [(app as any).authenticate, authorize('articles.publish')] }, async (request: any) => {
    const id = request.params.id as string;
    const { siteId } = request.body as { siteId?: string };
    const jobId = `job_${nanoid()}`;
    db.prepare(`INSERT INTO publish_queue (id, article_id, site_id, action, status, scheduled_for, attempts, last_error, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, 'publish', 'pending', ?, 0, '', '{}', ?, ?)`).run(jobId, id, siteId ?? null, nowIso(), nowIso(), nowIso());
    await enqueueQueueRecord(jobId);
    audit(request.user.id, 'publish', 'article', id, { siteId: siteId ?? null });
    return { success: true, queueJobId: jobId };
  });

  app.post('/api/v1/articles/:id/schedule', { preHandler: [(app as any).authenticate, authorize('articles.publish')] }, async (request: any) => {
    const id = request.params.id as string;
    const { scheduleAt, siteId } = request.body as { scheduleAt?: string; siteId?: string };
    const when = scheduleAt ?? new Date(Date.now() + 60_000).toISOString();
    const jobId = `job_${nanoid()}`;
    db.prepare(`UPDATE articles SET status = 'scheduled', schedule_at = ?, updated_at = ? WHERE id = ?`).run(when, nowIso(), id);
    db.prepare(`INSERT INTO publish_queue (id, article_id, site_id, action, status, scheduled_for, attempts, last_error, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, 'publish', 'pending', ?, 0, '', '{}', ?, ?)`).run(jobId, id, siteId ?? null, when, nowIso(), nowIso());
    await enqueueQueueRecord(jobId);
    audit(request.user.id, 'schedule', 'article', id, { scheduleAt: when, siteId: siteId ?? null });
    return { success: true, queueJobId: jobId, scheduleAt: when };
  });

  app.get('/api/v1/queue', { preHandler: [(app as any).authenticate, authorize('queue.read')] }, async () => {
    const items = db.prepare('SELECT * FROM publish_queue ORDER BY created_at DESC').all();
    return { items };
  });

  app.post('/api/v1/queue/process', { preHandler: [(app as any).authenticate, authorize('queue.process')] }, async () => {
    await processPendingQueue();
    return { success: true };
  });

  app.get('/api/v1/media', { preHandler: [(app as any).authenticate, authorize('media.read')] }, async () => {
    const items = db.prepare('SELECT * FROM media ORDER BY created_at DESC').all();
    return { items };
  });

  app.post('/api/v1/media/upload', { preHandler: [(app as any).authenticate, authorize('media.write')] }, async (request: any, reply: any) => {
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: 'No file uploaded' });
    const fileId = `med_${nanoid()}`;
    const safeName = `${fileId}${path.extname(part.filename)}`;
    const buffer = await part.toBuffer();
    const stored = await storeBuffer(safeName, part.mimetype, buffer);
    const stats = stored.localPath ? await fs.promises.stat(stored.localPath) : { size: buffer.length };
    db.prepare(`INSERT INTO media (id, file_name, original_name, mime_type, size, local_path, storage_provider, storage_key, public_url, alt_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      fileId,
      safeName,
      part.filename,
      part.mimetype,
      stats.size,
      stored.localPath,
      stored.provider,
      stored.key,
      stored.url,
      '',
      nowIso(),
    );
    audit(request.user.id, 'upload', 'media', fileId, { fileName: part.filename });
    return { item: db.prepare('SELECT * FROM media WHERE id = ?').get(fileId) };
  });

  app.get('/api/v1/logs', { preHandler: [(app as any).authenticate, authorize('logs.read')] }, async () => {
    const syncLogs = db.prepare('SELECT * FROM sync_logs ORDER BY created_at DESC LIMIT 200').all();
    const auditLogs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200').all();
    return { syncLogs, auditLogs };
  });

  app.get('/api/v1/settings', { preHandler: [(app as any).authenticate, authorize('settings.read')] }, async () => {
    const rows = db.prepare('SELECT * FROM settings ORDER BY key ASC').all() as DbRow[];
    return { items: rows.map((row) => ({ key: row.key, value: parseJson(String(row.value_json), {}) })) };
  });

  app.put('/api/v1/settings/:key', { preHandler: [(app as any).authenticate, authorize('settings.write')] }, async (request: any) => {
    const key = request.params.key as string;
    db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(request.body ?? {}), nowIso());
    audit(request.user.id, 'update', 'setting', key, request.body);
    return { success: true };
  });

  app.get('/api/v1/webhooks', { preHandler: [(app as any).authenticate, authorize('webhooks.read')] }, async () => {
    const rows = db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as DbRow[];
    return { items: rows.map(rowToWebhook) };
  });

  app.post('/api/v1/webhooks', { preHandler: [(app as any).authenticate, authorize('webhooks.write')] }, async (request: any) => {
    const body = request.body as Record<string, any>;
    const id = `wh_${nanoid()}`;
    const ts = nowIso();
    db.prepare(`INSERT INTO webhooks (id, name, target_url, secret, events_json, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, body.name, body.targetUrl, body.secret ?? '', JSON.stringify(body.events ?? []), body.isActive === false ? 0 : 1, ts, ts);
    audit(request.user.id, 'create', 'webhook', id, body);
    return { item: rowToWebhook(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as DbRow) };
  });

  app.delete('/api/v1/webhooks/:id', { preHandler: [(app as any).authenticate, authorize('webhooks.write')] }, async (request: any) => {
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(request.params.id);
    audit(request.user.id, 'delete', 'webhook', request.params.id);
    return { success: true };
  });

  app.get('/api/v1/users', { preHandler: [(app as any).authenticate, authorize('users.read')] }, async () => {
    const items = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as DbRow[];
    return { items: items.map(rowToUser) };
  });

  app.post('/api/v1/users', { preHandler: [(app as any).authenticate, authorize('users.write')] }, async (request: any) => {
    const body = request.body as Record<string, any>;
    const id = `usr_${nanoid()}`;
    const ts = nowIso();
    db.prepare(`INSERT INTO users (id, name, email, password_hash, role, status, permissions_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      body.name,
      body.email,
      bcrypt.hashSync(body.password ?? 'ChangeMe123!', 10),
      body.role ?? 'editor',
      body.status ?? 'active',
      JSON.stringify(body.permissions ?? []),
      ts,
      ts,
    );
    audit(request.user.id, 'create', 'user', id, { email: body.email, role: body.role ?? 'editor' });
    return { item: rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as DbRow) };
  });

  app.put('/api/v1/users/:id', { preHandler: [(app as any).authenticate, authorize('users.write')] }, async (request: any) => {
    const id = request.params.id as string;
    const body = request.body as Record<string, any>;
    const current = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as DbRow | undefined;
    db.prepare(`UPDATE users SET name = ?, email = ?, password_hash = ?, role = ?, status = ?, permissions_json = ?, updated_at = ? WHERE id = ?`).run(
      body.name ?? current?.name,
      body.email ?? current?.email,
      body.password ? bcrypt.hashSync(body.password, 10) : current?.password_hash,
      body.role ?? current?.role ?? 'editor',
      body.status ?? current?.status ?? 'active',
      JSON.stringify(body.permissions ?? parseJson<string[]>(String(current?.permissions_json ?? '[]'), [])),
      nowIso(),
      id,
    );
    audit(request.user.id, 'update', 'user', id, { email: body.email ?? current?.email, role: body.role ?? current?.role });
    return { item: rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as DbRow) };
  });

  return app;
}
