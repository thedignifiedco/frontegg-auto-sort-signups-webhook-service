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
 *  - FRONTEGG_WEBHOOK_SECRET        (PSK or signing key; sent in x-webhook-secret)
 * Optional:
 *  - DEFAULT_APP_ID                 (assign app -> tenant)
 *  - DRY_RUN=1                      (skip API calls for debugging)
 */

const REGION = process.env.FRONTEGG_REGION_BASE ?? 'https://api.frontegg.com';
const AUTH_VENDOR_URL = `${REGION}/auth/vendor`;
const TENANTS_V2_URL  = `${REGION}/tenants/resources/tenants/v2`;
const TENANTS_V1_URL  = `${REGION}/tenants/resources/tenants/v1`;
const APP_ASSIGN_URL  = (appId: string) =>
  `${REGION}/applications/resources/applications/tenant-assignments/v1/${appId}`;

// Fallback-only (if userId is missing): correct bulk invite endpoint + tenant header
const USERS_BULK_INVITE_URL = `${REGION}/identity/resources/users/bulk/v1/invite`;

// Option B primary endpoint: add an existing user to a tenant by userId
const ADD_USER_TO_TENANT_URL = (userId: string) =>
  `${REGION}/identity/resources/users/v1/${encodeURIComponent(userId)}/tenant`;

const DRY_RUN = process.env.DRY_RUN === '1';

// ---------- Utils

function verifySecret(req: NextRequest) {
  const header = req.headers.get('x-webhook-secret') || '';
  const secret = process.env.FRONTEGG_WEBHOOK_SECRET || '';
  if (!header || !secret) return false;

  // 1) Plain PSK equality
  if (header === secret) return true;

  // 2) JWT signed with the secret
  try {
    jwt.verify(header, secret);
    return true;
  } catch {
    return false;
  }
}

async function getBody(req: NextRequest) {
  // Use text() then JSON.parse() to avoid body-lock with earlier reads
  const raw = await req.text();
  return JSON.parse(raw);
}

function deriveTenantNameFromEmail(email: string) {
  const domain = email.split('@')[1]?.toLowerCase() || 'unknown';
  const label = domain.split('.')[0] || domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

 function extractEventInfo(payload: unknown) {
   // Accept both shapes:
   //  - { key: 'frontegg.user.signedUp', data: { user, tenant? } }
   //  - { eventKey: 'frontegg.user.signedUp', user, tenant?, eventContext? }
   const obj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
   const data = obj['data'] && typeof obj['data'] === 'object' ? (obj['data'] as Record<string, unknown>) : undefined;
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
   const userId = user && typeof user['id'] === 'string' ? (user['id'] as string) : undefined;
   const email = user && typeof user['email'] === 'string' ? (user['email'] as string).trim() : undefined;
   const name = user && typeof user['name'] === 'string' ? (user['name'] as string).trim() : undefined;
   const prehookTenantName = tenant && typeof tenant['name'] === 'string' ? (tenant['name'] as string).trim() : undefined;

   return { key, userId, email, name, prehookTenantName };
 }

async function fetchJsonOrText(res: Response) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { return await res.json(); } catch { /* fall through */ }
  }
  return await res.text();
}

// ---------- Frontegg API helpers

async function getVendorToken() {
  const clientId = process.env.FRONTEGG_CLIENT_ID;
  const secret   = process.env.FRONTEGG_API_KEY;
  if (!clientId || !secret) {
    throw new Error('CONFIG: Missing FRONTEGG_CLIENT_ID or FRONTEGG_API_KEY');
  }
  const res = await fetch(AUTH_VENDOR_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, secret }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await fetchJsonOrText(res);
    throw new Error(`AUTH_VENDOR ${res.status} – ${JSON.stringify(body)}`);
  }
  const json = (await res.json()) as { token?: string };
  if (!json?.token) throw new Error('AUTH_VENDOR: token missing in response');
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
    const body = await fetchJsonOrText(res);
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
    const body = await fetchJsonOrText(res);
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
  if (!res.ok && res.status !== 409) {
    const body = await fetchJsonOrText(res);
    throw new Error(`APP_ASSIGN ${res.status} – ${JSON.stringify(body)}`);
  }
}

// ----- Option B (primary): attach by userId
async function addUserToTenantById(
  token: string,
  userId: string,
  tenantId: string
) {
  const res = await fetch(ADD_USER_TO_TENANT_URL(userId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      tenantId,
      skipInviteEmail: true,
    }),
    cache: 'no-store',
  });

  if (!res.ok) {
    const body = await fetchJsonOrText(res);
    throw new Error(`ADD_USER_TO_TENANT ${res.status} – ${JSON.stringify(body)}`);
  }
}

// ----- Fallback only (if userId missing): invite by email into tenant
async function addUserToTenantByEmail(
  token: string,
  tenantId: string,
  email: string,
  name?: string
) {
  const res = await fetch(USERS_BULK_INVITE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'frontegg-tenant-id': tenantId, // required for bulk invite
    },
    body: JSON.stringify({
      users: [
        {
          email,
          name,
          provider: 'local',
          skipInviteEmail: true,
          // Set to true only if your flow verifies email before this webhook:
          verified: true,
        },
      ],
    }),
    cache: 'no-store',
  });

  if (!res.ok) {
    const body = await fetchJsonOrText(res);
    throw new Error(`BULK_INVITE ${res.status} – ${JSON.stringify(body)}`);
  }
}

// ---------- Handlers

export async function GET() {
  return new Response('OK (GET) – use POST for webhooks', { status: 200 });
}

export async function POST(req: NextRequest) {
  // 1) Verify secret
  if (!verifySecret(req)) {
    return new Response('Invalid signature', { status: 401 });
  }

  // 2) Parse payload
   let payload: unknown;
  try {
    payload = await getBody(req);
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  // 3) Extract info
  const { key, userId, email, name, prehookTenantName } = extractEventInfo(payload);

  // Only act on signedUp; acknowledge others
  if (key !== 'frontegg.user.signedUp') {
    return new Response('Ignored', { status: 204 });
  }

  if (!email) {
    console.error('SIGNED_UP without email, payload:', JSON.stringify(payload).slice(0, 2000));
    return new Response('No email on event', { status: 200 });
  }

  const tenantName = prehookTenantName || deriveTenantNameFromEmail(email);

  // 4) Dry run support
  if (DRY_RUN) {
    console.log('[DRY_RUN] Would ensure tenant "%s", then add user %s (id=%s)',
      tenantName, email, userId ?? 'n/a');
    return new Response('OK (dry run)', { status: 200 });
  }

  // 5) Do the work
  try {
    const token  = await getVendorToken();
    const found  = await findTenantByName(token, tenantName);
    const tenant = found ?? (await createTenant(token, tenantName));

    await ensureAppAssigned(token, tenant.tenantId);

    if (userId) {
      await addUserToTenantById(token, userId, tenant.tenantId); // Option B (primary)
    } else {
      // Fallback if userId is missing for any reason
      await addUserToTenantByEmail(token, tenant.tenantId, email, name);
    }

    return new Response('OK', { status: 200 });
   } catch (err: unknown) {
     const msg = err instanceof Error ? err.message : String(err);
     console.error('frontegg.webhook error:', msg);
     return new Response(`Internal error: ${msg}`, { status: 500 });
  }
}
