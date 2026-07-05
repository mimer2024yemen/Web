import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import bcrypt from 'bcryptjs';
import slugify from 'slugify';
import { customAlphabet } from 'nanoid';
import cron from 'node-cron';
import jsonwebtoken from 'jsonwebtoken';
import { env } from './env.js';
import { db, initDatabase, nowIso, parseJson } from './db.js';
import { publishToWordPress, testWordPressConnection } from './services/wordpress.js';

const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyz', 12);

type DbRow = Record<string, unknown>;

function rowToArticle(row: DbRow): any {
  return {
    ...row,
    categories: parseJson<string[]>(String(row.categories_json ?? '[]'), []),
    tags: parseJson<string[]>(String(row.tags_json ?? '[]'), []),
    gallery: parseJson<string[]>(String(row.gallery_json ?? '[]'), []),
    targetSiteIds: parseJson<string[]>(String(row.target_site_ids_json ?? '[]'), []),
  };
}

function rowToSite(row: DbRow): any {
  return {
    ...row,
    config: parseJson<Record<string, unknown>>(String(row.config_json ?? '{}'), {}),
  };
}

function rowToWebhook(row: DbRow): any {
  return {
    ...row,
    events: parseJson<string[]>(String(row.events_json ?? '[]'), []),
  };
}

function audit(userId: string | null, action: string, entityType: string, entityId: string | null, metadata: unknown = {}) {
  db.prepare(`INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`aud_${nanoid()}`, userId, action, entityType, entityId, JSON.stringify(metadata), nowIso());
}

function syncLog(entityType: string, entityId: string, siteId: string | null, status: string, message: string, metadata: unknown = {}) {
  db.prepare(`INSERT INTO sync_logs (id, entity_type, entity_id, site_id, status, message, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`log_${nanoid()}`, entityType, entityId, siteId, status, message, JSON.stringify(metadata), nowIso());
}

function articleSlug(title: string, fallbackId?: string) {
  const base = slugify(title, { lower: true, strict: true, trim: true, locale: 'ar' });
  return base || `article-${fallbackId ?? nanoid()}`;
}

async function processPendingQueue() {
  const jobs = db.prepare(`SELECT * FROM publish_queue
    WHERE status = 'pending' AND (scheduled_for IS NULL OR scheduled_for <= ?)
    ORDER BY created_at ASC LIMIT 10`).all(nowIso()) as DbRow[];
  for (const job of jobs) {
    try {
      db.prepare('UPDATE publish_queue SET status = ?, updated_at = ? WHERE id = ?').run('processing', nowIso(), job.id);
      if (job.action === 'publish') {
        await publishArticle(String(job.article_id), job.site_id ? String(job.site_id) : null);
      }
      db.prepare('UPDATE publish_queue SET status = ?, updated_at = ? WHERE id = ?').run('done', nowIso(), job.id);
    } catch (error) {
      const attempts = Number(job.attempts ?? 0) + 1;
      db.prepare('UPDATE publish_queue SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(attempts >= 3 ? 'failed' : 'pending', attempts, error instanceof Error ? error.message : 'unknown error', nowIso(), job.id);
    }
  }
}

async function publishArticle(articleId: string, siteId?: string | null) {
  const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId) as DbRow | undefined;
  if (!row) throw new Error('Article not found');
  const article = rowToArticle(row);
  const targetSiteIds = siteId ? [siteId] : article.targetSiteIds.length ? article.targetSiteIds : (db.prepare('SELECT id FROM sites WHERE status != ?').all('inactive') as { id: string }[]).map((item) => item.id);

  for (const targetId of targetSiteIds) {
    const siteRow = db.prepare('SELECT * FROM sites WHERE id = ?').get(targetId) as DbRow | undefined;
    if (!siteRow) continue;
    const site = rowToSite(siteRow);
    if (site.type !== 'wordpress') {
      syncLog('article', String(article.id), String(site.id), 'skipped', 'Adapter not implemented for this site type yet');
      continue;
    }
    if (!site.username || !site.app_password) {
      syncLog('article', String(article.id), String(site.id), 'failed', 'WordPress credentials missing');
      continue;
    }
    const categoryIds = (site.config?.defaultCategoryIds as number[] | undefined) ?? [];
    const tagIds = (site.config?.defaultTagIds as number[] | undefined) ?? [];
    const wpResponse = await publishToWordPress(String(site.base_url), String(site.username), String(site.app_password), {
      title: String(article.title),
      content: String(article.content),
      excerpt: String(article.summary ?? ''),
      slug: String(article.slug),
      seoTitle: String(article.seo_title ?? ''),
      seoDescription: String(article.seo_description ?? ''),
      categories: categoryIds,
      tags: tagIds,
      status: article.schedule_at ? 'future' : 'publish',
      date: article.schedule_at ? String(article.schedule_at) : null,
    });
    syncLog('article', String(article.id), String(site.id), 'success', 'Published to WordPress', { wpResponseId: wpResponse.id, link: wpResponse.link });
  }

  db.prepare('UPDATE articles SET status = ?, published_at = ?, updated_at = ? WHERE id = ?')
    .run(article.schedule_at ? 'scheduled' : 'published', nowIso(), nowIso(), articleId);
}

export async function buildApp() {
  initDatabase();

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  await app.register(jwt, { secret: env.jwtSecret });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'NewsHub Pro API',
        version: '1.0.0',
        description: 'Central publishing and site-connection platform API',
      },
      servers: [{ url: `http://localhost:${env.port}` }],
      tags: [
        { name: 'auth' },
        { name: 'sites' },
        { name: 'articles' },
        { name: 'media' },
        { name: 'logs' },
        { name: 'settings' },
      ],
    },
  });
  await app.register(swaggerUI, { routePrefix: '/docs' });
  await app.register(staticPlugin, { root: env.uploadDir, prefix: '/uploads/' });

  app.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ message: 'Unauthorized' });
    }
  });

  app.get('/health', async () => ({ ok: true, service: 'newshub-pro-api', timestamp: nowIso() }));

  app.post('/api/v1/auth/login', { schema: { tags: ['auth'] } }, async (request: any, reply) => {
    const { email, password } = request.body as { email?: string; password?: string };
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as DbRow | undefined;
    if (!user || !password || !bcrypt.compareSync(password, String(user.password_hash))) {
      return reply.code(401).send({ message: 'Invalid credentials' });
    }
    const tokenPayload = { id: String(user.id), email: String(user.email), role: String(user.role) };
    const accessToken = await reply.jwtSign(tokenPayload, { expiresIn: '8h' });
    const refreshToken = jsonwebtoken.sign(tokenPayload, env.jwtRefreshSecret, { expiresIn: '7d' });
    audit(String(user.id), 'login', 'auth', String(user.id), { ip: request.ip });
    return { accessToken, refreshToken, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  });

  app.post('/api/v1/auth/refresh', { schema: { tags: ['auth'] } }, async (request: any, reply) => {
    const { token } = request.body as { token?: string };
    if (!token) return reply.code(400).send({ message: 'Refresh token required' });
    try {
      const decoded = jsonwebtoken.verify(token, env.jwtRefreshSecret) as { id: string; email: string; role: string };
      const accessToken = await reply.jwtSign({ id: decoded.id, email: decoded.email, role: decoded.role }, { expiresIn: '8h' });
      return { accessToken };
    } catch {
      return reply.code(401).send({ message: 'Invalid refresh token' });
    }
  });

  app.get('/api/v1/auth/me', { preHandler: [(app as any).authenticate], schema: { tags: ['auth'] } }, async (request: any) => {
    const user = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(request.user.id);
    return { user };
  });

  app.get('/api/v1/dashboard/stats', { preHandler: [(app as any).authenticate] }, async () => {
    const [articles, published, sites, media, queuePending, failed] = [
      Number((db.prepare('SELECT COUNT(*) AS value FROM articles').get() as any).value),
      Number((db.prepare("SELECT COUNT(*) AS value FROM articles WHERE status IN ('published', 'scheduled')").get() as any).value),
      Number((db.prepare('SELECT COUNT(*) AS value FROM sites').get() as any).value),
      Number((db.prepare('SELECT COUNT(*) AS value FROM media').get() as any).value),
      Number((db.prepare("SELECT COUNT(*) AS value FROM publish_queue WHERE status = 'pending'").get() as any).value),
      Number((db.prepare("SELECT COUNT(*) AS value FROM publish_queue WHERE status = 'failed'").get() as any).value),
    ];
    const chart = (db.prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS total
      FROM articles GROUP BY substr(created_at, 1, 10) ORDER BY day DESC LIMIT 7`).all() as any[]).reverse();
    return { stats: { articles, published, sites, media, queuePending, failed }, chart };
  });

  app.get('/api/v1/sites', { preHandler: [(app as any).authenticate], schema: { tags: ['sites'] } }, async () => {
    const rows = db.prepare('SELECT * FROM sites ORDER BY created_at DESC').all() as DbRow[];
    return { items: rows.map(rowToSite) };
  });

  app.post('/api/v1/sites', { preHandler: [(app as any).authenticate], schema: { tags: ['sites'] } }, async (request: any) => {
    const body = request.body as Record<string, any>;
    const id = `site_${nanoid()}`;
    const ts = nowIso();
    db.prepare(`INSERT INTO sites (id, name, type, base_url, api_key, secret_key, username, app_password, cms, notes, status, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, body.name, body.type ?? 'wordpress', body.baseUrl, body.apiKey ?? '', body.secretKey ?? '', body.username ?? '', body.appPassword ?? '', body.cms ?? 'wordpress', body.notes ?? '', body.status ?? 'active', JSON.stringify(body.config ?? {}), ts, ts);
    audit(request.user.id, 'create', 'site', id, body);
    return { item: rowToSite(db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as DbRow) };
  });

  app.put('/api/v1/sites/:id', { preHandler: [(app as any).authenticate], schema: { tags: ['sites'] } }, async (request: any) => {
    const body = request.body as Record<string, any>;
    const id = request.params.id as string;
    db.prepare(`UPDATE sites SET name = ?, type = ?, base_url = ?, api_key = ?, secret_key = ?, username = ?, app_password = ?, cms = ?, notes = ?, status = ?, config_json = ?, updated_at = ? WHERE id = ?`)
      .run(body.name, body.type ?? 'wordpress', body.baseUrl, body.apiKey ?? '', body.secretKey ?? '', body.username ?? '', body.appPassword ?? '', body.cms ?? 'wordpress', body.notes ?? '', body.status ?? 'active', JSON.stringify(body.config ?? {}), nowIso(), id);
    audit(request.user.id, 'update', 'site', id, body);
    return { item: rowToSite(db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as DbRow) };
  });

  app.delete('/api/v1/sites/:id', { preHandler: [(app as any).authenticate], schema: { tags: ['sites'] } }, async (request: any) => {
    const id = request.params.id as string;
    db.prepare('DELETE FROM sites WHERE id = ?').run(id);
    audit(request.user.id, 'delete', 'site', id);
    return { success: true };
  });

  app.post('/api/v1/sites/:id/test', { preHandler: [(app as any).authenticate], schema: { tags: ['sites'] } }, async (request: any, reply) => {
    const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(request.params.id) as DbRow | undefined;
    if (!row) return reply.code(404).send({ message: 'Site not found' });
    const site = rowToSite(row);
    try {
      const data = await testWordPressConnection(String(site.base_url), site.username ? String(site.username) : undefined, site.app_password ? String(site.app_password) : undefined);
      db.prepare('UPDATE sites SET status = ?, updated_at = ? WHERE id = ?').run('connected', nowIso(), site.id);
      syncLog('site', String(site.id), String(site.id), 'success', 'Connection test succeeded');
      return { success: true, data };
    } catch (error) {
      db.prepare('UPDATE sites SET status = ?, updated_at = ? WHERE id = ?').run('failed', nowIso(), site.id);
      syncLog('site', String(site.id), String(site.id), 'failed', error instanceof Error ? error.message : 'Unknown error');
      return reply.code(400).send({ success: false, message: error instanceof Error ? error.message : 'Connection failed' });
    }
  });

  app.get('/api/v1/articles', { preHandler: [(app as any).authenticate], schema: { tags: ['articles'] } }, async () => {
    const rows = db.prepare('SELECT * FROM articles ORDER BY created_at DESC').all() as DbRow[];
    return { items: rows.map(rowToArticle) };
  });

  app.post('/api/v1/articles', { preHandler: [(app as any).authenticate], schema: { tags: ['articles'] } }, async (request: any) => {
    const body = request.body as Record<string, any>;
    const id = `art_${nanoid()}`;
    const ts = nowIso();
    const slug = body.slug?.trim() ? body.slug : articleSlug(String(body.title ?? ''), id);
    db.prepare(`INSERT INTO articles (id, title, slug, summary, content, author, seo_title, seo_description, categories_json, tags_json, featured_image, gallery_json, video_url, status, schedule_at, published_at, target_site_ids_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, body.title, slug, body.summary ?? '', body.content ?? '', body.author ?? '', body.seoTitle ?? '', body.seoDescription ?? '', JSON.stringify(body.categories ?? []), JSON.stringify(body.tags ?? []), body.featuredImage ?? '', JSON.stringify(body.gallery ?? []), body.videoUrl ?? '', body.status ?? 'draft', body.scheduleAt ?? null, null, JSON.stringify(body.targetSiteIds ?? []), request.user.id, ts, ts);
    audit(request.user.id, 'create', 'article', id, { title: body.title });
    return { item: rowToArticle(db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as DbRow) };
  });

  app.put('/api/v1/articles/:id', { preHandler: [(app as any).authenticate], schema: { tags: ['articles'] } }, async (request: any) => {
    const body = request.body as Record<string, any>;
    const id = request.params.id as string;
    const slug = body.slug?.trim() ? body.slug : articleSlug(String(body.title ?? ''), id);
    db.prepare(`UPDATE articles SET title = ?, slug = ?, summary = ?, content = ?, author = ?, seo_title = ?, seo_description = ?, categories_json = ?, tags_json = ?, featured_image = ?, gallery_json = ?, video_url = ?, status = ?, schedule_at = ?, target_site_ids_json = ?, updated_at = ? WHERE id = ?`)
      .run(body.title, slug, body.summary ?? '', body.content ?? '', body.author ?? '', body.seoTitle ?? '', body.seoDescription ?? '', JSON.stringify(body.categories ?? []), JSON.stringify(body.tags ?? []), body.featuredImage ?? '', JSON.stringify(body.gallery ?? []), body.videoUrl ?? '', body.status ?? 'draft', body.scheduleAt ?? null, JSON.stringify(body.targetSiteIds ?? []), nowIso(), id);
    audit(request.user.id, 'update', 'article', id, { title: body.title });
    return { item: rowToArticle(db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as DbRow) };
  });

  app.delete('/api/v1/articles/:id', { preHandler: [(app as any).authenticate], schema: { tags: ['articles'] } }, async (request: any) => {
    const id = request.params.id as string;
    db.prepare('DELETE FROM articles WHERE id = ?').run(id);
    audit(request.user.id, 'delete', 'article', id);
    return { success: true };
  });

  app.post('/api/v1/articles/:id/publish', { preHandler: [(app as any).authenticate], schema: { tags: ['articles'] } }, async (request: any) => {
    const id = request.params.id as string;
    const { siteId } = request.body as { siteId?: string };
    const jobId = `job_${nanoid()}`;
    db.prepare(`INSERT INTO publish_queue (id, article_id, site_id, action, status, scheduled_for, attempts, last_error, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, 'publish', 'pending', ?, 0, '', '{}', ?, ?)`)
      .run(jobId, id, siteId ?? null, nowIso(), nowIso(), nowIso());
    await processPendingQueue();
    audit(request.user.id, 'publish', 'article', id, { siteId: siteId ?? null });
    return { success: true, queueJobId: jobId };
  });

  app.post('/api/v1/articles/:id/schedule', { preHandler: [(app as any).authenticate], schema: { tags: ['articles'] } }, async (request: any) => {
    const id = request.params.id as string;
    const { scheduleAt, siteId } = request.body as { scheduleAt?: string; siteId?: string };
    const when = scheduleAt ?? new Date(Date.now() + 60_000).toISOString();
    const jobId = `job_${nanoid()}`;
    db.prepare(`UPDATE articles SET status = 'scheduled', schedule_at = ?, updated_at = ? WHERE id = ?`).run(when, nowIso(), id);
    db.prepare(`INSERT INTO publish_queue (id, article_id, site_id, action, status, scheduled_for, attempts, last_error, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, 'publish', 'pending', ?, 0, '', '{}', ?, ?)`)
      .run(jobId, id, siteId ?? null, when, nowIso(), nowIso());
    audit(request.user.id, 'schedule', 'article', id, { scheduleAt: when });
    return { success: true, queueJobId: jobId, scheduleAt: when };
  });

  app.get('/api/v1/queue', { preHandler: [(app as any).authenticate] }, async () => {
    const items = db.prepare('SELECT * FROM publish_queue ORDER BY created_at DESC').all();
    return { items };
  });

  app.post('/api/v1/queue/process', { preHandler: [(app as any).authenticate] }, async () => {
    await processPendingQueue();
    return { success: true };
  });

  app.get('/api/v1/media', { preHandler: [(app as any).authenticate], schema: { tags: ['media'] } }, async () => {
    const items = db.prepare('SELECT * FROM media ORDER BY created_at DESC').all();
    return { items };
  });

  app.post('/api/v1/media/upload', { preHandler: [(app as any).authenticate], schema: { tags: ['media'] } }, async (request: any, reply) => {
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: 'No file uploaded' });
    const fileId = `med_${nanoid()}`;
    const safeName = `${fileId}${path.extname(part.filename)}`;
    const filePath = path.join(env.uploadDir, safeName);
    await fs.promises.writeFile(filePath, await part.toBuffer());
    const stats = await fs.promises.stat(filePath);
    const publicUrl = `/uploads/${safeName}`;
    db.prepare(`INSERT INTO media (id, file_name, original_name, mime_type, size, local_path, public_url, alt_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(fileId, safeName, part.filename, part.mimetype, stats.size, filePath, publicUrl, '', nowIso());
    audit(request.user.id, 'upload', 'media', fileId, { fileName: part.filename });
    return { item: db.prepare('SELECT * FROM media WHERE id = ?').get(fileId) };
  });

  app.get('/api/v1/logs', { preHandler: [(app as any).authenticate], schema: { tags: ['logs'] } }, async () => {
    const syncLogs = db.prepare('SELECT * FROM sync_logs ORDER BY created_at DESC LIMIT 100').all();
    const auditLogs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100').all();
    return { syncLogs, auditLogs };
  });

  app.get('/api/v1/settings', { preHandler: [(app as any).authenticate], schema: { tags: ['settings'] } }, async () => {
    const rows = db.prepare('SELECT * FROM settings ORDER BY key ASC').all() as DbRow[];
    return { items: rows.map((row) => ({ key: row.key, value: parseJson(String(row.value_json), {}) })) };
  });

  app.put('/api/v1/settings/:key', { preHandler: [(app as any).authenticate], schema: { tags: ['settings'] } }, async (request: any) => {
    const key = request.params.key as string;
    db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(request.body ?? {}), nowIso());
    audit(request.user.id, 'update', 'setting', key, request.body);
    return { success: true };
  });

  app.get('/api/v1/webhooks', { preHandler: [(app as any).authenticate] }, async () => {
    const rows = db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as DbRow[];
    return { items: rows.map(rowToWebhook) };
  });

  app.post('/api/v1/webhooks', { preHandler: [(app as any).authenticate] }, async (request: any) => {
    const body = request.body as Record<string, any>;
    const id = `wh_${nanoid()}`;
    const ts = nowIso();
    db.prepare(`INSERT INTO webhooks (id, name, target_url, secret, events_json, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, body.name, body.targetUrl, body.secret ?? '', JSON.stringify(body.events ?? []), body.isActive === false ? 0 : 1, ts, ts);
    audit(request.user.id, 'create', 'webhook', id, body);
    return { item: rowToWebhook(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as DbRow) };
  });

  app.delete('/api/v1/webhooks/:id', { preHandler: [(app as any).authenticate] }, async (request: any) => {
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(request.params.id);
    audit(request.user.id, 'delete', 'webhook', request.params.id);
    return { success: true };
  });

  app.get('/api/v1/users', { preHandler: [(app as any).authenticate] }, async () => {
    const items = db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC').all();
    return { items };
  });

  app.post('/api/v1/users', { preHandler: [(app as any).authenticate] }, async (request: any) => {
    const body = request.body as Record<string, any>;
    const id = `usr_${nanoid()}`;
    const ts = nowIso();
    db.prepare(`INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, body.name, body.email, bcrypt.hashSync(body.password ?? 'ChangeMe123!', 10), body.role ?? 'editor', ts, ts);
    audit(request.user.id, 'create', 'user', id, { email: body.email, role: body.role ?? 'editor' });
    return { item: db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(id) };
  });

  cron.schedule('*/1 * * * *', async () => {
    try {
      await processPendingQueue();
    } catch (error) {
      app.log.error(error);
    }
  });

  return app;
}
