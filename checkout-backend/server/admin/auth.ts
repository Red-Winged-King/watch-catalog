import { Router, type Request, type Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, withLifecycleLock } from '../store.js';

export const SESSION_COOKIE = 'webdev_app_session';
const PREVIEW_ORIGIN = 'https://8328-i6qg3l1q41cuwjesdgqt4-c66b0a30.us5.manus.computer';
const PUBLISHED_ORIGIN = 'https://watchbuy-ko4chrlv.manus.space';
export function allowedOrigins(): Set<string> {
  return new Set([PREVIEW_ORIGIN, PUBLISHED_ORIGIN, 'https://red-winged-king.github.io', ...String(process.env.APP_PUBLIC_ORIGIN || '').split(',').filter(Boolean)]);
}
export function cookies(req: Request): Record<string, string> {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim().split(/=(.*)/s)).filter(x => x.length >= 2).map(([k,v]) => [k, decodeURIComponent(v)]));
}
function secret(): Uint8Array {
  if (!process.env.MANUS_JWT_SECRET) throw new HttpError(503, 'AUTH_NOT_CONFIGURED', 'Application login is not configured');
  return new TextEncoder().encode(process.env.MANUS_JWT_SECRET);
}
export interface Identity { openId: string; name: string; token: string; isAdmin: boolean }
export async function identity(req: Request): Promise<Identity | null> {
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    if (payload.appId !== process.env.MANUS_PROJECT_ID || typeof payload.openId !== 'string' || !payload.exp || payload.openId.startsWith('cron_')) return null;
    return { openId: payload.openId, name: typeof payload.name === 'string' ? payload.name : 'Account', token, isAdmin: Boolean(process.env.ADMIN_OPEN_ID && payload.openId === process.env.ADMIN_OPEN_ID) };
  } catch { return null; }
}
export function csrf(identity: Identity): string {
  return createHmac('sha256', secret()).update(`wc_csrf:${identity.token}`).digest('hex');
}
export function verifySessionMutation(req: Request, user: Identity): void {
  requireOrigin(req);
  const supplied = Buffer.from(req.get('X-CSRF-Token') || '');
  const expected = Buffer.from(csrf(user));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(403, 'CSRF', 'Reload the dashboard and try again');
}
export async function requireAdmin(req: Request, mutation = false): Promise<Identity> {
  const user = await identity(req);
  if (!user) throw new HttpError(401, 'LOGIN_REQUIRED', 'Sign in to manage the catalog');
  if (!user.isAdmin) throw new HttpError(403, 'OWNER_REQUIRED', 'This account is not configured as the catalog owner');
  if (mutation) verifySessionMutation(req, user);
  return user;
}
export function requireOrigin(req: Request): string {
  const origin = req.get('Origin') || '';
  if (!allowedOrigins().has(origin)) throw new HttpError(403, 'ORIGIN', 'This application origin is not configured');
  return origin;
}
async function authRpc(method: string, body: unknown): Promise<Record<string, unknown>> {
  const base = process.env.MANUS_OAUTH_API_URL;
  if (!base) throw new HttpError(503, 'AUTH_NOT_CONFIGURED', 'Application login is not configured');
  const response = await fetch(`${base.replace(/\/$/, '')}/webdev.v1.WebDevAuthPublicService/${method}`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new HttpError(502, 'AUTH_PROVIDER', 'The login service could not complete this request');
  const result = await response.json() as Record<string, unknown>;
  if (result.error) throw new HttpError(502, 'AUTH_PROVIDER', 'The login service could not complete this request');
  return result;
}
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/' };
export const authRouter = Router();
authRouter.get('/api/auth/me', async (req, res) => {
  const user = await identity(req);
  res.json({ authenticated: Boolean(user), isAdmin: user?.isAdmin || false, openId: user?.openId, name: user?.name, csrfToken: user ? csrf(user) : undefined, ownerConfigured: Boolean(process.env.ADMIN_OPEN_ID) });
});
authRouter.post('/api/auth/start', async (req, res) => {
  const origin = requireOrigin(req);
  if (req.body?.origin !== origin || !origin.startsWith('https://')) throw new HttpError(400, 'ORIGIN', 'Use the public HTTPS application URL for login');
  if (origin === 'https://red-winged-king.github.io') throw new HttpError(400, 'ADMIN_ORIGIN', 'Open the owner dashboard on the companion backend to sign in');
  const redirectUri = `${origin}/auth/callback`;
  const nonce = randomBytes(32).toString('base64url');
  const state = Buffer.from(JSON.stringify({ redirectUri, nonce })).toString('base64');
  await withLifecycleLock(store => store.put('oauth', nonce, { nonce, redirectUri, expiresAt: Date.now() + 600000, provider: 'manus' }));
  res.cookie('wc_auth_nonce', nonce, { ...cookieOptions, maxAge: 600000 });
  const url = new URL('/app-auth', process.env.MANUS_OAUTH_PORTAL_URL || 'https://manus.im');
  url.searchParams.set('appId', process.env.MANUS_PROJECT_ID || '');
  url.searchParams.set('redirectUri', redirectUri); url.searchParams.set('state', state); url.searchParams.set('responseType', 'code');
  res.json({ url: url.href });
});
authRouter.get('/auth/callback', async (req, res) => {
  const raw = String(req.query.state || '');
  let state: {nonce: string; redirectUri: string};
  try { state = JSON.parse(Buffer.from(raw, 'base64').toString()); } catch { throw new HttpError(400, 'OAUTH_STATE', 'Login state is invalid'); }
  const nonce = cookies(req).wc_auth_nonce;
  if (!nonce || nonce !== state.nonce || typeof req.query.code !== 'string') throw new HttpError(400, 'OAUTH_STATE', 'Login expired or browser cookies were blocked. Retry in a standalone tab.');
  const record = await withLifecycleLock(async store => {
    const saved = await store.get<{redirectUri:string; expiresAt:number; provider:string}>('oauth', nonce);
    if (!saved || saved.provider !== 'manus' || saved.expiresAt < Date.now() || saved.redirectUri !== state.redirectUri) throw new HttpError(400, 'OAUTH_STATE', 'Login expired. Please sign in again.');
    await store.remove('oauth', nonce); return saved;
  });
  const exchanged = await authRpc('ExchangeToken', { clientId: process.env.MANUS_PROJECT_ID, grantType: 'authorization_code', code: req.query.code, redirectUri: record.redirectUri });
  if (typeof exchanged.accessToken !== 'string') throw new HttpError(502, 'AUTH_PROVIDER', 'Login did not return an identity token');
  const user = await authRpc('GetUserInfo', { accessToken: exchanged.accessToken });
  if (typeof user.openId !== 'string' || user.openId.startsWith('cron_')) throw new HttpError(502, 'AUTH_PROVIDER', 'Login did not return a valid user identity');
  const token = await new SignJWT({ openId: user.openId, name: user.name || 'Account', appId: process.env.MANUS_PROJECT_ID }).setProtectedHeader({alg: 'HS256'}).setIssuedAt().setExpirationTime('8h').sign(secret());
  res.clearCookie('wc_auth_nonce', cookieOptions); res.cookie(SESSION_COOKIE, token, {...cookieOptions, maxAge: 8 * 3600000}); res.redirect('/admin.html');
});
authRouter.post('/api/auth/logout', async (req, res) => {
  const user = await identity(req);
  if (!user) throw new HttpError(401, 'LOGIN_REQUIRED', 'Sign in before ending a session');
  verifySessionMutation(req, user);
  res.clearCookie(SESSION_COOKIE, cookieOptions); res.json({ ok:true });
});
export function setEbayNonce(res: Response, nonce: string): void { res.cookie('wc_ebay_nonce', nonce, {...cookieOptions, maxAge:600000}); }
export function clearEbayNonce(res: Response): void { res.clearCookie('wc_ebay_nonce', cookieOptions); }
export async function scheduledIdentity(req: Request): Promise<string> {
  const token = cookies(req).app_session_id;
  if (!token) throw new HttpError(401, 'SCHEDULE_AUTH', 'Missing scheduler identity');
  let payload;
  try { payload = (await jwtVerify(token, secret(), {algorithms:['HS256']})).payload; } catch { throw new HttpError(401, 'SCHEDULE_AUTH', 'Invalid scheduler identity'); }
  if (!payload.exp || payload.appId !== process.env.MANUS_PROJECT_ID || typeof payload.openId !== 'string' || !payload.openId.startsWith('cron_')) throw new HttpError(403, 'SCHEDULE_AUTH', 'Invalid scheduler project');
  const info = await authRpc('GetUserInfoWithJwt', {jwt_token:token, project_id:process.env.MANUS_PROJECT_ID});
  if (info.projectId !== process.env.MANUS_PROJECT_ID || info.openId !== payload.openId || typeof info.taskUid !== 'string') throw new HttpError(403, 'SCHEDULE_AUTH', 'Scheduler identity could not be resolved');
  return info.taskUid;
}
