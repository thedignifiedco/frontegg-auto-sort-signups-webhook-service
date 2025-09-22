// app/api/webhooks/frontegg/route.ts
import type { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Required env:
 *  - FRONTEGG_CLIENT_ID
 *  - FRONTEGG_API_KEY
 *  - FRONTEGG_REGION_BASE           (e.g., https://api.frontegg.com)
 *  - FRONTEGG_WEBHOOK_SECRET        (PSK or JWT signing key; sent in x-webhook-secret)
 * Optional:
 *  - DEFAULT_APP_ID                 (assign app -> tenant)
 *  - DEFAULT_SRC_TENANT_ID          (source tenant for removal)
 *  - DRY_RUN=1                      (skip external API calls for debugging)
 */

const REGION = process.env.FRONTEGG_REGION_BASE ?? 'https://api.frontegg.com';

// Auth
const AUTH_VENDOR_URL = `${REGION}/auth/vendor`;

// Tenants
const TENANTS_V2_URL  = `${REGION}/tenants/resources/tenants/v2`;
const TENANTS_V1_URL  = `${REGION}/tenants/resources/tenants/v1`;
const APP_ASSIGN_URL  = (appId: string) =>
  `${REGION}/applications/resources/applications/tenant-assignments/v1/${appId}`;

// User attach to tenant and removal from a tenant
const ADD_USER_TO_TENANT_URL = (userId: string) =>
  `${REGION}/identity/resources/users/v1/${encodeURIComponent(userId)}/tenant`;
const REMOVE_USER_URL = (userId: string) =>
  `${REGION}/identity/resources/users/v1/${encodeURIComponent(userId)}`;

const DRY_RUN = process.env.DRY_RUN === '1';

// -------------------- helpers

function verifySecret(req: NextRequest) {
  const header = req.headers.get('x-webhook-secret') || '';
  const secret = process.env.FRONTEGG_WEBHOOK_SECRET || '';
  if (!header || !secret) return false;

  // Plain PSK
  if (header === secret) return true;

  // JWT signed with the same secret
  try {
    jwt.verify(header, secret);
    return true;
  } catch {
    return false;
  }
}

async function readJson(req: NextRequest) {
  const raw = await req.text();
  return JSON.parse(raw);
}

function fetchIsJson(res: Response) {
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json');
}
async function readJsonOrText(res: Response) {
  if (fetchIsJson(res)) {
    try { return await res.json(); } catch {}
  }
  return await res.text();
}

function domainFromEmail(email: string) {
  return email.split('@')[1]?.toLowerCase() || 'unknown';
}
function labelFromDomain(domain: string) {
  const label = domain.split('.')[0] || domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}
// No UUID heuristic required; we just ensure userId exists

 function extractEvent(payload: unknown) {
  // Accept both:
  //  - { key: 'frontegg.user.signedUp', data: { user, tenant? } }
  //  - { eventKey: 'frontegg.user.signedUp', user, tenant? }
  const obj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const data = obj['data'] && typeof obj['data'] === 'object' ? (obj['data'] as Record<string, unknown>) : undefined;
  const context = obj['eventContext'] && typeof obj['eventContext'] === 'object'
    ? (obj['eventContext'] as Record<string, unknown>)
    : undefined;
  const user = data?.['user'] && typeof data['user'] === 'object'
    ? (data['user'] as Record<string, unknown>)
    : obj['user'] && typeof obj['user'] === 'object'
      ? (obj['user'] as Record<string, unknown>)
      : undefined;
  const tenant = data?.['tenant'] && typeof data['tenant'] === 'object'
    ? (data['tenant'] as Record<string, unknown>)
    : obj['tenant'] && typeof obj['tenant'] === 'object'
      ? (obj['tenant'] as Record<string, unknown>)
      : undefined;

  const key = typeof obj['key'] === 'string' ? (obj['key'] as string)
    : typeof obj['eventKey'] === 'string' ? (obj['eventKey'] as string)
    : '';
  const userIdFromContext = context && typeof context['userId'] === 'string' ? (context['userId'] as string) : undefined;
  const userIdFromUser = user && typeof user['id'] === 'string' ? (user['id'] as string) : undefined;
  const userId = userIdFromContext ?? userIdFromUser;
  const email = user && typeof user['email'] === 'string' ? (user['email'] as string).trim() : undefined;
  const name = user && typeof user['name'] === 'string' ? (user['name'] as string).trim() : undefined;
  const prehookTenantName = tenant && typeof tenant['name'] === 'string' ? (tenant['name'] as string).trim() : undefined;

  return { key, userId, email, name, prehookTenantName };
}

// -------------------- Frontegg API

async function getVendorToken() {
  const clientId = process.env.FRONTEGG_CLIENT_ID;
  const secret   = process.env.FRONTEGG_API_KEY;
  if (!clientId || !secret) throw new Error('CONFIG: Missing FRONTEGG_CLIENT_ID or FRONTEGG_API_KEY');

  const res = await fetch(AUTH_VENDOR_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, secret }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await readJsonOrText(res);
    throw new Error(`AUTH_VENDOR ${res.status} – ${JSON.stringify(body)}`);
  }
  const json = (await res.json()) as { token?: string };
  if (!json?.token) throw new Error('AUTH_VENDOR: token missing');
  return json.token!;
}

async function findTenantByName(token: string, name: string) {
  const u = new URL(TENANTS_V2_URL);
  u.searchParams.set('_filter', name);
  u.searchParams.set('_limit', '1');

  const res = await fetch(u.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await readJsonOrText(res);
    throw new Error(`TENANTS_V2 ${res.status} – ${JSON.stringify(body)}`);
  }
  const json: unknown = await res.json();
  let itemsArray: unknown[] = [];
  if (Array.isArray(json)) {
    itemsArray = json;
  } else if (json && typeof json === 'object') {
    const maybeItems = (json as Record<string, unknown>)['items'];
    if (Array.isArray(maybeItems)) itemsArray = maybeItems;
  }
  const first = itemsArray.length > 0 ? itemsArray[0] : null;
  return (first as { tenantId: string; name: string } | null);
}

async function createTenant(token: string, name: string) {
  const res = await fetch(TENANTS_V1_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await readJsonOrText(res);
    throw new Error(`TENANTS_CREATE ${res.status} – ${JSON.stringify(body)}`);
  }
  return (await res.json()) as { tenantId: string; name: string };
}

async function ensureAppAssigned(token: string, tenantId: string) {
  const appId = process.env.DEFAULT_APP_ID;
  if (!appId) return;
  const res = await fetch(APP_ASSIGN_URL(appId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tenantId }),
    cache: 'no-store',
  });
  // 409 = already assigned
  if (!res.ok && res.status !== 409) {
    const body = await readJsonOrText(res);
    throw new Error(`APP_ASSIGN ${res.status} – ${JSON.stringify(body)}`);
  }
}

async function addUserToTenantById(token: string, userId: string, tenantId: string) {
  const res = await fetch(ADD_USER_TO_TENANT_URL(userId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tenantId, skipInviteEmail: true }),
    cache: 'no-store',
  });
  if (res.ok) return;
  if (res.status === 409) return; // already in tenant
  const body = await readJsonOrText(res);
  throw new Error(`ADD_USER_TO_TENANT ${res.status} – ${JSON.stringify(body)}`);
}

async function removeUserFromTenant(token: string, userId: string, tenantId: string) {
  const res = await fetch(REMOVE_USER_URL(userId), {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'frontegg-tenant-id': tenantId,
    },
    cache: 'no-store',
  });
  if (res.ok) return;
  if (res.status === 404) return; // user not found in that tenant, treat as done
  const body = await readJsonOrText(res);
  throw new Error(`REMOVE_USER ${res.status} – ${JSON.stringify(body)}`);
}

// -------------------- route handlers

export async function GET() {
  return new Response('OK (GET) – use POST for webhooks', { status: 200 });
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await readJson(req);
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  const { key, userId, email, prehookTenantName } = extractEvent(payload);

  // Only act on the "user signed up" event
  if (key !== 'frontegg.user.signedUp') {
    return new Response('Ignored', { status: 204 });
  }

  if (!email) {
    // We need email for domain-based tenant naming; but acknowledge to avoid retries
    console.error('signedUp event missing email');
    return new Response('No email on event', { status: 200 });
  }

  // Use prehook-suggested tenant name if present; else derive from email domain
  const tenantName = prehookTenantName || labelFromDomain(domainFromEmail(email));

  // Optional dry-run
  if (DRY_RUN) {
    console.log('[DRY_RUN] Would ensure tenant "%s"; then add user to target and remove from "%s"', tenantName, process.env.DEFAULT_SRC_TENANT_ID ?? 'MISSING');
    return new Response('OK (dry run)', { status: 200 });
  }

  try {
    const token  = await getVendorToken();
    const found  = await findTenantByName(token, tenantName);
    const tenant = found ?? (await createTenant(token, tenantName));

    await ensureAppAssigned(token, tenant.tenantId);

    if (userId) {
      await addUserToTenantById(token, userId, tenant.tenantId);
      const srcTenantId = process.env.DEFAULT_SRC_TENANT_ID;
      if (srcTenantId) {
        await removeUserFromTenant(token, userId, srcTenantId);
      } else {
        console.warn('DEFAULT_SRC_TENANT_ID not set; skipping removal from default tenant');
      }
    } else {
      console.warn('Missing userId; cannot add or remove user from tenants');
    }

    return new Response('OK', { status: 200 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('frontegg.webhook error:', msg);
    return new Response(`Internal error: ${msg}`, { status: 500 });
  }
}
