import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';

let supabase: SupabaseClient | null = null;
if (env.useSupabaseStorage && env.supabaseUrl && env.supabaseServiceRoleKey) {
  supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, { auth: { persistSession: false } });
}

let bucketEnsured = false;

async function ensureBucket() {
  if (!supabase || bucketEnsured) return;
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = buckets?.some((bucket) => bucket.name === env.supabaseBucket);
  if (!exists) {
    await supabase.storage.createBucket(env.supabaseBucket, {
      public: true,
      fileSizeLimit: '25MB',
      allowedMimeTypes: [
        'application/pdf',
        'text/plain',
        'text/markdown',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/msword',
        'application/json',
      ],
    });
  }
  bucketEnsured = true;
}

export type StoredObject = {
  provider: 'local' | 'supabase';
  key: string;
  url: string;
  localPath: string;
};

export async function storeBuffer(fileName: string, mimeType: string, buffer: Buffer): Promise<StoredObject> {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const key = `documents/${Date.now()}-${safeName}`;

  if (supabase) {
    try {
      await ensureBucket();
      const { error } = await supabase.storage.from(env.supabaseBucket).upload(key, buffer, {
        contentType: mimeType,
        upsert: true,
      });
      if (!error) {
        const { data } = supabase.storage.from(env.supabaseBucket).getPublicUrl(key);
        return {
          provider: 'supabase',
          key,
          url: data.publicUrl,
          localPath: '',
        };
      }
    } catch {
      // fall back to local storage
    }
  }

  await fs.promises.mkdir(env.uploadDir, { recursive: true });
  const localPath = path.join(env.uploadDir, key.replace(/^documents\//, ''));
  await fs.promises.writeFile(localPath, buffer);
  return {
    provider: 'local',
    key,
    url: `/uploads/${path.basename(localPath)}`,
    localPath,
  };
}
