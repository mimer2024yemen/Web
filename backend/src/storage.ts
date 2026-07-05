import fs from 'node:fs';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from './env.js';

const s3Client = env.s3Enabled ? new S3Client({
  region: env.s3Region,
  endpoint: env.s3Endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.s3AccessKey,
    secretAccessKey: env.s3SecretKey,
  },
}) : null;

export type StoredObject = {
  provider: 'local' | 's3';
  key: string;
  url: string;
  localPath: string;
};

function publicObjectUrl(key: string) {
  if (env.s3PublicBaseUrl) return `${env.s3PublicBaseUrl.replace(/\/$/, '')}/${key}`;
  if (env.s3Endpoint) return `${env.s3Endpoint.replace(/\/$/, '')}/${env.s3Bucket}/${key}`;
  return key;
}

export async function storeBuffer(fileName: string, mimeType: string, buffer: Buffer): Promise<StoredObject> {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (s3Client) {
    const key = `uploads/${Date.now()}-${safeName}`;
    await s3Client.send(new PutObjectCommand({
      Bucket: env.s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }));
    return {
      provider: 's3',
      key,
      url: publicObjectUrl(key),
      localPath: '',
    };
  }

  const filePath = path.join(env.uploadDir, fileName);
  await fs.promises.writeFile(filePath, buffer);
  return {
    provider: 'local',
    key: fileName,
    url: `/uploads/${fileName}`,
    localPath: filePath,
  };
}
