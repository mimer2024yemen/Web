import 'dotenv/config';
import path from 'node:path';

const rootDir = path.resolve(process.cwd(), '..');

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-super-secret',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? 'change-me-refresh-secret',
  adminEmail: process.env.ADMIN_EMAIL ?? 'admin@newshub.local',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'Admin@123456',
  adminName: process.env.ADMIN_NAME ?? 'System Admin',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  dataDir: path.resolve(rootDir, process.env.DATA_DIR ?? './backend/data'),
  uploadDir: path.resolve(rootDir, process.env.UPLOAD_DIR ?? './backend/uploads'),
  redisUrl: process.env.REDIS_URL ?? '',
};
