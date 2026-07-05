import crypto from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';

function deriveKey(secret: string) {
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(value: string, secret: string) {
  if (!value) return '';
  if (value.startsWith('enc:')) return value;
  const iv = crypto.randomBytes(12);
  const key = deriveKey(secret);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
}

export function decryptSecret(value: string | null | undefined, secret: string) {
  if (!value) return '';
  if (!value.startsWith('enc:')) return value;
  const raw = Buffer.from(value.slice(4), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const key = deriveKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function generateTwoFactorSecret(label: string, issuer = 'NewsHub Pro') {
  const secret = generateSecret();
  const otpauthUrl = generateURI({ label, issuer, secret });
  return { secret, otpauthUrl };
}

export function verifyTwoFactorToken(secret: string, token?: string | null) {
  if (!secret || !token) return false;
  return verify({ token: token.replace(/\s+/g, ''), secret });
}

export function createMask(value: string | null | undefined, visible = 3) {
  if (!value) return '';
  if (value.length <= visible) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.max(4, value.length - visible))}${value.slice(-visible)}`;
}

export function randomSecret(size = 48) {
  return crypto.randomBytes(size).toString('hex');
}
