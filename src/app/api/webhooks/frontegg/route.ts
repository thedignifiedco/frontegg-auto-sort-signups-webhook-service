// app/api/webhooks/frontegg/route.ts
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type FronteggEvent = {
  key: string; // e.g., "frontegg.user.signedUp"
  id?: string;
  createdAt?: string;
  data: {
    user?: { id?: string; email?: string; name?: string };
    tenant?: { id?: string | null; name?: string | null } | null;
  };
};

const REGION = process.env.FRONTEGG_REGION_BASE ?? 'https://api.frontegg.com';
const VENDOR_AUTH_URL = `${REGION}/auth/vendor`;
const TENANTS_URL_V2 = `${REGION}/tenants/resources/tenants/v2`;
const TENANTS_URL_V1 = `${REGION}/tenants/resources/tenants/v1`;
const APPLICATIONS_BASE = `${REGION}/applications/resources/applications`;
const APP_TENANT_ASSIGNMENTS = (appId: string) =>
  `${APPLICATIONS_BASE}/tenant-assignments/v1/${appId}`;
const BULK_INVITES_URL = (tenantId: string) =>
  `${REGION}/identity/resources/tenants/invites/v1/bulk/${tenantId}`;

function verifyWebhook(req: NextRequest) {
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
  const res = await fetch(VENDOR_AUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, secret }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Vendor auth failed: ${res.status}`);
  const json = (await res.json()) as { token: string };
  if (!json?.token) throw new Error('Vendor token missing');
  return json.token;
}

async function findTenantByName(token: string, name: string) {
  const url = new URL(TENANTS_URL_V2);
  // Free-text filter; _limit=1 for speed
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
  const res = await fetch(TENANTS_URL_V1, {
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

async function ensureAppAssignedToTenant(token: string, tenantId: string) {
  const appId = process.env.DEFAULT_APP_ID;
  if (!appId) return;
  const res = await fetch(APP_TENANT_ASSIGNMENTS(appId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tenantId }),
    cache: 'no-store',
  });
  // 200/201 = ok; 409 (already assigned) is fine, treat as success
  if (!res.ok && res.status !== 409) {
    throw new Error(`Assign app->tenant failed: ${res.status}`);
  }
}

async function addUserToTenantByEmail(
  token: string,
  tenantId: string,
  email: string,
  name?: string
) {
  const res = await fetch(BULK_INVITES_URL(tenantId), {
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
          verified: true, // set to true only if your env verifies before this event
        },
      ],
    }),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Bulk invite failed: ${res.status}`);
  }
}

function deriveTenantNameFromEmail(email: string) {
  const domain = email.split('@')[1]?.toLowerCase() || 'unknown';
  const label = domain.split('.')[0] || domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export async function POST(req: NextRequest) {
  if (!verifyWebhook(req)) {
    return new Response('Invalid signature', { status: 401 });
  }

  let event: FronteggEvent | undefined;
  try {
    event = JSON.parse(await req.text());
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  if (!event || event.key !== 'frontegg.user.signedUp') {
    // Acknowledge other events to avoid retries
    return new Response('Ignored', { status: 204 });
  }

  const email = event.data?.user?.email?.trim();
  const name = event.data?.user?.name ?? undefined;
  if (!email) {
    // Nothing we can do; acknowledge to prevent retries, but note the problem.
    console.error('webhook: signedUp without email');
    return new Response('No email', { status: 200 });
  }

  // Prefer a tenant name provided by the prehook; otherwise derive from email domain
  const preferredTenantName =
    event.data?.tenant?.name?.trim() || deriveTenantNameFromEmail(email);

  try {
    const token = await getVendorToken();

    // Find or create tenant
    const existing = await findTenantByName(token, preferredTenantName);
    const tenant = existing ?? (await createTenant(token, preferredTenantName));

    // (Optional) Assign app to tenant
    await ensureAppAssignedToTenant(token, tenant.tenantId);

    // Add user to tenant silently
    await addUserToTenantByEmail(token, tenant.tenantId, email, name);

    return new Response('OK', { status: 200 });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('frontegg webhook error:', message);
    return new Response('Internal error', { status: 500 });
  }
}