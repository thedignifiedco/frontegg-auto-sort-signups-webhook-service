// app/api/webhooks/frontegg/route.ts
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * ---- Config (env) ----
 * FRONTEGG_CLIENT_ID
 * FRONTEGG_API_KEY
 * FRONTEGG_REGION_BASE           (e.g., https://api.frontegg.com)
 * FRONTEGG_WEBHOOK_SECRET        (PSK sent in x-webhook-secret)
 * DEFAULT_APP_ID                 (optional; assign app -> tenant)
 */

const REGION = process.env.FRONTEGG_REGION_BASE ?? 'https://api.frontegg.com';
const AUTH_VENDOR_URL = `${REGION}/auth/vendor`;
const TENANTS_V2_URL = `${REGION}/tenants/resources/tenants/v2`;
const TENANTS_V1_URL = `${REGION}/tenants/resources/tenants/v1`;
const APP_ASSIGN_URL = (appId: string) =>
  `${REGION}/applications/resources/applications/tenant-assignments/v1/${appId}`;
const BULK_INVITE_URL = (tenantId: string) =>
  `${REGION}/identity/resources/tenants/invites/v1/bulk/${tenantId}`;

// ---------- Helpers

function verifySecret(req: NextRequest) {
  const incoming = req.headers.get('x-webhook-secret') || '';
  const expected = process.env.FRONTEGG_WEBHOOK_SECRET || '';
  return Boolean(incoming) && incoming === expected;
}

async function getVendorToken() {
  const clientId = process.env.FRONTEGG_CLIENT_ID;
  const secret = process.env.FRONTEGG_API_KEY;
  if (!clientId || !secret) {
    throw new Error('Missing FRONTEGG_CLIENT_ID or FRONTEGG_API_KEY');
  }
  const res = await fetch(AUTH_VENDOR_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, secret }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Vendor auth failed: ${res.status}`);
  const json = (await res.json()) as { token?: string };
  if (!json?.token) throw new Error('Vendor token missing from response');
  return json.token!;
}

async function findTenantByName(token: string, name: string) {
  const url = new URL(TENANTS_V2_URL);
  url.searchParams.set('_filter', name);
  url.searchParams.set('_limit', '1');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Get tenants failed: ${res.status}`);
  const json = await res.json();
  const items = Array.isArray(json?.items) ? json.items : Array.isArray(json) ? json : [];
  return (items?.[0] ?? null) as { tenantId: string; name: string } | null;
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
  if (!res.ok) throw new Error(`Create tenant failed: ${res.status}`);
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
  // 200/201 ok; 409 (already assigned) is fine.
  if (!res.ok && res.status !== 409) {
    throw new Error(`Assign app->tenant failed: ${res.status}`);
  }
}

async function addUserToTenant(token: string, tenantId: string, email: string, name?: string) {
  const res = await fetch(BULK_INVITE_URL(tenantId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      users: [
        {
          email,
          name,
          provider: 'local',
          skipInviteEmail: true,
          // Set verified true only if your environment ensures email verification already occurred
          verified: true,
        },
      ],
    }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Bulk invite failed: ${res.status}`);
}

function deriveTenantNameFromEmail(email: string) {
  const domain = email.split('@')[1]?.toLowerCase() || 'unknown';
  const label = domain.split('.')[0] || domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Accept both shapes:
 *  - { key: 'frontegg.user.signedUp', data: { user: {...}, tenant?: {...} } }
 *  - { eventKey: 'frontegg.user.signedUp', user: {...}, ... }
 */
 function extractEventInfo(payload: unknown) {
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
   const email = user && typeof user['email'] === 'string' ? (user['email'] as string).trim() : undefined;
   const name = user && typeof user['name'] === 'string' ? (user['name'] as string).trim() : undefined;
   const prehookTenantName = tenant && typeof tenant['name'] === 'string' ? (tenant['name'] as string).trim() : undefined;

   return { key, email, name, prehookTenantName };
 }

// ---------- Route

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    return new Response('Invalid signature', { status: 401 });
  }

  let body: unknown;
  try {
    // Use text() then parse: some runtimes lock the body after json()
    body = JSON.parse(await req.text());
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  const { key, email, name, prehookTenantName } = extractEventInfo(body);

  // Only act on signedUp; acknowledge others so Frontegg doesn’t retry
  if (key !== 'frontegg.user.signedUp') {
    return new Response('Ignored', { status: 204 });
  }

  if (!email) {
    // We can't proceed, but return 200 so Frontegg won't retry this event forever
    console.error('frontegg.webhook: signedUp event without email');
    return new Response('No email on event', { status: 200 });
  }

  // Prefer prehook-provided tenant name; otherwise derive from email domain
  const tenantName = prehookTenantName || deriveTenantNameFromEmail(email);

  try {
    const token = await getVendorToken();

    // Find or create tenant
    const existing = await findTenantByName(token, tenantName);
    const tenant = existing ?? (await createTenant(token, tenantName));

    // Optionally ensure app -> tenant assignment
    await ensureAppAssigned(token, tenant.tenantId);

    // Add the user to the tenant silently
    await addUserToTenant(token, tenant.tenantId, email, name);

    return new Response('OK', { status: 200 });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('frontegg.webhook error:', message);
    return new Response('Internal error', { status: 500 });
  }
}
