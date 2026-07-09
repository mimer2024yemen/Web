import 'dotenv/config';
import path from 'node:path';

const rootDir = path.resolve(process.cwd(), '..');

function splitCsv(value: string | undefined, fallback: string[]) {
  if (!value?.trim()) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: (process.env.NODE_ENV ?? 'development') === 'production',
  port: Number(process.env.PORT ?? 4000),
  appUrl: process.env.APP_URL ?? 'http://localhost:8080',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  allowedOrigins: splitCsv(process.env.ALLOWED_ORIGINS, ['http://localhost:5173', 'http://localhost:8080']),

  // Core app
  appName: process.env.APP_NAME ?? 'AI Legal Search Yemen',
  defaultJurisdiction: process.env.DEFAULT_JURISDICTION ?? 'اليمن',
  dataDir: path.resolve(rootDir, process.env.DATA_DIR ?? './backend/data'),
  uploadDir: path.resolve(rootDir, process.env.UPLOAD_DIR ?? './backend/uploads'),

  // Security / legacy compatibility
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-super-secret',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? 'change-me-refresh-secret',
  encryptionKey: process.env.APP_ENCRYPTION_KEY ?? process.env.JWT_SECRET ?? 'change-me-super-secret',
  adminEmail: process.env.ADMIN_EMAIL ?? 'admin@legal.local',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'Admin@123456',
  adminName: process.env.ADMIN_NAME ?? 'System Admin',

  // Optional AI provider (OpenAI-compatible)
  aiApiUrl: process.env.AI_API_URL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  aiApiKey: process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
  aiModel: process.env.AI_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  aiEnabled: Boolean((process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY ?? '').trim()),

  // Optional Supabase storage
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  supabaseBucket: process.env.SUPABASE_BUCKET ?? 'legal-documents',
  useSupabaseStorage: String(process.env.USE_SUPABASE_STORAGE ?? 'true').toLowerCase() === 'true',

  // Legacy optional infra fields kept for compatibility
  redisUrl: process.env.REDIS_URL ?? '',
  queueConcurrency: Number(process.env.QUEUE_CONCURRENCY ?? 5),
  s3Endpoint: process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? '',
  s3Region: process.env.S3_REGION ?? 'us-east-1',
  s3AccessKey: process.env.S3_ACCESS_KEY ?? process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
  s3SecretKey: process.env.S3_SECRET_KEY ?? process.env.MINIO_SECRET_KEY ?? 'minioadmin',
  s3Bucket: process.env.S3_BUCKET ?? process.env.MINIO_BUCKET ?? 'newshub',
  s3PublicBaseUrl: process.env.S3_PUBLIC_BASE_URL ?? '',
  s3Enabled: Boolean((process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? '').trim()),
};
