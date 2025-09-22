## Frontegg Auto-Sort Signups – Sample Webhook Service

This repo contains a minimal Next.js API route that demonstrates how to process Frontegg webhooks and automatically sort new signups into the right account (tenant), then optionally take follow‑up actions.

### What it does (high level)
- Verifies incoming webhook requests using a shared secret via header `x-webhook-secret`.
- Handles the `frontegg.user.signedUp` event.
- Determines a target tenant name (from the user’s email domain).
- Ensures the target tenant exists and optionally assigns your default application to it.
- Adds the user to the target tenant.
- Removes the user from a default “source” tenant.
- If the event’s `applicationId` matches your default application and the user is not the first member in the target tenant, automatically disables the user in that tenant.

### API route
- Endpoint: `POST /api/webhooks/frontegg`
- File: `src/app/api/webhooks/frontegg/route.ts`

### Environment variables
- Required
  - `FRONTEGG_CLIENT_ID`: Your Frontegg Client ID
  - `FRONTEGG_API_KEY`: Your Frontegg API Key (Vendor Secret)
  - `FRONTEGG_WEBHOOK_SECRET`: Shared secret for webhooks. Incoming requests must include it in `x-webhook-secret`.
  - `FRONTEGG_REGION_BASE`: Frontegg API base (e.g. `https://api.frontegg.com`)
- Optional
  - `DEFAULT_APP_ID`: Application to match against `eventContext.applicationId` for the auto‑disable rule
  - `DEFAULT_SRC_TENANT_ID`: The default/source tenant from which users are removed after being added to the target tenant
  - `DRY_RUN=1`: Log intended actions without calling external APIs

### Processing steps (in order)
1) Verify signature
   - Check `x-webhook-secret` against `FRONTEGG_WEBHOOK_SECRET` (PSK or HS‑signed JWT).
2) Parse and extract
   - Read `eventKey`, `user`, and `eventContext` (uses `eventContext.userId` and `eventContext.applicationId`).
3) Filter
   - Ignore events that are not `frontegg.user.signedUp`.
4) Determine target tenant
   - Use prehook name when present; otherwise derive from email domain.
5) Ensure tenant and assign app
   - Find or create tenant, then assign `DEFAULT_APP_ID` if provided.
6) Add user to tenant
   - `POST /identity/resources/users/v1/{userId}/tenant` with target tenant.
7) Remove user from default tenant
   - `DELETE /identity/resources/users/v1/{userId}` with header `frontegg-tenant-id: DEFAULT_SRC_TENANT_ID`.
8) Optional auto‑disable
   - If `eventContext.applicationId === DEFAULT_APP_ID` and the target tenant already has at least one user, call
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
    "eventKey": "frontegg.user.signedUp",
    "user": { "id": "<USER_ID>", "email": "user@example.com" },
    "eventContext": { "userId": "<USER_ID>", "applicationId": "<APP_ID>" }
  }'
```

### Development notes
- The handler only checks `x-webhook-secret`. If you use JWT, sign it with `FRONTEGG_WEBHOOK_SECRET` and put it in that header.
- Set `DRY_RUN=1` to verify behavior without making external API calls.
- Logs show each step for easier debugging.
