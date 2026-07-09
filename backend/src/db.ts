import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from './env.js';

fs.mkdirSync(env.dataDir, { recursive: true });
fs.mkdirSync(env.uploadDir, { recursive: true });

const dbPath = path.join(env.dataDir, 'legal-search.sqlite');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function nowIso() {
  return new Date().toISOString();
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      source_type TEXT NOT NULL DEFAULT 'upload',
      storage_provider TEXT NOT NULL DEFAULT 'local',
      storage_key TEXT,
      source_url TEXT,
      raw_text TEXT NOT NULL,
      summary TEXT,
      article_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      article_no TEXT,
      article_title TEXT,
      source_label TEXT,
      chunk_text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      document_id UNINDEXED,
      article_no,
      article_title,
      chunk_text,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      last_question TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      citations_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id ON document_chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);
  `);
}

export function replaceDocumentChunks(
  documentId: string,
  chunks: Array<{ id: string; chunkIndex: number; articleNo: string | null; articleTitle: string | null; sourceLabel: string | null; chunkText: string; normalizedText: string }>
) {
  const deleteChunks = db.prepare('DELETE FROM document_chunks WHERE document_id = ?');
  const deleteFts = db.prepare('DELETE FROM document_chunks_fts WHERE document_id = ?');
  const insertChunk = db.prepare(`INSERT INTO document_chunks (id, document_id, chunk_index, article_no, article_title, source_label, chunk_text, normalized_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertFts = db.prepare(`INSERT INTO document_chunks_fts (chunk_id, document_id, article_no, article_title, chunk_text)
    VALUES (?, ?, ?, ?, ?)`);

  const run = db.transaction(() => {
    deleteChunks.run(documentId);
    deleteFts.run(documentId);
    for (const chunk of chunks) {
      insertChunk.run(
        chunk.id,
        documentId,
        chunk.chunkIndex,
        chunk.articleNo,
        chunk.articleTitle,
        chunk.sourceLabel,
        chunk.chunkText,
        chunk.normalizedText,
        nowIso(),
      );
      insertFts.run(chunk.id, documentId, chunk.articleNo, chunk.articleTitle, chunk.chunkText);
    }
  });

  run();
}
