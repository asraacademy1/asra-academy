# ASRA Academy — Production Environment (PHASE 17)

Version 0.1.0 · Inventory taken 2026-10-28 from `vercel env ls` (names and scopes only; **no value was read or printed**). Variable reference: [`.env.example`](../.env.example), README "Environment variables". Validation: `apps/api/src/config/env.ts` (API refuses to start on invalid configuration).

Secrets live **only** in Vercel project settings. Never in the repository, chat, tickets or logs. Server-only values never use a `NEXT_PUBLIC_` prefix.

## 1. API — Vercel project `api-asra-academy`

| Variable                                                                                                                                         | Required                           | Present | Scope today               | Expected production value / note                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                                                                                       | Yes                                | ✅      | Production, **Preview**   | `production`                                                                                             |
| `LOG_LEVEL`                                                                                                                                      | No                                 | ✅      | Production, Preview       | `info`                                                                                                   |
| `DATABASE_URL`                                                                                                                                   | Yes                                | ✅      | Production, **Preview** ⚠ | Neon **pooled** URL of the production DB — Production only (B1)                                          |
| `DIRECT_DATABASE_URL`                                                                                                                            | Yes                                | ✅      | Production, **Preview** ⚠ | Neon **direct** URL (migrations) — Production only (B1)                                                  |
| `REDIS_URL`                                                                                                                                      | Yes (prod)                         | ✅      | Production, **Preview** ⚠ | Shared hosted Redis, `rediss://` — Production only                                                       |
| `JWT_SECRET`                                                                                                                                     | Yes                                | ✅      | Production, **Preview** ⚠ | ≥ 32 random chars, unique to production (B1)                                                             |
| `NEXT_PUBLIC_APP_URL`                                                                                                                            | Yes                                | ✅      | Production, Preview       | Canonical web origin — see B4 (currently apex)                                                           |
| `CORS_ORIGINS`                                                                                                                                   | Recommended                        | ✅      | Production, Preview       | Verified: allows `https://www.asraacademy.in` and `https://asraacademy.in`, refuses others               |
| `EMAIL_TRANSPORT`                                                                                                                                | Yes (prod)                         | ✅      | Production                | `resend` (production refuses anything else)                                                              |
| `EMAIL_FROM`                                                                                                                                     | Yes (prod)                         | ✅      | Production, Preview       | `Name <address@verified-domain>` — value **not confirmed** (B5)                                          |
| `EMAIL_API_KEY`                                                                                                                                  | Yes (prod)                         | ✅      | Production, Preview       | Resend key, sending access only; separate key for Preview                                                |
| `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_ACCESS_TTL_MINUTES`, `REFRESH_SESSION_TTL_DAYS`, `PASSWORD_RESET_TTL_MINUTES`, `EMAIL_VERIFICATION_TTL_HOURS` | No                                 | —       | —                         | Defaults apply (15 min / 30 days …)                                                                      |
| `AUTH_COOKIE_SECURE`                                                                                                                             | No                                 | —       | —                         | Defaults to `true` in production (enforced)                                                              |
| `AUTH_COOKIE_SAME_SITE`                                                                                                                          | No                                 | —       | —                         | Default `strict` — keep                                                                                  |
| `AUTH_COOKIE_DOMAIN`                                                                                                                             | No                                 | —       | —                         | Empty (host-only)                                                                                        |
| `RATE_LIMIT_STORE`                                                                                                                               | No                                 | —       | —                         | Default `redis`                                                                                          |
| `DATABASE_POOL_MAX`                                                                                                                              | No                                 | —       | —                         | Default 10 per instance; lower (e.g. 3–5) if Neon connection limits are reached under serverless fan-out |
| `RAZORPAY_MODE`                                                                                                                                  | For payments                       | —       | —                         | **Empty** = checkout disabled (current). `live` only after B9                                            |
| `RAZORPAY_LIVE_KEY_ID`, `RAZORPAY_LIVE_KEY_SECRET`, `RAZORPAY_LIVE_WEBHOOK_SECRET`                                                               | With `live`                        | —       | —                         | Production only. Webhook URL `https://api.asraacademy.in/api/v1/payments/webhooks/razorpay/live`         |
| `RAZORPAY_TEST_*`, `RAZORPAY_ALLOW_TEST_MODE_IN_PRODUCTION`                                                                                      | Never in production (staging only) | —       | —                         | Keep test keys **only** while settling old test orders                                                   |
| `PAYMENT_ORDER_TTL_MINUTES`                                                                                                                      | No                                 | —       | —                         | Default 30                                                                                               |
| `GOOGLE_MEET_CLIENT_ID`, `…_CLIENT_SECRET`, `…_REFRESH_TOKEN`                                                                                    | Optional (all or none)             | —       | —                         | Empty = manual links (current; AE-01/AE-02)                                                              |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`                                                                           | Yes (prod)                         | —       | —                         | Required in production for recruitment resume uploads (Render ephemeral storage guard). Server-only      |
| `WHATSAPP_API_KEY`                                                                                                                               | Not used                           | —       | —                         | Do not set (feature not approved / pending client confirmation P-02)                                     |

Not applicable on Vercel: `PORT` (platform-assigned), `POSTGRES_*`, `REDIS_PORT`, `TEST_DATABASE_URL`.

The variable is `DIRECT_DATABASE_URL` (not `DIRECT_URL`). There is **no** Sentry DSN or analytics variable in the code base; do not add unused variables.

## 2. Web — Vercel project `asra-academy`

`NEXT_PUBLIC_*` values are inlined **at build time**. Changing them requires a redeploy.

| Variable                      | Required  | Present | Scope today | Expected production value / note                                                      |
| ----------------------------- | --------- | ------- | ----------- | ------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`         | Yes       | ✅      | Production  | Canonical origin — B4                                                                 |
| `NEXT_PUBLIC_API_URL`         | Yes       | ✅      | Production  | `https://api.asraacademy.in/api/v1` (verified via CSP `connect-src`)                  |
| `ENABLE_DESIGN_SYSTEM`        | No        | ✅ ⚠    | Production  | **Must be empty in production** (B3)                                                  |
| `SITE_INDEXING_ENABLED`       | At launch | —       | —           | Empty until launch (B11). Build fails if `true` with a non-https / `*.vercel.app` URL |
| `NEXT_PUBLIC_WHATSAPP_NUMBER` | Optional  | —       | —           | Empty until the academy supplies it (P-02)                                            |

Preview has **no** web variables, so preview builds use code defaults (localhost API). Give Preview its own staging values (UAT-ACCESS-SETUP §1.4).

## 3. Platform settings

| Setting                         | Web                      | API  | Note                                                                                                             |
| ------------------------------- | ------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------- |
| Node.js                         | 24.x                     | 22.x | Align API to 24.x (`.nvmrc`) — B8                                                                                |
| Region                          | iad1                     | iad1 | Neon region should be close to iad1 to avoid cross-region latency on every query. Confirm the Neon region (W-02) |
| Deployment Protection (Preview) | On (302 to Vercel login) | On   | Keep                                                                                                             |

## 4. Separating environments (B1 — procedure, not yet performed)

1. Create a Neon branch or separate project for preview/staging (from an empty parent, not from production data unless anonymised and approved).
2. For each API variable listed as "Production, Preview": edit it so it applies to **Production only**, then add separate Preview values (preview DB, preview Redis or a separate Redis DB, new `JWT_SECRET`, separate Resend key).
3. Redeploy one preview to confirm it works against the preview DB.
4. Rotate the production `JWT_SECRET` (§5), because previews have had access to it.

## 5. Credential rotation

| Credential                     | How                                                                                                                                                                     | User impact                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`                   | Generate new value (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` on the operator machine; paste directly into Vercel). Redeploy API | Existing access tokens invalid (≤ 15 min); refresh sessions are DB-stored and unaffected. Plan out of teaching hours |
| Neon password                  | Reset role password in Neon → update both DB URLs → redeploy API                                                                                                        | Brief errors between reset and redeploy; do it in a quiet window                                                     |
| Redis                          | Rotate in provider → update `REDIS_URL` → redeploy                                                                                                                      | Rate-limit counters reset                                                                                            |
| Resend key                     | Create new key → update `EMAIL_API_KEY` → redeploy → revoke old key                                                                                                     | None                                                                                                                 |
| Razorpay keys / webhook secret | Generate new keys in the matching mode → update → redeploy → revoke old. Webhook: update secret in dashboard and env together                                           | Payments fail during mismatch; do it with no open checkouts                                                          |
| Google refresh token           | Re-run the consent flow (LIVE-CLASSES §4.3) → update → redeploy                                                                                                         | Automatic links fail until updated                                                                                   |

Never paste a credential into chat, a commit, an issue or a log. After any suspected exposure, rotate first, then investigate.
