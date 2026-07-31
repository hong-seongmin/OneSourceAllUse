import { hashPassword, verifyPassword } from './crypto.js';
import { id, sha256, token } from './ids.js';
import { issue } from './errors.js';

export async function bootstrapAdministrator(db, { email, password, workspaceName = 'OSAU 작업공간' }) {
  if (!email || !password) return null;
  const existing = await db.query('SELECT id, email FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing[0]) return existing[0];
  return db.transaction(async (tx) => {
    const races = await tx.query('SELECT id, email FROM users WHERE email = $1', [email.toLowerCase()]);
    if (races[0]) return races[0];
    const workspaceId = id();
    const userId = id();
    await tx.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [workspaceId, workspaceName]);
    await tx.query('INSERT INTO users (id, workspace_id, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)', [
      userId, workspaceId, email.toLowerCase(), await hashPassword(password), 'administrator'
    ]);
    return { id: userId, email: email.toLowerCase() };
  });
}

export async function login(db, email, password) {
  const user = (await db.query('SELECT id, workspace_id, email, password_hash, role FROM users WHERE email = $1', [String(email).toLowerCase()]))[0];
  if (!user || !(await verifyPassword(String(password), user.password_hash))) throw issue('INVALID_CREDENTIALS', '이메일 또는 비밀번호가 맞지 않습니다.', 401);
  const rawToken = token();
  const csrf = token();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
  await db.query('INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at) VALUES ($1,$2,$3,$4,$5)', [
    id(), user.id, sha256(rawToken), csrf, expiresAt
  ]);
  return { token: rawToken, csrf, expiresAt, user: { id: user.id, workspaceId: user.workspace_id, email: user.email, role: user.role } };
}

export async function authenticate(db, rawToken) {
  if (!rawToken) return null;
  const session = (await db.query(`SELECT s.id AS session_id, s.csrf_token, s.expires_at, u.id, u.workspace_id, u.email, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sha256(rawToken)]))[0];
  if (!session) return null;
  return { sessionId: session.session_id, csrf: session.csrf_token, expiresAt: session.expires_at, id: session.id, workspaceId: session.workspace_id, email: session.email, role: session.role };
}

export async function logout(db, rawToken) {
  if (rawToken) await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(rawToken)]);
}

export function requireRole(user, ...roles) {
  if (!user) throw issue('AUTH_REQUIRED', '로그인이 필요합니다.', 401);
  if (!roles.includes(user.role)) throw issue('FORBIDDEN', '이 작업을 수행할 권한이 없습니다.', 403);
}

export function cookieOptions(environment, secureOverride = undefined) {
  // TLS remains the production default. An explicit false is only for a deliberately
  // isolated internal HTTP deployment; it never removes authentication or CSRF checks.
  const secure = secureOverride ?? environment === 'production';
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 1000 * 60 * 60 * 24 * 14 };
}
