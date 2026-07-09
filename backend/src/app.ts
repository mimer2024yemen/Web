import crypto from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import staticPlugin from '@fastify/static';
import { env } from './env.js';
import { db, initDatabase, nowIso, parseJson, replaceDocumentChunks } from './db.js';
import { generateAiLegalAnswer } from './ai.js';
import {
  buildChunksFromLegalText,
  buildConversationTitle,
  buildDeterministicAnswer,
  buildSearchQuery,
  extractArticleNumber,
  extractTextFromFile,
  normalizeArabic,
  rankHits,
  summarizeDocument,
  type SearchHit,
} from './legal.js';
import { storeBuffer } from './storage.js';

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
}

function listConversations() {
  const rows = db.prepare(`SELECT c.*, 
      (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count
    FROM conversations c
    ORDER BY c.updated_at DESC`).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    lastQuestion: row.last_question,
    lastMessage: row.last_message,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function listDocuments() {
  const rows = db.prepare('SELECT * FROM documents ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: row.size,
    sourceType: row.source_type,
    storageProvider: row.storage_provider,
    sourceUrl: row.source_url,
    summary: row.summary,
    articleCount: row.article_count,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function getConversation(conversationId: string) {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as Record<string, unknown> | undefined;
  if (!conversation) return null;
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId) as Array<Record<string, unknown>>;
  return {
    id: conversation.id,
    title: conversation.title,
    lastQuestion: conversation.last_question,
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      citations: parseJson(message.citations_json as string, []),
      createdAt: message.created_at,
    })),
  };
}

function ensureConversation(conversationId: string | undefined, question: string) {
  if (conversationId) {
    const existing = db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId) as { id: string } | undefined;
    if (existing) return conversationId;
  }

  const newId = id('conv');
  const ts = nowIso();
  db.prepare('INSERT INTO conversations (id, title, last_question, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(newId, buildConversationTitle(question), question, ts, ts);
  return newId;
}

function insertMessage(conversationId: string, role: 'user' | 'assistant', content: string, citations: unknown[] = []) {
  const messageId = id('msg');
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, citations_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(messageId, conversationId, role, content, JSON.stringify(citations), nowIso());
  return messageId;
}

function findRelevantChunks(question: string, documentIds?: string[]) {
  const articleNo = extractArticleNumber(question);
  const ftsQuery = buildSearchQuery(question);
  const hits: SearchHit[] = [];
  const docFilterSql = documentIds?.length ? ` AND dc.document_id IN (${documentIds.map(() => '?').join(',')})` : '';
  const docFilterParams = documentIds?.length ? documentIds : [];

  if (ftsQuery) {
    try {
      const ftsRows = db.prepare(`
        SELECT dc.id, dc.document_id, dc.article_no, dc.article_title, dc.source_label, dc.chunk_text,
               d.title, d.file_name, (-bm25(document_chunks_fts)) AS raw_score
        FROM document_chunks_fts
        JOIN document_chunks dc ON dc.id = document_chunks_fts.chunk_id
        JOIN documents d ON d.id = dc.document_id
        WHERE document_chunks_fts MATCH ? ${docFilterSql}
        LIMIT 12
      `).all(ftsQuery, ...docFilterParams) as Array<Record<string, unknown>>;

      for (const row of ftsRows) {
        hits.push({
          id: String(row.id),
          documentId: String(row.document_id),
          title: String(row.title),
          fileName: String(row.file_name),
          articleNo: row.article_no ? String(row.article_no) : null,
          articleTitle: row.article_title ? String(row.article_title) : null,
          sourceLabel: row.source_label ? String(row.source_label) : null,
          chunkText: String(row.chunk_text),
          score: Number(row.raw_score ?? 0),
        });
      }
    } catch {
      // fall through to LIKE search
    }
  }

  if (!hits.length) {
    const normalizedQuestion = normalizeArabic(question);
    const terms = normalizedQuestion.split(' ').filter((item) => item.length >= 2).slice(0, 6);
    if (terms.length) {
      const whereTerms = terms.map(() => 'dc.normalized_text LIKE ?').join(' OR ');
      const params = terms.map((term) => `%${term}%`);
      const rows = db.prepare(`
        SELECT dc.id, dc.document_id, dc.article_no, dc.article_title, dc.source_label, dc.chunk_text,
               d.title, d.file_name
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id
        WHERE (${whereTerms}) ${docFilterSql}
        LIMIT 12
      `).all(...params, ...docFilterParams) as Array<Record<string, unknown>>;
      for (const row of rows) {
        hits.push({
          id: String(row.id),
          documentId: String(row.document_id),
          title: String(row.title),
          fileName: String(row.file_name),
          articleNo: row.article_no ? String(row.article_no) : null,
          articleTitle: row.article_title ? String(row.article_title) : null,
          sourceLabel: row.source_label ? String(row.source_label) : null,
          chunkText: String(row.chunk_text),
          score: 1,
        });
      }
    }
  }

  if (articleNo) {
    const byArticle = db.prepare(`
      SELECT dc.id, dc.document_id, dc.article_no, dc.article_title, dc.source_label, dc.chunk_text,
             d.title, d.file_name
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id
      WHERE dc.article_no = ? ${docFilterSql}
      LIMIT 8
    `).all(articleNo, ...docFilterParams) as Array<Record<string, unknown>>;
    for (const row of byArticle) {
      hits.push({
        id: String(row.id),
        documentId: String(row.document_id),
        title: String(row.title),
        fileName: String(row.file_name),
        articleNo: row.article_no ? String(row.article_no) : null,
        articleTitle: row.article_title ? String(row.article_title) : null,
        sourceLabel: row.source_label ? String(row.source_label) : null,
        chunkText: String(row.chunk_text),
        score: 6,
      });
    }
  }

  const deduped = new Map<string, SearchHit>();
  for (const hit of rankHits(question, hits)) {
    if (!deduped.has(hit.id)) deduped.set(hit.id, hit);
  }
  return [...deduped.values()].slice(0, 8);
}

async function answerQuestion(question: string, conversationId?: string, documentIds?: string[]) {
  const resolvedConversationId = ensureConversation(conversationId, question);
  const hits = findRelevantChunks(question, documentIds);
  const fallback = buildDeterministicAnswer(question, hits);
  const ai = await generateAiLegalAnswer(question, hits).catch(() => null);
  const answer = ai?.answer?.trim() || fallback.answer;
  const citations = fallback.citations;

  insertMessage(resolvedConversationId, 'user', question);
  insertMessage(resolvedConversationId, 'assistant', answer, citations);
  db.prepare('UPDATE conversations SET last_question = ?, updated_at = ? WHERE id = ?').run(question, nowIso(), resolvedConversationId);

  return {
    conversationId: resolvedConversationId,
    answer,
    citations,
    usedAi: Boolean(ai?.answer),
    hitsConsidered: hits.length,
  };
}

export async function buildApp() {
  initDatabase();

  const app = Fastify({ logger: true, trustProxy: true });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || !env.isProduction) return cb(null, true);
      cb(null, env.allowedOrigins.includes(origin));
    },
  });
  await app.register(helmet, { global: true, contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'AI Legal Search API',
        version: '1.0.0',
        description: 'Private legal search and answer engine for Arabic legal documents',
      },
      servers: [{ url: env.appUrl }],
    },
  });
  await app.register(swaggerUI, { routePrefix: '/docs' });
  await app.register(staticPlugin, { root: env.uploadDir, prefix: '/uploads/' });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const err = error as Error & { statusCode?: number };
    reply.code(err.statusCode ?? 500).send({ message: err.message || 'Internal Server Error' });
  });

  app.get('/health', async () => ({ ok: true, service: 'ai-legal-search-api', timestamp: nowIso(), aiEnabled: env.aiEnabled, storage: env.useSupabaseStorage && env.supabaseUrl ? 'supabase-or-local-fallback' : 'local' }));

  app.get('/api/v1/app/config', async () => ({
    appName: env.appName,
    jurisdiction: env.defaultJurisdiction,
    aiEnabled: env.aiEnabled,
    storageMode: env.useSupabaseStorage && env.supabaseUrl ? 'supabase-or-local-fallback' : 'local',
  }));

  app.get('/api/v1/documents', async () => ({ items: listDocuments() }));
  app.get('/api/v1/conversations', async () => ({ items: listConversations() }));
  app.get('/api/v1/conversations/:id', async (request, reply) => {
    const conversation = getConversation((request.params as any).id);
    if (!conversation) return reply.code(404).send({ message: 'Conversation not found' });
    return conversation;
  });

  app.post('/api/v1/conversations', async (request) => {
    const body = (request.body ?? {}) as { title?: string };
    const conversationId = id('conv');
    const ts = nowIso();
    db.prepare('INSERT INTO conversations (id, title, last_question, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(conversationId, body.title?.trim() || 'محادثة قانونية جديدة', '', ts, ts);
    return { item: getConversation(conversationId) };
  });

  app.post('/api/v1/search', async (request) => {
    const body = (request.body ?? {}) as { query?: string; documentIds?: string[] };
    const query = body.query?.trim() || '';
    return {
      items: query ? findRelevantChunks(query, body.documentIds).map((hit) => ({
        documentId: hit.documentId,
        title: hit.title,
        fileName: hit.fileName,
        articleNo: hit.articleNo,
        articleTitle: hit.articleTitle,
        sourceLabel: hit.sourceLabel,
        excerpt: hit.chunkText,
        score: hit.score,
      })) : [],
    };
  });

  app.post('/api/v1/ask', async (request, reply) => {
    const body = (request.body ?? {}) as { question?: string; conversationId?: string; documentIds?: string[] };
    const question = body.question?.trim();
    if (!question) return reply.code(400).send({ message: 'Question is required' });
    return answerQuestion(question, body.conversationId, body.documentIds);
  });

  app.post('/api/v1/documents/upload', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ message: 'File is required' });

    const titleField = (file.fields?.title as any)?.value as string | undefined;
    const directQuestion = (file.fields?.question as any)?.value as string | undefined;
    const buffer = await file.toBuffer();
    const extractedText = await extractTextFromFile(buffer, file.filename, file.mimetype);
    if (!extractedText.trim()) return reply.code(400).send({ message: 'Could not extract readable text from this file' });

    const stored = await storeBuffer(file.filename, file.mimetype, buffer);
    const documentId = id('doc');
    const chunks = buildChunksFromLegalText(extractedText).map((chunk, index) => ({
      id: id('chk'),
      chunkIndex: index + 1,
      articleNo: chunk.articleNo,
      articleTitle: chunk.articleTitle,
      sourceLabel: chunk.sourceLabel,
      chunkText: chunk.text,
      normalizedText: normalizeArabic(chunk.text),
    }));
    const articleCount = new Set(chunks.map((chunk) => chunk.articleNo).filter(Boolean)).size;
    const ts = nowIso();

    db.prepare(`INSERT INTO documents (
      id, title, file_name, mime_type, size, source_type, storage_provider, storage_key, source_url, raw_text, summary, article_count, chunk_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        documentId,
        titleField?.trim() || file.filename,
        file.filename,
        file.mimetype,
        buffer.length,
        stored.provider,
        stored.key,
        stored.url,
        extractedText,
        summarizeDocument(extractedText),
        articleCount,
        chunks.length,
        ts,
        ts,
      );
    replaceDocumentChunks(documentId, chunks);

    const payload: Record<string, unknown> = {
      item: listDocuments().find((item) => item.id === documentId),
    };

    if (directQuestion?.trim()) {
      payload.answer = await answerQuestion(directQuestion.trim(), undefined, [documentId]);
    }

    return payload;
  });

  return app;
}
