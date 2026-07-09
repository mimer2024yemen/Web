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

test('upload legal text and answer question with citations', async () => {
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
      AI_API_KEY: '',
      REDIS_URL: '',
      USE_SUPABASE_STORAGE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  try {
    await waitForHealth(baseUrl);

    const form = new FormData();
    form.append('title', 'قانون العمل اليمني - اختبار');
    form.append('file', new Blob([`المادة (1) يلتزم صاحب العمل بدفع الأجر في موعده المحدد.\n\nالمادة (2) إذا وقع فصل تعسفي استحق العامل التعويض المناسب والحقوق المالية الأخرى وفقاً للقانون.`], { type: 'text/plain' }), 'labor-law.txt');

    const uploadResponse = await fetch(`${baseUrl}/api/v1/documents/upload`, {
      method: 'POST',
      body: form,
    });
    assert.equal(uploadResponse.status, 200, stderr);
    const uploadData = await uploadResponse.json();
    assert.equal(uploadData.item.title, 'قانون العمل اليمني - اختبار');

    const askResponse = await fetch(`${baseUrl}/api/v1/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'ما حقوق العامل عند الفصل التعسفي؟', documentIds: [uploadData.item.id] }),
    });
    assert.equal(askResponse.status, 200, stderr);
    const askData = await askResponse.json();

    assert.ok(String(askData.answer).includes('المادة 2') || String(askData.answer).includes('التعويض'));
    assert.ok(Array.isArray(askData.citations));
    assert.ok(askData.citations.length >= 1);

    const conversations = await fetch(`${baseUrl}/api/v1/conversations`);
    const conversationsData = await conversations.json();
    assert.ok(conversationsData.items.length >= 1);

    const conversation = await fetch(`${baseUrl}/api/v1/conversations/${askData.conversationId}`);
    const conversationData = await conversation.json();
    assert.equal(conversationData.messages.length, 2);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(uploadDir, { recursive: true, force: true });
  }
});
