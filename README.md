## Frontegg Auto-Sort User Invitations – Sample Webhook Service

This repo contains a minimal Next.js API route that demonstrates how to process Frontegg webhooks and automatically sort user invitations into the right account (tenant), then optionally take follow‑up actions.

### What it does (high level)
- Verifies incoming webhook requests using a shared secret via header `x-webhook-secret`.
- Handles the `frontegg.user.invitedToTenant` event.
- Filters webhooks to only process those from a specific target tenant ID.
- Determines a target tenant name (from the user's email domain).
- Ensures the target tenant exists and optionally assigns your default application to it.
- Adds the user to the target tenant.
- Removes the user from a default "source" tenant.
- If the event's `applicationId` matches your default application and the user is not the first member in the target tenant, automatically disables the user in that tenant.

### API route
- Endpoint: `POST /api/webhooks/frontegg`
- File: `src/app/api/webhooks/frontegg/route.ts`

### Environment variables
- Required
  - `FRONTEGG_CLIENT_ID`: Your Frontegg Client ID
  - `FRONTEGG_API_KEY`: Your Frontegg API Key (Vendor Secret)
  - `FRONTEGG_WEBHOOK_SECRET`: Shared secret for webhooks. Incoming requests must include it in `x-webhook-secret`.
  - `FRONTEGG_REGION_BASE`: Frontegg API base (e.g. `https://api.frontegg.com`)
  - `DEFAULT_SRC_TENANT_ID`: The tenant ID to filter webhooks for and the source tenant from which users are removed
- Optional
  - `DEFAULT_APP_ID`: Application to match against `eventContext.applicationId` for the auto‑disable rule
  - `DRY_RUN=1`: Log intended actions without calling external APIs

### Processing steps (in order)
1) Verify signature
   - Check `x-webhook-secret` against `FRONTEGG_WEBHOOK_SECRET` (PSK or HS‑signed JWT).
2) Parse and extract
   - Read `eventKey`, `user`, and `eventContext` from the payload.
   - Extract `tenantId` from `eventContext.tenantId` only.
3) Filter by event type
   - Ignore events that are not `frontegg.user.invitedToTenant`.
4) Filter by tenant ID
   - Only process webhooks where the tenant ID matches `DEFAULT_SRC_TENANT_ID`.
5) Determine target tenant
   - Use prehook name when present; otherwise derive from email domain.
6) Ensure tenant and assign app
   - Find or create tenant, then assign `DEFAULT_APP_ID` if provided.
7) Add user to tenant
   - `POST /identity/resources/users/v1/{userId}/tenant` with target tenant.
8) Remove user from source tenant
   - `DELETE /identity/resources/users/v1/{userId}` with header `frontegg-tenant-id: DEFAULT_SRC_TENANT_ID`.
9) Optional auto‑disable
   - If the target tenant already has at least one user, call
     `POST /identity/resources/tenants/users/v1/{userId}/disable` with `frontegg-tenant-id: {targetTenantId}`.

Notes:
- Listing tenant users uses `/identity/resources/users/v3` with header `frontegg-tenant-id` and pagination (`offset=1&limit=1`) to check for a second user efficiently.
- All external calls use the Vendor token obtained from `POST /auth/vendor` with `FRONTEGG_CLIENT_ID` and `FRONTEGG_API_KEY`.

### Run locally
```bash
npm install
npm run dev
# Server will run on http://localhost:3000 by default (or your configured port)
```

### Test with curl (PSK in x-webhook-secret)
Replace placeholders with your values.
```bash
curl -X POST 'http://localhost:3000/api/webhooks/frontegg' \
  -H 'Content-Type: application/json' \
  -H "x-webhook-secret: $FRONTEGG_WEBHOOK_SECRET" \
  -d '{
    "eventKey": "frontegg.user.invitedToTenant",
    "user": { "id": "<USER_ID>", "email": "user@example.com" },
    "eventContext": { "userId": "<USER_ID>", "tenantId": "<DEFAULT_SRC_TENANT_ID>" }
  }'
```

### Development notes
- The handler only checks `x-webhook-secret`. If you use JWT, sign it with `FRONTEGG_WEBHOOK_SECRET` and put it in that header.
- Set `DRY_RUN=1` to verify behavior without making external API calls.
- Logs show each step for easier debugging.
