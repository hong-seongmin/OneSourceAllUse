import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export const token = () => randomBytes(32).toString('base64url');
export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
export const stableKey = (value) => sha256(value).slice(0, 32);
export const now = () => new Date().toISOString();

export function cleanText(value, max = 50_000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

export function parseJson(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
