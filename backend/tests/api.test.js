import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Server did not become healthy in time');
}

async function request(baseUrl, method, url, body, token) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  return { status: response.status, data };
}

test('auth, users, articles and 2FA flow', async () => {
  const port = 4110 + Math.floor(Math.random() * 100);
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = path.join(backendDir, `.tmp-data-${port}`);
  const uploadDir = path.join(backendDir, `.tmp-uploads-${port}`);
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(uploadDir, { recursive: true, force: true });

  const child = spawn('node', ['dist/server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_DIR: dataDir,
      UPLOAD_DIR: uploadDir,
      REDIS_URL: '',
      JWT_SECRET: 'test-secret',
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      APP_ENCRYPTION_KEY: 'test-encryption-secret',
      ADMIN_EMAIL: 'admin@test.local',
      ADMIN_PASSWORD: 'Admin@123456',
      ADMIN_NAME: 'Admin',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  try {
    await waitForHealth(baseUrl);

    const login = await request(baseUrl, 'POST', '/api/v1/auth/login', { email: 'admin@test.local', password: 'Admin@123456' });
    assert.equal(login.status, 200, `login failed: ${JSON.stringify(login.data)} ${stderr}`);
    const token = login.data.accessToken;
    assert.ok(token);

    const users = await request(baseUrl, 'POST', '/api/v1/users', { name: 'Editor', email: 'editor@test.local', password: 'StrongPass123!', role: 'editor', status: 'active', permissions: ['articles.publish'] }, token);
    assert.equal(users.status, 200);
    assert.equal(users.data.item.email, 'editor@test.local');

    const article = await request(baseUrl, 'POST', '/api/v1/articles', { title: 'خبر اختبار', content: 'محتوى', targetSiteIds: [], categories: ['سياسة'], tags: ['عاجل'] }, token);
    assert.equal(article.status, 200);
    assert.equal(article.data.item.title, 'خبر اختبار');

    const setup = await request(baseUrl, 'POST', '/api/v1/auth/2fa/setup', {}, token);
    assert.equal(setup.status, 200);
    assert.ok(setup.data.secret);
    assert.ok(String(setup.data.otpauthUrl).includes('otpauth://'));

    const passwordChange = await request(baseUrl, 'POST', '/api/v1/auth/change-password', { currentPassword: 'Admin@123456', newPassword: 'Admin@654321' }, token);
    assert.equal(passwordChange.status, 200);

    const secondLoginOk = await request(baseUrl, 'POST', '/api/v1/auth/login', { email: 'admin@test.local', password: 'Admin@654321' });
    assert.equal(secondLoginOk.status, 200);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(uploadDir, { recursive: true, force: true });
  }
});
