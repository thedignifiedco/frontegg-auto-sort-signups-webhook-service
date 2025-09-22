// app/api/webhooks/frontegg/route.ts
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type FronteggEvent = {
  key: string; // e.g., "frontegg.user.signedUp"
  createdAt?: string;
  id?: string; // delivery/event id if present
  data: {
    user?: { id?: string; email?: string; name?: string };
    // other fields possible
  };
};

// -------- Helpers

const REGION = process.env.FRONTEGG_REGION_BASE ?? 'https://api.frontegg.com';
const VENDOR_AUTH_URL = `${REGION}/auth/vendor`;
const TENANTS_URL = `${REGION}/tenants/resources/tenants`;
const GET_TENANTS_V2 = `${TENANTS_URL}/v2`; // supports filtering
const CREATE_TENANT_V1 = `${TENANTS_URL}/v1`; // POST
const APPLICATIONS_BASE = `${REGION}/applications/resources/applications`;
const APP_TENANT_ASSIGNMENTS = (appId: string) =>
  `${APPLICATIONS_BASE}/tenant-assignments/v1/${appId}`;

// Bulk invite (adds users by email to a tenant; vendor token auth)
const BULK_INVITES_URL = (tenantId: string) =>
  `${REGION}/identity/resources/tenants/invites/v1/bulk/${tenantId}`;

async function getVendorToken() {
  const res = await fetch(VENDOR_AUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: process.env.FRONTEGG_CLIENT_ID,
      secret: process.env.FRONTEGG_API_KEY,
    }),
  });
  if (!res.ok) throw new Error(`Vendor auth failed: ${res.status}`);
  const json = (await res.json()) as { token: string };
  return json.token;
}

function domainToTenantName(email: string) {
  const domain = email.split('@')[1]?.toLowerCase() ?? 'unknown';
  // Handle multi-label domains (e.g., example.co.uk → "Example")
  const firstLabel = domain.split('.').at(0) ?? domain;
  const pretty =
    firstLabel.length > 2 ? firstLabel : domain.replace(/\..*/, '');
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

// Optional overrides: direct certain domains to fixed tenant names
const DOMAIN_OVERRIDES: Record<string, string> = {
  // 'gmail.com': 'Personal', // example
};

async function findTenantByName(token: string, name: string) {
  // The v2 list endpoint supports filtering/sorting and pagination.
  // We'll do a simple filter by name.
  const url = new URL(GET_TENANTS_V2);
  url.searchParams.set('_filter', name); // free-text matches on name or tenantId
  url.searchParams.set('_limit', '1');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Get tenants failed: ${res.status}`);
  const json = await res.json();
  const items = Array.isArray(json?.items) ? json.items : json;
  return items?.[0] as { tenantId: string; name: string } | undefined;
}

async function createTenant(token: string, name: string) {
  // POST /tenants/resources/tenants/v1
  // We let Frontegg auto-generate the tenantId. You could also set tenantId.
  const payload = {
    name,
    // optional: website, applicationUrl, logoUrl, metadata, etc.
  };
  const res = await fetch(CREATE_TENANT_V1, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Create tenant failed: ${res.status}`);
  return (await res.json()) as { tenantId: string; name: string };
}

async function ensureAppAssignedToTenant(token: string, tenantId: string) {
  const appId = process.env.DEFAULT_APP_ID;
  if (!appId) return; // skip if you don't want to manage app assignments here

  // POST /applications/resources/applications/tenant-assignments/v1/{appId}
  const res = await fetch(APP_TENANT_ASSIGNMENTS(appId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tenantId }),
  });
  // 200/201 ok, 409 if already assigned – treat as success.
  if (!res.ok && res.status !== 409) {
    throw new Error(`Assign app->tenant failed: ${res.status}`);
  }
}

async function addUserToTenantByEmail(token: string, tenantId: string, email: string, name?: string) {
  // Bulk invites can add existing users to a new tenant OR create them if missing.
  // We'll set skipInviteEmail so it's silent.
  // POST identity/resources/tenants/invites/v1/bulk/{tenantId}
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
          verified: true, // if your environment is using email verification and webhook comes after verification
        },
      ],
    }),
  });

  if (!res.ok) {
    // If user already in tenant, bulk status may return CompletedWithErrors,
    // but this POST usually responds with a task id.
    // We still check the status code and ignore 409-ish flows.
    throw new Error(`Bulk invite failed: ${res.status}`);
  }
}

function verifyWebhook(req: NextRequest) {
  // Frontegg sets x-webhook-secret with the value you configured in the portal.
  // For most setups, a simple equality check is fine (PSK scheme).
  // If you adopted JWT-style secrets per docs example, you’d verify the JWT instead.
  const incoming = req.headers.get('x-webhook-secret') || '';
  const expected = process.env.FRONTEGG_WEBHOOK_SECRET || '';
  return incoming && expected && incoming === expected;
}

// -------- Main handler

export async function POST(req: NextRequest) {
  const raw = await req.text();

  if (!verifyWebhook(req)) {
    return new Response('Invalid signature', { status: 401 });
  }

  let event: FronteggEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  if (event.key !== 'frontegg.user.signedUp') {
    // Acknowledge other events to avoid retries
    return new Response('Ignored', { status: 204 });
  }

  const email = event.data?.user?.email;
  const name = event.data?.user?.name;
  if (!email) {
    return new Response('No email on payload', { status: 400 });
  }

  // 1) Compute target tenant name
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  const targetName = DOMAIN_OVERRIDES[domain] ?? domainToTenantName(email);

  try {
    // 2) Vendor token
    const token = await getVendorToken();

    // 3) Find or create tenant
    const existing = await findTenantByName(token, targetName);
    const tenant = existing ?? (await createTenant(token, targetName));

    // 4) (Optional) Ensure your default app is assigned to this tenant
    await ensureAppAssignedToTenant(token, tenant.tenantId);

    // 5) Add user to tenant silently (works even if user already exists)
    await addUserToTenantByEmail(token, tenant.tenantId, email, name ?? undefined);

    return new Response('OK', { status: 200 });
  } catch (e: unknown) {
    // Log minimal details (avoid leaking secrets)
    const message = e instanceof Error ? e.message : String(e);
    console.error('frontegg webhook error:', message);
    return new Response('Internal error', { status: 500 });
  }
}
