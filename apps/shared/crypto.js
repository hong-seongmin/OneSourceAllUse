import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { issue } from './errors.js';

const scrypt = promisify(scryptCallback);

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12) throw issue('WEAK_PASSWORD', '비밀번호는 12자 이상이어야 합니다.');
  const salt = randomBytes(16).toString('base64url');
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  const [algorithm, salt, expected] = String(encoded).split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64));
  const target = Buffer.from(expected, 'base64url');
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function encryptionKey(raw) {
  if (!raw) throw issue('MISSING_SECRET_KEY', '비밀값 암호화를 위한 SECRET_ENCRYPTION_KEY가 필요합니다.', 500);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw issue('INVALID_SECRET_KEY', 'SECRET_ENCRYPTION_KEY는 32-byte base64 값이어야 합니다.', 500);
  return key;
}

export function encryptSecret(plain, keyValue) {
  if (!plain) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function decryptSecret(ciphertext, keyValue) {
  if (!ciphertext) return '';
  const [ivRaw, tagRaw, bodyRaw] = ciphertext.split('.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyValue), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(bodyRaw, 'base64url')), decipher.final()]).toString('utf8');
}
