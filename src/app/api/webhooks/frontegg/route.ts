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
 *  - DEFAULT_SRC_TENANT_ID          (tenant ID to filter webhooks for and source tenant for removal)
 * Optional:
 *  - DEFAULT_APP_ID                 (assign app -> tenant)
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
// Tenant users utilities
const TENANT_USERS_URL = `${REGION}/identity/resources/users/v3`;
const DISABLE_USER_URL = (userId: string) =>
  `${REGION}/identity/resources/tenants/users/v1/${encodeURIComponent(userId)}/disable`;

const DRY_RUN = process.env.DRY_RUN === '1';

// -------- Vendor token cache (6h TTL)
const VENDOR_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
let vendorTokenCache: { token: string; expiresAt: number } | null = null;

// -------------------- helpers

function verifySecret(req: NextRequest) {
  const header = req.headers.get('x-webhook-secret') || '';
  const secret = process.env.FRONTEGG_WEBHOOK_SECRET || '';
  if (!header || !secret) return false;
  if (header === secret) return true;
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
  // Expected payload structure:
  // {
  //   "eventKey": "frontegg.user.invitedToTenant",
  //   "eventContext": {
  //     "vendorId": "string | null",
  //     "tenantId": "string | null", 
  //     "userId": "string | null"
  //   },
  //   "user": {
  //     "id": "string",
  //     "email": "string",
  //     "tenantId": "string",
  //     ...
  //   }
  // }
  const obj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const context = obj['eventContext'] && typeof obj['eventContext'] === 'object'
    ? (obj['eventContext'] as Record<string, unknown>)
    : undefined;
  const user = obj['user'] && typeof obj['user'] === 'object'
    ? (obj['user'] as Record<string, unknown>)
    : undefined;

  const key = typeof obj['eventKey'] === 'string' ? (obj['eventKey'] as string) : '';
  const userIdFromContext = context && typeof context['userId'] === 'string' ? (context['userId'] as string) : undefined;
  const userIdFromUser = user && typeof user['id'] === 'string' ? (user['id'] as string) : undefined;
  const userId = userIdFromContext ?? userIdFromUser;
  
  // Extract tenant ID from eventContext only
  const tenantId = context && typeof context['tenantId'] === 'string' ? (context['tenantId'] as string) : undefined;
  
  const email = user && typeof user['email'] === 'string' ? (user['email'] as string).trim() : undefined;
  
  // For invitedToTenant events, we don't have a prehook tenant name, so we'll derive from email domain
  const prehookTenantName = undefined;

  return { key, userId, email, prehookTenantName, contextAppId: undefined, tenantId };
}

// -------------------- Frontegg API

async function getVendorToken() {
  const now = Date.now();
  if (vendorTokenCache && vendorTokenCache.expiresAt > now) {
    return vendorTokenCache.token;
  }

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

  vendorTokenCache = {
    token: json.token!,
    expiresAt: now + VENDOR_TOKEN_TTL_MS,
  };
  return vendorTokenCache.token;
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

async function isSecondOrLaterUserInTenant(token: string, tenantId: string) {
  const url = new URL(TENANT_USERS_URL);
  // Ask for up to 2 users starting from the first; if we get 2, there is a second user
  url.searchParams.set('offset', '0');
  url.searchParams.set('limit', '2');
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'frontegg-tenant-id': tenantId,
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await readJsonOrText(res);
    throw new Error(`TENANT_USERS ${res.status} – ${JSON.stringify(body)}`);
  }
  const payload: unknown = await res.json();
  // Prefer total-style fields when present, else fall back to items length
  if (Array.isArray(payload)) return payload.length >= 2;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const totals = [obj['total'], obj['totalCount'], obj['count'], obj['recordsTotal']]
      .map((v) => (typeof v === 'number' ? v : undefined))
      .filter((v): v is number => typeof v === 'number');
    if (totals.length > 0) return Math.max(...totals) >= 2;
    const items = obj['items'];
    if (Array.isArray(items)) return items.length >= 2;
  }
  return false;
}

async function disableUserInTenant(token: string, tenantId: string, userId: string) {
  const res = await fetch(DISABLE_USER_URL(userId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'frontegg-tenant-id': tenantId,
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await readJsonOrText(res);
    throw new Error(`DISABLE_USER ${res.status} – ${JSON.stringify(body)}`);
  }
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

  const { key, userId, email, prehookTenantName, tenantId } = extractEvent(payload);

  // Only act on the "user invited to tenant" event
  if (key !== 'frontegg.user.invitedToTenant') {
    return new Response(null, { status: 204 });
  }

  // Check if the webhook is from the target tenant
  const srcTenantId = process.env.DEFAULT_SRC_TENANT_ID;
  if (!srcTenantId) {
    console.error('DEFAULT_SRC_TENANT_ID environment variable is not set');
    return new Response('Configuration error', { status: 500 });
  }

  if (!tenantId) {
    console.error('No tenant ID found in webhook payload');
    return new Response('No tenant ID in payload', { status: 400 });
  }

  if (tenantId !== srcTenantId) {
    console.log(`Ignoring webhook from tenant ${tenantId}, expected ${srcTenantId}`);
    return new Response(null, { status: 204 });
  }

  if (!email) {
    // We need email for domain-based tenant naming; but acknowledge to avoid retries
    console.error('invitedToTenant event missing email');
    return new Response('No email on event', { status: 200 });
  }

  // Use prehook-suggested tenant name if present; else derive from email domain
  const tenantName = prehookTenantName || labelFromDomain(domainFromEmail(email));

  // Optional dry-run
  if (DRY_RUN) {
    console.log('[DRY_RUN] Would ensure tenant "%s"; then add user to target and remove from "%s"', tenantName, srcTenantId);
    return new Response('OK (dry run)', { status: 200 });
  }

  try {
    const token  = await getVendorToken();
    const found  = await findTenantByName(token, tenantName);
    const tenant = found ?? (await createTenant(token, tenantName));

    await ensureAppAssigned(token, tenant.tenantId);

    if (userId) {
      await addUserToTenantById(token, userId, tenant.tenantId);
      // Remove user from the source tenant (same as the tenant we're filtering for)
      await removeUserFromTenant(token, userId, srcTenantId);

      // Final step: auto-disable if user isn't first in target tenant
      // Note: For invitation events, we don't have applicationId context, so we'll disable
      // all non-first users in the target tenant
      const notFirst = await isSecondOrLaterUserInTenant(token, tenant.tenantId);
      if (notFirst) {
        await disableUserInTenant(token, tenant.tenantId, userId);
      }
    } else {
      console.warn('Missing userId; cannot add/remove/disable user in tenants');
    }

    return new Response('OK', { status: 200 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('frontegg.webhook error:', msg);
    return new Response(`Internal error: ${msg}`, { status: 500 });
  }
}
