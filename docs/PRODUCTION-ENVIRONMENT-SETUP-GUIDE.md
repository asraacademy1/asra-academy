# ASRA Academy — Production Environment Setup & Deployment Audit

**Document:** `docs/PRODUCTION-ENVIRONMENT-SETUP-GUIDE.md`  
**Audit Type:** Read-Only Production Deployment & Environment Audit  
**Target Release:** Private Beta (Developer & Client Testing)  
**Target Architecture:**

- **Frontend:** Vercel (Next.js 16)
- **Backend API:** Render Web Service (Node.js 22+ / Express 5)
- **Database:** Neon Serverless PostgreSQL 17
- **In-Memory Cache / Rate Limiting:** Upstash Redis
- **File Storage:** Cloudinary
- **Transactional Email:** Resend
- **Payment Gateway:** Razorpay (Test Mode in Production)
- **Live Classes:** Google Meet REST API (Optional / Staff fallback)
- **DNS:** Custom Domain Provider (`asraacademy.in`)

---

## Table of Contents

1. [Executive Summary & Architectural Overview](#1-executive-summary--architectural-overview)
2. [Master Environment Variable Inventory](#2-master-environment-variable-inventory)
3. [Deep-Dive Code & Implementation Verification](#3-deep-dive-code--implementation-verification)
   - [3.1 Database Connection Pooling: `DATABASE_URL` vs `DIRECT_DATABASE_URL` vs `DIRECT_URL`](#31-database-connection-pooling-database_url-vs-direct_database_url-vs-direct_url)
   - [3.2 Render Runtime & `PORT` Handling](#32-render-runtime--port-handling)
   - [3.3 Browser vs Server Exposure (`NEXT_PUBLIC_*`)](#33-browser-vs-server-exposure-next_public_)
   - [3.4 Authentication, Session Tokens & Cookie Security](#34-authentication-session-tokens--cookie-security)
   - [3.5 Cross-Origin Resource Sharing (CORS) & CSRF Allow-Listing](#35-cross-origin-resource-sharing-cors--csrf-allow-listing)
   - [3.6 Redis & Upstash TLS Enforcement (`rediss://`)](#36-redis--upstash-tls-enforcement-rediss)
   - [3.7 File Storage: The Cloudinary Integration Discrepancy](#37-file-storage-the-cloudinary-integration-discrepancy)
   - [3.8 Email Delivery: Resend & Domain Verification](#38-email-delivery-resend--domain-verification)
   - [3.9 Razorpay Test Mode & Webhook Architecture](#39-razorpay-test-mode--webhook-architecture)
   - [3.10 Google Meet REST API & OAuth Token Lifecycles](#310-google-meet-rest-api--oauth-token-lifecycles)
   - [3.11 Build-Time Search Engine Indexing (`SITE_INDEXING_ENABLED`)](#311-build-time-search-engine-indexing-site_indexing_enabled)
4. [Provider-by-Provider Configuration Guide](#4-provider-by-provider-configuration-guide)
   - [4.1 Neon PostgreSQL](#41-neon-postgresql)
   - [4.2 Upstash Redis](#42-upstash-redis)
   - [4.3 Cloudinary Object Storage](#43-cloudinary-object-storage)
   - [4.4 Resend Email](#44-resend-email)
   - [4.5 Razorpay (Test Mode)](#45-razorpay-test-mode)
   - [4.6 Google Cloud / Google Meet OAuth](#46-google-cloud--google-meet-oauth)
   - [4.7 Render (API Web Service)](#47-render-api-web-service)
   - [4.8 Vercel (Next.js Web Frontend)](#48-vercel-nextjs-web-frontend)
   - [4.9 DNS & Custom Domain Provider](#49-dns--custom-domain-provider)
5. [Database Deployment, Migration & Seeding Safety](#5-database-deployment-migration--seeding-safety)
6. [Security Audit, Infrastructure Limitations & Production Readiness](#6-security-audit-infrastructure-limitations--production-readiness)
7. [Step-by-Step Deployment Execution Order](#7-step-by-step-deployment-execution-order)
8. [Integration Testing & Verification Checklist](#8-integration-testing--verification-checklist)
9. [Troubleshooting & Common Pitfalls](#9-troubleshooting--common-pitfalls)
10. [Open Clarifications & Client Decisions](#10-open-clarifications--client-decisions)

---

## 1. Executive Summary & Architectural Overview

ASRA Academy is a full-stack educational and learning management platform structured as an npm workspaces monorepo:

- `apps/web`: Next.js 16 (App Router, React 19, Tailwind CSS v4)
- `apps/api`: Express.js 5 modular monolith with Prisma 7 ORM (`@prisma/adapter-pg`)
- `packages/types`: Shared TypeScript definitions
- `packages/validation`: Shared Zod schemas
- `packages/config`: Shared tooling and TypeScript base configs

### Architectural Topology

```text
                                  Internet
                                     │
                    DNS Provider (Apex & Subdomains)
                                     │
           ┌─────────────────────────┴─────────────────────────┐
           │                                                   │
  CNAME / A Records                                      CNAME Record
           │                                                   │
           ▼                                                   ▼
┌──────────────────────┐                             ┌──────────────────────┐
│    Vercel (Edge/CDN) │                             │   Render (Web Svc)   │
│  www.asraacademy.in  │                             │  api.asraacademy.in  │
│                      │                             │                      │
│   Next.js 16 Web     │                             │   Express 5 API      │
│  Prerendered Pages   │                             │  Long-Running Server │
│   Client Bundles     │                             │  3 Background Sweeps │
└──────────┬───────────┘                             └──────────┬───────────┘
           │                                                    │
           │ Browser Direct Calls (credentials: 'include')       │
           └────────────────────────────────────────────────────┼───────────────────────────┐
                                                                │                           │
                                         ┌──────────────────────┼────────────────────┐      │
                                         ▼                      ▼                    ▼      ▼
                                ┌─────────────────┐    ┌─────────────────┐      ┌────────┐ ┌────────┐
                                │ Neon PostgreSQL │    │  Upstash Redis  │      │ Resend │ │Cloudin.│
                                │   (Port 5432)   │    │  (Port 6379)    │      │ (Email)│ │(Resum.)│
                                │ Pooled / Direct │    │ rediss:// (TLS) │      └────────┘ └────────┘
                                └─────────────────┘    └─────────────────┘          ▲          ▲
                                                                │                   │          │
                                                                ▼                   ▼          ▼
                                                       ┌─────────────────┐      ┌────────┐ ┌────────┐
                                                       │  Rate Limiting  │      │Razorpay│ │Google  │
                                                       │ & Auth Counters │      │ (Test) │ │ Meet   │
                                                       └─────────────────┘      └────────┘ └────────┘
```

### Critical Audit Findings Overview

1. **Storage Variable Naming Mismatch:** `.env.example` lists `STORAGE_URL`, `STORAGE_KEY`, and `STORAGE_SECRET`. However, the recruitment module (`apps/api/src/modules/recruitment/resume-storage.service.ts`) explicitly reads `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. If Cloudinary credentials are not supplied using these exact names, resume uploads silently fall back to Render's **ephemeral local disk**, where uploaded files are permanently destroyed upon container sleep, restart, or deployment.
2. **Missing Storage Validation in `env.ts`:** Unlike email, payments, and database settings, `CLOUDINARY_*` variables are not defined or validated in `apps/api/src/config/env.ts`. The API boots without warning when they are omitted.
3. **Database URL Differentiation:** The API uses `@prisma/adapter-pg` driver adapters requiring two separate URLs on Neon:
   - `DATABASE_URL`: Must be the **pooled** connection string (contains `-pooler.`).
   - `DIRECT_DATABASE_URL`: Must be the **direct** connection string (bypasses pooler for migrations).
   - `DIRECT_URL`: **Not used anywhere** in the codebase.
4. **Razorpay Test Mode in Production:** In production (`NODE_ENV=production`), `apps/api/src/config/env.ts` explicitly refuses `RAZORPAY_MODE=test` unless `RAZORPAY_ALLOW_TEST_MODE_IN_PRODUCTION=true` is also provided. Furthermore, in production, `RAZORPAY_TEST_WEBHOOK_SECRET` is strictly mandatory.
5. **Cross-Site Cookie Vulnerabilities on Default Subdomains:** Next.js and Express default to `AUTH_COOKIE_SAME_SITE=strict`. If the private beta is tested using provider default domains (`asra-academy.vercel.app` and `asra-api.onrender.com`), browsers treat these as third-party cross-site origins and will block the refresh-token cookie, breaking authentication. Production testing requires either custom subdomains on `asraacademy.in` or `AUTH_COOKIE_SAME_SITE=none` with `AUTH_COOKIE_SECURE=true`.
6. **Search Indexing Guard:** `SITE_INDEXING_ENABLED=true` fails the Next.js build if `NEXT_PUBLIC_APP_URL` points to localhost, a private IP, or `*.vercel.app`. It must remain unset or `false` during the private beta.

---

## 2. Master Environment Variable Inventory

The table below catalogs every variable discovered across code, build scripts, tests, and configuration files.

| Variable                                 | Service     | Required                  | Purpose                                                                                     | Source / Dashboard                                 | Where to Set                         | Environment            | Exposure                | Dependencies                                                  | Default in Code                         |
| ---------------------------------------- | ----------- | ------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------ | ---------------------- | ----------------------- | ------------------------------------------------------------- | --------------------------------------- |
| `NODE_ENV`                               | API / Web   | Required                  | Controls runtime optimization, logging, cookie security, and transport enforcement          | System / Hosting Platform                          | Render & Vercel Dashboard            | Local & Production     | Server-only             | Enforces `AUTH_COOKIE_SECURE`, `EMAIL_TRANSPORT=resend`       | `'development'`                         |
| `PORT`                                   | API         | Required (auto on Render) | Port Express HTTP server listens on                                                         | Hosting platform (Render assigns dynamically)      | Render Environment                   | Local & Production     | Server-only             | Render sets to 10000                                          | `4000`                                  |
| `LOG_LEVEL`                              | API         | Optional                  | Pino logger minimum severity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) | Developer                                          | Render Environment                   | Local & Production     | Server-only             | None                                                          | `'info'`                                |
| `DATABASE_URL`                           | API / DB    | Required                  | PostgreSQL connection string for runtime queries (Neon Pooled connection with `-pooler`)    | Neon Console (Connection Details -> Pooled)        | Local `.env`, Render                 | Local & Production     | Server-only             | `sslmode=require`                                             | Local Docker default                    |
| `DIRECT_DATABASE_URL`                    | API / DB    | Required                  | PostgreSQL direct connection string for Prisma CLI migrations                               | Neon Console (Connection Details -> Direct)        | Local `.env`, Render, Operator Shell | Local & Production     | Server-only             | Required for `prisma migrate deploy`                          | Falls back to `DATABASE_URL`            |
| `DATABASE_POOL_MAX`                      | API         | Optional                  | Upper bound of per-process `pg` pool connections                                            | Operator                                           | Render Environment                   | Production             | Server-only             | Recommended 5–10 for Neon                                     | `10`                                    |
| `REDIS_URL`                              | API / Redis | Required (Production)     | Redis connection string for distributed rate limiting                                       | Upstash Console (Details -> `rediss://`)           | Local `.env`, Render                 | Local & Production     | Server-only             | Must use `rediss://` for TLS in production                    | `'redis://localhost:6379'`              |
| `RATE_LIMIT_STORE`                       | API         | Optional                  | Storage engine for rate limiting (`redis` or `memory`)                                      | Operator                                           | Render Environment                   | Production             | Server-only             | `REDIS_URL`                                                   | `'redis'` (`'memory'` in tests)         |
| `JWT_SECRET`                             | API         | Required                  | HMAC SHA-256 secret key for signing 15-minute access JWTs (>= 32 chars)                     | Generated by operator via `crypto.randomBytes(48)` | Local `.env`, Render                 | Local & Production     | Server-only             | None                                                          | None (API refuses to boot if unset)     |
| `JWT_ISSUER`                             | API         | Optional                  | JWT `iss` claim verification                                                                | Operator                                           | Render Environment                   | Production             | Server-only             | `JWT_SECRET`                                                  | `'asra-academy-api'`                    |
| `JWT_AUDIENCE`                           | API         | Optional                  | JWT `aud` claim verification                                                                | Operator                                           | Render Environment                   | Production             | Server-only             | `JWT_SECRET`                                                  | `'asra-academy-web'`                    |
| `JWT_ACCESS_TTL_MINUTES`                 | API         | Optional                  | Lifespan of memory-stored access token in minutes                                           | Operator                                           | Render Environment                   | Production             | Server-only             | 1 to 60                                                       | `15`                                    |
| `REFRESH_SESSION_TTL_DAYS`               | API         | Optional                  | Lifespan of database-persisted session in days                                              | Operator                                           | Render Environment                   | Production             | Server-only             | 1 to 90                                                       | `30`                                    |
| `PASSWORD_RESET_TTL_MINUTES`             | API         | Optional                  | Validity of password reset tokens in minutes                                                | Operator                                           | Render Environment                   | Production             | Server-only             | 5 to 1440                                                     | `30`                                    |
| `EMAIL_VERIFICATION_TTL_HOURS`           | API         | Optional                  | Validity of email verification tokens in hours                                              | Operator                                           | Render Environment                   | Production             | Server-only             | 1 to 168                                                      | `24`                                    |
| `AUTH_COOKIE_SECURE`                     | API         | Conditional               | Requires HTTPS for setting the HttpOnly refresh token cookie                                | Operator                                           | Render Environment                   | Production             | Server-only             | Must be `true` in production                                  | `true` when `NODE_ENV=production`       |
| `AUTH_COOKIE_SAME_SITE`                  | API         | Optional                  | SameSite attribute for refresh cookie (`strict`, `lax`, `none`)                             | Operator                                           | Render Environment                   | Production             | Server-only             | If `none`, requires `AUTH_COOKIE_SECURE=true`                 | `'strict'`                              |
| `AUTH_COOKIE_DOMAIN`                     | API         | Optional                  | Domain attribute for refresh cookie                                                         | Operator                                           | Render Environment                   | Production             | Server-only             | Host-only if empty; set to `.asraacademy.in` if sharing       | `undefined` (host-only)                 |
| `NEXT_PUBLIC_APP_URL`                    | Web & API   | Required                  | Canonical URL of the web frontend                                                           | Vercel Project / DNS                               | Vercel & Render                      | Local & Production     | Browser-public & Server | Used for CSP, sitemaps, emails, and CORS default              | `'http://localhost:3000'`               |
| `NEXT_PUBLIC_API_URL`                    | Web         | Required                  | Public base URL of API including `/api/v1` prefix                                           | Render Web Service / DNS                           | Vercel Environment                   | Local & Production     | Browser-public          | Used for web client fetch and CSP `connect-src`               | `'http://localhost:4000/api/v1'`        |
| `CORS_ORIGINS`                           | API         | Recommended               | Comma-separated allow-list of web origins permitted to call API                             | Operator                                           | Render Environment                   | Production             | Server-only             | Matches web origin(s)                                         | `[NEXT_PUBLIC_APP_URL]`                 |
| `ENABLE_DESIGN_SYSTEM`                   | Web         | Optional                  | When `'true'`, serves `/design-system` in production                                        | Operator                                           | Vercel Environment                   | Production             | Server-only (Web SSR)   | Must be left unset/empty in launch prod                       | `false` in production                   |
| `SITE_INDEXING_ENABLED`                  | Web         | Optional                  | When `'true'`, enables robots indexing & sitemaps                                           | Operator                                           | Vercel Environment (Build-time)      | Production Launch Only | Server-only (Web Build) | Fails build if `NEXT_PUBLIC_APP_URL` is not https live domain | `false`                                 |
| `CLOUDINARY_CLOUD_NAME`                  | API         | Required (Careers)        | Cloudinary cloud account identifier                                                         | Cloudinary Dashboard                               | Render Environment                   | Production             | Server-only             | `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`                 | `undefined` (falls back to local disk!) |
| `CLOUDINARY_API_KEY`                     | API         | Required (Careers)        | Cloudinary API access key                                                                   | Cloudinary Dashboard                               | Render Environment                   | Production             | Server-only             | `CLOUDINARY_CLOUD_NAME`                                       | `undefined`                             |
| `CLOUDINARY_API_SECRET`                  | API         | Required (Careers)        | Cloudinary API secret for raw PDF signing                                                   | Cloudinary Dashboard                               | Render Environment                   | Production             | Server-only             | `CLOUDINARY_API_KEY`                                          | `undefined`                             |
| `RAZORPAY_MODE`                          | API         | Conditional               | Active payment mode for new orders (`test` or `live`). Unset disables checkout              | Razorpay Dashboard                                 | Render Environment                   | Production (Beta)      | Server-only             | `RAZORPAY_TEST_*` or `RAZORPAY_LIVE_*`                        | `undefined` (checkout disabled)         |
| `RAZORPAY_TEST_KEY_ID`                   | API         | Conditional               | Razorpay Test API Key ID (must start with `rzp_test_`)                                      | Razorpay Dashboard (Test Mode)                     | Render Environment                   | Production (Beta)      | Server-only             | Required if `RAZORPAY_MODE=test`                              | `undefined`                             |
| `RAZORPAY_TEST_KEY_SECRET`               | API         | Conditional               | Razorpay Test API Key Secret                                                                | Razorpay Dashboard (Test Mode)                     | Render Environment                   | Production (Beta)      | Server-only             | Paired with `RAZORPAY_TEST_KEY_ID`                            | `undefined`                             |
| `RAZORPAY_TEST_WEBHOOK_SECRET`           | API         | Conditional               | Shared secret for verifying test webhook HMAC signatures                                    | Razorpay Dashboard (Webhooks)                      | Render Environment                   | Production (Beta)      | Server-only             | Required in production if `RAZORPAY_MODE=test`                | `undefined`                             |
| `RAZORPAY_ALLOW_TEST_MODE_IN_PRODUCTION` | API         | Conditional               | Explicit override allowing test mode when `NODE_ENV=production`                             | Operator                                           | Render Environment                   | Production (Beta)      | Server-only             | Mandatory when `NODE_ENV=production` & `RAZORPAY_MODE=test`   | `undefined`                             |
| `PAYMENT_ORDER_TTL_MINUTES`              | API         | Optional                  | Lifespan of an unpaid Razorpay checkout order in minutes                                    | Operator                                           | Render Environment                   | Production             | Server-only             | 5 to 1440                                                     | `30`                                    |
| `EMAIL_TRANSPORT`                        | API         | Required (Production)     | Email delivery adapter (`console`, `memory`, `resend`)                                      | Operator                                           | Render Environment                   | Production             | Server-only             | Production strictly requires `resend`                         | `'console'` (`'memory'` in tests)       |
| `EMAIL_API_KEY`                          | API         | Required (Production)     | Resend API authorization key (starts with `re_`)                                            | Resend Dashboard (API Keys)                        | Render Environment                   | Production             | Server-only             | Required when `EMAIL_TRANSPORT=resend`                        | `undefined`                             |
| `EMAIL_FROM`                             | API         | Required (Production)     | Default email sender name & address (e.g. `ASRA <no-reply@domain>`)                         | Operator / Resend Verified Domain                  | Render Environment                   | Production             | Server-only             | Must use verified domain in production                        | `'ASRA Academy <no-reply@localhost>'`   |
| `GOOGLE_MEET_CLIENT_ID`                  | API         | Optional                  | Google OAuth 2.0 Web Client ID                                                              | Google Cloud Console (Credentials)                 | Render Environment                   | Production             | Server-only             | Set together with Secret & Refresh Token                      | `undefined` (manual links only)         |
| `GOOGLE_MEET_CLIENT_SECRET`              | API         | Optional                  | Google OAuth 2.0 Web Client Secret                                                          | Google Cloud Console (Credentials)                 | Render Environment                   | Production             | Server-only             | Paired with Client ID                                         | `undefined`                             |
| `GOOGLE_MEET_REFRESH_TOKEN`              | API         | Optional                  | OAuth refresh token with `meetings.space.created` scope                                     | Google OAuth 2.0 Playground                        | Render Environment                   | Production             | Server-only             | Paired with Client ID and Secret                              | `undefined`                             |
| `NEXT_PUBLIC_WHATSAPP_NUMBER`            | Web         | Optional                  | Official WhatsApp support telephone number (country code + digits)                          | Client / Operations                                | Vercel Environment                   | Production             | Browser-public          | Strips spaces, hyphens, and `+`                               | `undefined` (CTA button hidden)         |
| `NEW_USER_PASSWORD`                      | API CLI     | Optional                  | Non-interactive password injection for `npm run auth:create-user`                           | Operator                                           | Shell Environment only               | Production Setup CLI   | Server-only             | Avoids terminal history exposure                              | Prompts hidden interactive input        |
| `PROBE_API_URL`                          | Scripts     | Optional                  | Override API URL for `scripts/production-probe.mjs`                                         | Operator / GitHub Actions                          | CI / Workflow Environment            | Production Monitoring  | Server-only             | None                                                          | `'https://api.asraacademy.in'`          |
| `PROBE_WEB_URL`                          | Scripts     | Optional                  | Override Web URL for `scripts/production-probe.mjs`                                         | Operator / GitHub Actions                          | CI / Workflow Environment            | Production Monitoring  | Server-only             | None                                                          | `'https://www.asraacademy.in'`          |

### Non-Production & Legacy Discovered Variables

- `STORAGE_URL`, `STORAGE_KEY`, `STORAGE_SECRET`: Listed in `.env.example` under object storage, but **never read by application code**. Replaced by `CLOUDINARY_*`.
- `WHATSAPP_API_KEY`: Listed in `.env.example` as a placeholder for WhatsApp Business API, but **unused in current code**.
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`: Used only by `docker-compose.yml` for local development.
- `REDIS_PORT`: Used only by `docker-compose.yml` for local development.
- `TEST_DATABASE_URL`, `TEST_LOG_LEVEL`: Used only by local test runner (`npm test -w @asra/api`).
- `MYSQL_*`, `SQLSERVER_*`, `TURSO_*`, `PRISMA_API_TOKEN`: Discovered in `.agents/skills` reference documentation; not part of the active codebase.

---

## 3. Deep-Dive Code & Implementation Verification

### 3.1 Database Connection Pooling: `DATABASE_URL` vs `DIRECT_DATABASE_URL` vs `DIRECT_URL`

**Code Verification:**

- `apps/api/src/database/prisma.ts`:
  ```typescript
  export function createPrismaClient(connectionString: string = env.DATABASE_URL): PrismaClient {
    const adapter = new PrismaPg({
      connectionString,
      max: env.DATABASE_POOL_MAX, // Default 10
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    return new PrismaClient({ adapter, ... });
  }
  ```
- `apps/api/prisma.config.ts`:
  ```typescript
  const migrationUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
    ...(migrationUrl ? { datasource: { url: migrationUrl } } : {}),
  });
  ```
- `apps/api/src/config/env.ts` lines 65–68:
  ```typescript
  DATABASE_URL: postgresUrl,
  DIRECT_DATABASE_URL: z.preprocess(emptyToUndefined, postgresUrl.optional()),
  ```

**Verdict:**

1. The application runtime strictly requires `DATABASE_URL`. On Neon, this MUST be the **pooled connection string** (e.g. `postgresql://user:pass@ep-xyz-pooler.ap-southeast-1.aws.neon.tech/asra_academy?sslmode=require`).
2. Migrations executed by the Prisma CLI require `DIRECT_DATABASE_URL`. On Neon, this MUST be the **direct connection string** without the `-pooler` suffix. PgBouncer pooling breaks transactional schema migration locks (`pg_advisory_lock`).
3. The identifier `DIRECT_URL` is **not referenced anywhere in the repository**. Setting `DIRECT_URL` in environment files will have no effect.

---

### 3.2 Render Runtime & `PORT` Handling

**Code Verification:**

- `apps/api/src/server.ts`:
  ```typescript
  const server = app.listen(env.PORT, () => {
    logger.info(
      `ASRA Academy API listening on http://localhost:${env.PORT}${API_PREFIX} (${env.NODE_ENV})`,
    );
  });
  ```
- `apps/api/src/config/env.ts`:
  ```typescript
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  ```

**Render Mechanics:**
Render dynamically assigns a port (typically `PORT=10000`) and binds its internal ingress router to that port.
Because `app.listen(env.PORT)` in `server.ts` does not specify a host binding, Node.js defaults to `0.0.0.0` (all IPv4 interfaces), allowing Render's reverse proxy to route traffic successfully.
Furthermore, Render's long-running Node container allows `server.ts` to execute its 3 background workers:

1. `startAttemptExpiryWorker()`: Automatically finalizes abandoned assessment/quiz attempts.
2. `startPaymentReconciliationWorker()`: Checks unsettled Razorpay orders and recovery workflows.
3. `startNotificationEmailWorker()`: Retries transactional emails that failed initial delivery.

---

### 3.3 Browser vs Server Exposure (`NEXT_PUBLIC_*`)

Next.js statically replaces `process.env.NEXT_PUBLIC_*` variables with their string values at **build time**.
`apps/web/src/lib/env.ts` defines and validates the browser-exposed variables:

```typescript
const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
  NEXT_PUBLIC_API_URL: z.url().default('http://localhost:4000/api/v1'),
  NEXT_PUBLIC_WHATSAPP_NUMBER: z
    .string()
    .regex(/^[1-9]\d{7,14}$/, 'NEXT_PUBLIC_WHATSAPP_NUMBER must be 8–15 digits with country code')
    .optional(),
});
```

**Security Auditing:**

- Only these three `NEXT_PUBLIC_*` variables exist in the entire codebase.
- No database credentials, JWT secrets, payment secrets, or email API keys use `NEXT_PUBLIC_`.
- `NEXT_PUBLIC_API_URL` already includes the `/api/v1` prefix. Setting `NEXT_PUBLIC_API_URL=https://api.asraacademy.in/api/v1` is required. Omitting `/api/v1` causes client requests to fail.

---

### 3.4 Authentication, Session Tokens & Cookie Security

**Code Verification:**

- Access tokens: In-memory JWT (HS256) valid for 15 minutes (`JWT_ACCESS_TTL_MINUTES`). Never stored in `localStorage` or `sessionStorage`.
- Refresh tokens: Stored in an `HttpOnly` cookie scoped to `/api/v1/auth`. Rotated on every single refresh (`POST /api/v1/auth/refresh`). If a rotated token is reused, the session is immediately revoked under reuse detection (`TOKEN_REUSE`).
- `apps/api/src/controllers/auth.controller.ts`:
  ```typescript
  const refreshCookieBase: CookieOptions = {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE, // Must be true in production
    sameSite: env.AUTH_COOKIE_SAME_SITE, // Defaults to 'strict'
    path: REFRESH_COOKIE_PATH, // '/api/v1/auth'
    ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
  };
  ```

**Cross-Origin & Domain Warning for Private Beta:**

- If Frontend is on Vercel (`*.vercel.app`) and Backend is on Render (`*.onrender.com`), they are on **different registrable domains** (different eTLDs).
- With `AUTH_COOKIE_SAME_SITE=strict` (the code default), browsers will **refuse to send the cookie** on cross-site `fetch(..., { credentials: 'include' })`.
- In addition, modern browsers (Safari ITP, Chrome Privacy Sandbox) block third-party cookies by default.
- **Solution:** For production testing, configure custom subdomains under the same parent domain (e.g. `www.asraacademy.in` and `api.asraacademy.in`). This makes them schemeful same-site, allowing cookies to function correctly. If testing on staging before DNS is pointed, `AUTH_COOKIE_SAME_SITE=none` and `AUTH_COOKIE_SECURE=true` must be set, and tested on browsers that allow partitioned/third-party cookies.

---

### 3.5 Cross-Origin Resource Sharing (CORS) & CSRF Allow-Listing

**Code Verification:**

- `apps/api/src/config/env.ts` line 289:
  ```typescript
  corsOrigins: (raw.CORS_ORIGINS?.length ? raw.CORS_ORIGINS : [raw.NEXT_PUBLIC_APP_URL]).map(
    (origin) => new URL(origin).origin,
  ),
  ```
- `apps/api/src/app.ts`:
  ```typescript
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Retry-After', 'RateLimit', 'RateLimit-Policy'],
      maxAge: 600,
    }),
  );
  ```
- `apps/api/src/middleware/trusted-origin.ts`:
  All state-changing auth endpoints verify that incoming `Origin` headers match `corsOrigins` and reject `Sec-Fetch-Site: cross-site`.
- In production, set `CORS_ORIGINS=https://www.asraacademy.in,https://asraacademy.in`.

---

### 3.6 Redis & Upstash TLS Enforcement (`rediss://`)

**Code Verification:**

- `apps/api/src/config/env.ts` line 71:
  ```typescript
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).default('redis://localhost:6379'),
  ```
- `apps/api/src/lib/redis.ts`:
  ```typescript
  export function createRedisClient(url: string = env.REDIS_URL): Redis {
    return new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
    });
  }
  ```
- `ioredis` automatically negotiates TLS when given a URL beginning with `rediss://`.
- Upstash Redis endpoints use TLS by default. Ensure the connection string begins with `rediss://` and not `redis://`.

---

### 3.7 File Storage: The Cloudinary Integration Discrepancy

**Code Verification:**

- In `apps/api/src/modules/recruitment/resume-storage.service.ts`:
  ```typescript
  public isCloudinaryConfigured(): boolean {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
    const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
    const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
    return Boolean(cloudName && apiKey && apiSecret);
  }
  ```
- Lines 125–140 perform raw signed uploads of PDF files to:
  `https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`
- **Crucial Warning:** If `CLOUDINARY_*` credentials are not supplied, the service falls back to saving files locally on disk at `storage/resumes`. On Render Web Services, the disk is **ephemeral**. When Render spins down, restarts, or deploys, any locally stored resumes are permanently lost.
- **Action Required:** `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` must be set in Render's environment. The variables `STORAGE_URL`, `STORAGE_KEY`, and `STORAGE_SECRET` from `.env.example` must be ignored.

---

### 3.8 Email Delivery: Resend & Domain Verification

**Code Verification:**

- `apps/api/src/config/env.ts` lines 164–190:
  ```typescript
  if (env.NODE_ENV === 'production') {
    if (env.EMAIL_TRANSPORT !== 'resend') {
      ctx.addIssue({ message: 'Set EMAIL_TRANSPORT=resend in production.' });
    }
  }
  if (env.EMAIL_TRANSPORT === 'resend') {
    if (!env.EMAIL_API_KEY?.trim())
      ctx.addIssue({ message: 'Required when EMAIL_TRANSPORT=resend' });
    if (!isDeliverableSender(env.EMAIL_FROM)) {
      ctx.addIssue({ message: 'Must be on a domain verified in Resend (not localhost)' });
    }
  }
  ```
- The API **fails closed** and terminates immediately if `EMAIL_TRANSPORT=resend` is not configured in production.
- `EMAIL_FROM` must match a verified sending domain in Resend (e.g. `ASRA Academy <no-reply@asraacademy.in>`).

---

### 3.9 Razorpay Test Mode & Webhook Architecture

**Code Verification:**

- `apps/api/src/config/env.ts` lines 214–238:
  ```typescript
  if (
    mode === 'test' &&
    env.NODE_ENV === 'production' &&
    !env.RAZORPAY_ALLOW_TEST_MODE_IN_PRODUCTION
  ) {
    issue(
      'RAZORPAY_MODE',
      'Test mode in production requires RAZORPAY_ALLOW_TEST_MODE_IN_PRODUCTION=true',
    );
  }
  if (env.NODE_ENV === 'production' && !env[`${prefix}_WEBHOOK_SECRET`]?.trim()) {
    issue(`${prefix}_WEBHOOK_SECRET`, `Required in production when RAZORPAY_MODE=${mode}`);
  }
  ```
- **Configuration for Private Beta:**
  - `RAZORPAY_MODE=test`
  - `RAZORPAY_TEST_KEY_ID=rzp_test_...`
  - `RAZORPAY_TEST_KEY_SECRET=...`
  - `RAZORPAY_TEST_WEBHOOK_SECRET=...`
  - `RAZORPAY_ALLOW_TEST_MODE_IN_PRODUCTION=true`
- **Webhook Endpoint:**
  - `POST /api/v1/payments/webhooks/razorpay/test`
  - Mount point in `apps/api/src/app.ts` is explicitly parsed with `express.raw()` to preserve exact byte-for-byte HMAC signature verification.

---

### 3.10 Google Meet REST API & OAuth Token Lifecycles

**Code Verification:**

- `apps/api/src/config/env.ts` lines 240–258:
  - `GOOGLE_MEET_CLIENT_ID`, `GOOGLE_MEET_CLIENT_SECRET`, and `GOOGLE_MEET_REFRESH_TOKEN` must be supplied **all together or none at all**.
  - If left empty, automatic meeting creation is safely disabled, allowing staff to paste meeting links manually.
- `apps/api/src/modules/live-classes/providers/google-meet.provider.ts`:
  - Required scope: `https://www.googleapis.com/auth/meetings.space.created`.
  - **7-Day Expiry Risk:** If the Google Cloud OAuth Consent Screen is left in "Testing" status, refresh tokens issued to external accounts expire after **7 days**, which causes live meeting generation to fail. The consent screen must eventually be published or refreshed weekly during the private beta.

---

### 3.11 Build-Time Search Engine Indexing (`SITE_INDEXING_ENABLED`)

**Code Verification:**

- `apps/web/next.config.ts`:
  ```typescript
  if (process.env.SITE_INDEXING_ENABLED === 'true') assertIndexableSiteUrl(appUrl);
  ```
- `apps/web/src/config/deployment.ts`:
  ```typescript
  export function assertIndexableSiteUrl(appUrl: string | undefined): void {
    const url = new URL(appUrl ?? '');
    const problems = [
      url.protocol !== 'https:' && 'must use https',
      (host === 'localhost' || /^(127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(host)) &&
        'must not be a local address',
      host.endsWith('.vercel.app') && 'must be the production domain, not a *.vercel.app preview',
      url.pathname !== '/' && 'must be an origin without a path',
    ].filter(Boolean);
    if (problems.length > 0)
      throw new Error(`SITE_INDEXING_ENABLED=true but NEXT_PUBLIC_APP_URL ...`);
  }
  ```
- **Rule for Private Beta:** Leave `SITE_INDEXING_ENABLED` unset or empty. Setting it to `true` on a Vercel preview URL or non-custom domain will cause the build to fail immediately.

---

## 4. Provider-by-Provider Configuration Guide

### 4.1 Neon PostgreSQL

1. **Sign In & Create Project:**
   - Navigate to [console.neon.tech](https://console.neon.tech).
   - Click **Create Project**.
   - Project Name: `asra-academy-prod`.
   - Postgres Version: Select **PostgreSQL 17** (matches local Docker).
   - Region: Select AWS **Asia Pacific (Singapore) `ap-southeast-1`** (lowest latency to India and Render/Vercel Asia regions).
2. **Retrieve Connection Strings:**
   - In the project dashboard under **Connection Details**:
   - Ensure the database selected is `neondb` (or create `asra_academy`).
   - Check **Connection pooling** -> Copy the string -> This is `DATABASE_URL`.
     _(Format: `postgresql://[user]:[password]@ep-[name]-pooler.ap-southeast-1.aws.neon.tech/asra_academy?sslmode=require`)_
   - Uncheck **Connection pooling** (Direct connection) -> Copy the string -> This is `DIRECT_DATABASE_URL`.
     _(Format: `postgresql://[user]:[password]@ep-[name].ap-southeast-1.aws.neon.tech/asra_academy?sslmode=require`)_
3. **Environment Isolation (Branching):**
   - In the Neon dashboard, navigate to **Branches**.
   - Default branch `main` is dedicated to Production.
   - Click **New Branch** -> Name: `preview` or `staging` -> Source: `main` (schema only). Use this separate branch for Vercel preview deployments so testing branches never touch production data.

---

### 4.2 Upstash Redis

1. **Create Database:**
   - Navigate to [console.upstash.com](https://console.upstash.com).
   - Click **Create Database**.
   - Name: `asra-academy-cache`.
   - Type: **Regional**.
   - Region: Select AWS **ap-southeast-1 (Singapore)** (align with Neon and Render).
   - Eviction: Enable eviction or leave as default.
2. **Retrieve Connection URL:**
   - Under database **Details**, scroll to **Connect to your database**.
   - Select the **Node.js** or **ioredis** tab.
   - Locate the connection string beginning with `rediss://default:...`.
   - Copy the entire connection string -> This is `REDIS_URL`.

---

### 4.3 Cloudinary Object Storage

1. **Sign Up / Login:**
   - Navigate to [cloudinary.com](https://cloudinary.com) and log in to the Cloudinary Console.
2. **Copy Credentials:**
   - From the Dashboard Home (Product Environment):
   - Locate **Cloud Name** -> This is `CLOUDINARY_CLOUD_NAME`.
   - Locate **API Key** -> This is `CLOUDINARY_API_KEY`.
   - Click to reveal and copy **API Secret** -> This is `CLOUDINARY_API_SECRET`.
3. **Configure Media Settings:**
   - Go to **Settings** (gear icon) -> **Upload**.
   - Ensure unsigned uploads remain disabled. The application signs uploads server-side using HMAC SHA-1.

---

### 4.4 Resend Email

1. **Create API Key:**
   - Navigate to [resend.com](https://resend.com) and log in.
   - Go to **API Keys** -> Click **Create API Key**.
   - Key Name: `asra-academy-api-prod`.
   - Permission: **Sending access** (full access is unnecessary and unsafe).
   - Copy key immediately (`re_...`) -> This is `EMAIL_API_KEY`.
2. **Domain Verification:**
   - Go to **Domains** -> Click **Add Domain**.
   - Domain: `asraacademy.in`.
   - Region: Select closest available.
   - Resend provides DNS records:
     - DKIM TXT record: Name `resend._domainkey.asraacademy.in`, Value provided by Resend.
     - SPF TXT / MX records (if using subdomain e.g. `mail.asraacademy.in`).
   - Add these records to your DNS provider. Wait for status to show **Verified**.
3. **Configure Sender:**
   - Set `EMAIL_FROM=ASRA Academy <no-reply@asraacademy.in>` in Render.

---

### 4.5 Razorpay (Test Mode)

1. **Switch to Test Mode:**
   - Log in to [dashboard.razorpay.com](https://dashboard.razorpay.com).
   - In the top navigation bar or sidebar, toggle the switch from **Live Mode** to **Test Mode**.
2. **Generate API Keys:**
   - Go to **Account & Settings** -> **API Keys**.
   - Click **Generate Test Key**.
   - Copy **Key Id** (begins with `rzp_test_`) -> This is `RAZORPAY_TEST_KEY_ID`.
   - Copy **Key Secret** -> This is `RAZORPAY_TEST_KEY_SECRET`.
3. **Configure Webhook:**
   - Go to **Account & Settings** -> **Webhooks**.
   - Click **Add New Webhook**.
   - Webhook URL: `https://api.asraacademy.in/api/v1/payments/webhooks/razorpay/test`
   - Secret: Enter a generated random string (e.g. 32 chars) -> This is `RAZORPAY_TEST_WEBHOOK_SECRET`.
   - Active Events: Select the following 7 events:
     - `payment.authorized`
     - `payment.captured`
     - `payment.failed`
     - `order.paid`
     - `refund.created`
     - `refund.processed`
     - `refund.failed`
   - Click **Save**.

---

### 4.6 Google Cloud / Google Meet OAuth

1. **Create GCP Project & Enable API:**
   - Go to [console.cloud.google.com](https://console.cloud.google.com).
   - Create a project named `ASRA Academy`.
   - Navigate to **APIs & Services** -> **Library**.
   - Search for **Google Meet REST API** and click **Enable**.
2. **OAuth Consent Screen:**
   - Navigate to **APIs & Services** -> **OAuth consent screen**.
   - User Type: Select **External** (or **Internal** if using Google Workspace).
   - App Name: `ASRA Academy`.
   - User support & Developer email: Enter administrator email.
   - Scopes: Click **Add or Remove Scopes** -> Add `https://www.googleapis.com/auth/meetings.space.created`.
   - Test Users: Add the Google account that will host and own the classes.
3. **OAuth Client Credentials:**
   - Navigate to **APIs & Services** -> **Credentials**.
   - Click **Create Credentials** -> **OAuth client ID**.
   - Application type: **Web application**.
   - Name: `ASRA API Live Classes`.
   - Authorized redirect URIs: Add `https://developers.google.com/oauthplayground`.
   - Click **Create**. Copy **Client ID** (`GOOGLE_MEET_CLIENT_ID`) and **Client Secret** (`GOOGLE_MEET_CLIENT_SECRET`).
4. **Acquire Refresh Token via OAuth Playground:**
   - Open [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground).
   - Click the gear icon (top right) -> Check **Use your own OAuth credentials**.
   - Enter your `OAuth Client ID` and `OAuth Client Secret`.
   - Under Step 1, enter scope `https://www.googleapis.com/auth/meetings.space.created` -> Click **Authorize APIs**.
   - Log in with the meeting owner account and grant access.
   - Under Step 2, click **Exchange authorization code for tokens**.
   - Copy the value of **Refresh token** -> This is `GOOGLE_MEET_REFRESH_TOKEN`.

---

### 4.7 Render (API Web Service)

1. **Create Web Service:**
   - Log in to [dashboard.render.com](https://dashboard.render.com).
   - Click **New +** -> **Web Service**.
   - Connect the GitHub repository `asra-academy`.
2. **Configure Service Settings:**
   - **Name:** `asra-academy-api`.
   - **Language / Runtime:** `Node`.
   - **Region:** `Singapore` (or region matching Neon).
   - **Branch:** `main`.
   - **Root Directory:** Leave empty (run from monorepo root).
   - **Build Command:**
     ```bash
     npm run build:packages && npm run build -w @asra/api
     ```
   - **Start Command:**
     ```bash
     node apps/api/dist/server.js
     ```
   - **Plan:** Select Starter ($7/mo) or Free (note free limitations in Section 6).
   - **Health Check Path:** `/api/v1/health`
3. **Add Environment Variables:**
   Under **Environment** in the Render service settings, add:
   ```env
   NODE_ENV=production
   PORT=10000
   LOG_LEVEL=info
   DATABASE_URL=<Neon Pooled Connection String>
   DIRECT_DATABASE_URL=<Neon Direct Connection String>
   DATABASE_POOL_MAX=10
   REDIS_URL=<Upstash rediss:// String>
   RATE_LIMIT_STORE=redis
   JWT_SECRET=<Generated 48-byte Base64URL string>
   AUTH_COOKIE_SECURE=true
   AUTH_COOKIE_SAME_SITE=strict
   NEXT_PUBLIC_APP_URL=https://www.asraacademy.in
   CORS_ORIGINS=https://www.asraacademy.in,https://asraacademy.in
   EMAIL_TRANSPORT=resend
   EMAIL_API_KEY=re_...
   EMAIL_FROM=ASRA Academy <no-reply@asraacademy.in>
   CLOUDINARY_CLOUD_NAME=<Cloud Name>
   CLOUDINARY_API_KEY=<API Key>
   CLOUDINARY_API_SECRET=<API Secret>
   RAZORPAY_MODE=test
   RAZORPAY_TEST_KEY_ID=rzp_test_...
   RAZORPAY_TEST_KEY_SECRET=...
   RAZORPAY_TEST_WEBHOOK_SECRET=...
   RAZORPAY_ALLOW_TEST_MODE_IN_PRODUCTION=true
   GOOGLE_MEET_CLIENT_ID=<GCP Client ID>
   GOOGLE_MEET_CLIENT_SECRET=<GCP Client Secret>
   GOOGLE_MEET_REFRESH_TOKEN=<GCP Refresh Token>
   ```
4. **Custom Domain:**
   - In Render settings -> **Custom Domains** -> Add `api.asraacademy.in`.
   - Follow DNS CNAME instructions.

---

### 4.8 Vercel (Next.js Web Frontend)

1. **Import Project:**
   - Log in to [vercel.com](https://vercel.com).
   - Click **Add New...** -> **Project**.
   - Import the `asra-academy` repository.
2. **Project & Build Settings:**
   - **Framework Preset:** `Next.js`.
   - **Root Directory:** `apps/web`.
   - **Build & Development Settings:**
     - Toggle Override on **Build Command**:
       ```bash
       cd ../.. && npm run build:packages && npm run build -w @asra/web
       ```
     - Toggle Override on **Install Command**:
       ```bash
       cd ../.. && npm install
       ```
3. **Environment Variables:**
   Under **Environment Variables**, configure for **Production**:
   ```env
   NEXT_PUBLIC_APP_URL=https://www.asraacademy.in
   NEXT_PUBLIC_API_URL=https://api.asraacademy.in/api/v1
   ENABLE_DESIGN_SYSTEM=false
   SITE_INDEXING_ENABLED=false
   ```
   _(Add `NEXT_PUBLIC_WHATSAPP_NUMBER` only if confirmed by client)._
4. **Custom Domain:**
   - Go to **Settings** -> **Domains**.
   - Add `www.asraacademy.in` (set as canonical / primary).
   - Add `asraacademy.in` (redirect to `www.asraacademy.in`).

---

### 4.9 DNS & Custom Domain Provider

Configure the following records in your DNS manager (e.g. GoDaddy, Cloudflare, Route 53):

| Type    | Name / Host         | Target / Value                  | TTL        | Purpose                     |
| ------- | ------------------- | ------------------------------- | ---------- | --------------------------- |
| `CNAME` | `www`               | `cname.vercel-dns.com`          | Auto / 300 | Vercel Web App (Primary)    |
| `A`     | `@` (apex)          | `76.76.21.21`                   | Auto / 300 | Vercel Apex Redirect to www |
| `CNAME` | `api`               | `asra-academy-api.onrender.com` | Auto / 300 | Render API Web Service      |
| `TXT`   | `resend._domainkey` | Value provided by Resend        | Auto / 300 | Resend DKIM Authentication  |

---

## 5. Database Deployment, Migration & Seeding Safety

### 5.1 Existing Migration History

The database contains 11 committed Prisma migrations in `apps/api/prisma/migrations`:

1. `20261013042559_init_database_core`
2. `20261013045953_auth_sessions_and_tokens`
3. `20261015071102_phase06_course_management`
4. `20261016083843_phase07_student_lms`
5. `20261016102329_phase08_faculty_portal`
6. `20261017090000_phase09_assessment_engine`
7. `20261019090000_phase10_enrolment_payment`
8. `20261020090000_phase11_live_classes_notifications`
9. `20261023090000_phase12_admin_dashboard`
10. `20261025090000_phase13_certificate_system`
11. `20261105090000_phase16_careers_recruitment`

### 5.2 Safe Migration Execution Protocol

Do **not** run migrations on application startup. Execute them from an authorized operator terminal:

```bash
# 1. Set direct database URL in current shell session only (do not write to disk)
export DIRECT_DATABASE_URL="postgresql://user:pass@ep-name.ap-southeast-1.aws.neon.tech/asra_academy?sslmode=require"

# 2. Check pending migration status
npm run db:migrate:status -w @asra/api

# 3. Apply migrations using the non-destructive deploy command
npm run db:migrate:deploy -w @asra/api

# 4. Seed foundational reference data (roles & permissions)
export DATABASE_URL="postgresql://user:pass@ep-name-pooler.ap-southeast-1.aws.neon.tech/asra_academy?sslmode=require"
npm run db:seed -w @asra/api

# 5. Clear credentials from shell
unset DIRECT_DATABASE_URL DATABASE_URL
```

**Guardrails:**
The custom script `apps/api/scripts/db-command.ts` will intentionally abort with an error if `db:migrate`, `db:migrate:create`, or `db:reset` are attempted against a non-local host or when `NODE_ENV=production`.

### 5.3 Provisioning the Initial Super Administrator

Because `db:seed` creates zero user accounts, create the initial administrator using the CLI utility:

```bash
DATABASE_URL="postgresql://user:pass@ep-name-pooler.ap-southeast-1.aws.neon.tech/asra_academy?sslmode=require" \
NEW_USER_PASSWORD="SecureSuperAdminPassword123!" \
npm run auth:create-user -w @asra/api -- \
  --email "admin@asraacademy.in" \
  --name "ASRA Super Admin" \
  --role SUPER_ADMIN
```

### 5.4 Neon Recovery Points & Branching

Before running any migration:

1. In the Neon Console, navigate to **Branches** -> Select `main` -> Click **Create Branch from this point**.
2. Name the snapshot `pre-deploy-YYYYMMDD-HHMM`.
3. If an issue occurs, you can restore state instantaneously using Neon's Point-in-Time Recovery (PITR) without losing the existing schema history.

---

## 6. Security Audit, Infrastructure Limitations & Production Readiness

### 6.1 Secrets & Browser Isolation

- `JWT_SECRET`, database connection strings, API keys, and webhook secrets are parsed exclusively on the server in `apps/api/src/config/env.ts` and `apps/web/src/config/deployment.ts`.
- The Next.js client bundle only receives variables prefixed with `NEXT_PUBLIC_`.
- Server-side responses default to `Cache-Control: no-store` globally in `apps/api/src/app.ts`, preventing sensitive responses from lingering in browser or CDN caches.

### 6.2 Code-Level Findings & Hardcoded Fallbacks (RESOLVED)

1. **JWT Fallback in Resume Service [RESOLVED]:**
   The hardcoded fallback `'recruitment-resume-upload-secret-32-chars'` has been removed from `apps/api/src/modules/recruitment/resume-storage.service.ts`. The service now strictly relies on the application's centrally validated `env.JWT_SECRET`, failing safely if missing.
2. **Cloudinary Validation & Inconsistency [RESOLVED]:**
   `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` are now added to the centralized Zod schema in `apps/api/src/config/env.ts`. Production environments strictly require all three credentials at startup; local development/test environments allow them as an optional group (all 3 or none). In production, resume uploads strictly reject local disk fallback. `.env.example` has been updated to remove legacy `STORAGE_*` variables and document the exact Cloudinary credentials.

### 6.3 Free-Tier vs Production Infrastructure Realities

| Platform               | Free-Tier Limitations                                                                                                          | Production / Beta Impact                                                                                                            | Verdict                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Render Web Service** | Spins down after 15 min of inactivity; 50+ sec cold start; 512 MB RAM; **ephemeral filesystem** (no persistent disk)           | Background workers stop running during spin-down; resume uploads fail if Cloudinary fails; severe first-request latency for testers | **Not recommended for reliable beta.** Upgrade to Render Starter ($7/mo) to keep instance warm and active.                          |
| **Vercel**             | **Hobby Tier strictly forbids commercial use.** Educational institutions charging tuition/fees violate Vercel Terms of Service | Legal compliance risk if tuition or fees are accepted under Hobby tier                                                              | Acceptable for private beta evaluation with developer/client only; must upgrade to Vercel Pro ($20/seat/mo) prior to public launch. |
| **Neon PostgreSQL**    | Inactivity timeout scales compute to zero; 0.5 GiB storage limit                                                               | 1–3 second wake-up latency when cold. First health check probe may report down                                                      | Acceptable for private beta. Monitor storage consumption.                                                                           |
| **Upstash Redis**      | 10,000 commands/day; 256 MB memory                                                                                             | Heavy API test traffic or automated probe sweeps can exceed 10k requests/day                                                        | Acceptable for private beta testing with 2–5 users.                                                                                 |
| **Resend**             | 3,000 emails/month; 100 emails/day limit                                                                                       | Sufficient for private beta, but cannot send bulk marketing or test blasts                                                          | Acceptable for private beta.                                                                                                        |
| **Cloudinary**         | 25 monthly credits (~25 GB storage / net)                                                                                      | More than sufficient for candidate resume testing                                                                                   | Acceptable for private beta.                                                                                                        |

---

## 7. Step-by-Step Deployment Execution Order

To avoid dependency deadlocks, execute deployments in this exact order:

```text
Step 1: Infrastructure Provisioning
   ├── 1.1 Create Neon PostgreSQL project & acquire pooled/direct URLs
   ├── 1.2 Create Upstash Redis instance & acquire rediss:// URL
   ├── 1.3 Create Cloudinary account & acquire API credentials
   ├── 1.4 Create Resend account, add custom domain & generate API key
   └── 1.5 Generate Razorpay Test API keys & webhook secret

Step 2: Database Preparation (Operator Machine)
   ├── 2.1 Run `npm run db:migrate:status` against Neon Direct URL
   ├── 2.2 Run `npm run db:migrate:deploy` against Neon Direct URL
   ├── 2.3 Run `npm run db:seed` against Neon Pooled URL
   └── 2.4 Run `npm run auth:create-user` to provision initial SUPER_ADMIN

Step 3: Backend Deployment (Render)
   ├── 3.1 Create Render Web Service linked to repo `main` branch
   ├── 3.2 Configure build & start commands
   ├── 3.3 Set all environment variables (including Cloudinary & Razorpay test flags)
   ├── 3.4 Deploy and verify `GET /api/v1/health` returns 200 OK
   └── 3.5 Attach custom domain `api.asraacademy.in`

Step 4: Frontend Deployment (Vercel)
   ├── 4.1 Create Vercel project with root `apps/web`
   ├── 4.2 Set `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_API_URL`
   ├── 4.3 Ensure `SITE_INDEXING_ENABLED=false` and `ENABLE_DESIGN_SYSTEM=false`
   ├── 4.4 Deploy and verify web build succeeds
   └── 4.5 Attach custom domains `www.asraacademy.in` and `asraacademy.in`

Step 5: DNS & Webhook Finalization
   ├── 5.1 Ensure DNS records for `www`, `api`, and Resend DKIM are propagated
   ├── 5.2 Set Razorpay Webhook URL to `https://api.asraacademy.in/api/v1/payments/webhooks/razorpay/test`
   └── 5.3 Run production smoke test probe (`npm run probe:production`)
```

---

## 8. Integration Testing & Verification Checklist

Once both services are deployed, test the following flows before handing the environment to the client:

- [ ] **Liveness & Readiness Probes:**
  - `GET https://api.asraacademy.in/api/v1/health` returns `200` (`status: "ok"`).
  - `GET https://api.asraacademy.in/api/v1/health/ready` returns `200` (`database: "up"`, `redis: "up"`).
- [ ] **Public Website & CSP Headers:**
  - Visit `https://www.asraacademy.in/`.
  - In browser devtools, confirm response headers include `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, and `Strict-Transport-Security`.
  - Confirm no CSP violation errors in browser console.
- [ ] **Authentication & Cookies:**
  - Log in at `/login` using the provisioned `SUPER_ADMIN` account.
  - Verify access token is received in response body.
  - In devtools Application/Storage tab, confirm `asra_refresh` cookie is set on `/api/v1/auth` with `HttpOnly` and `Secure`.
  - Reload page and verify session persistence via `POST /api/v1/auth/refresh`.
- [ ] **Email Delivery (Resend):**
  - Register a new student account or trigger a password reset at `/forgot-password`.
  - Confirm email arrives in recipient inbox with sender `ASRA Academy <no-reply@asraacademy.in>`.
- [ ] **Careers & Cloudinary Resume Storage:**
  - Create a test job in `/admin/recruitment`.
  - Visit public `/careers` and submit an application with a valid PDF resume.
  - Log in to Cloudinary Console and verify PDF asset was uploaded to `asra_recruitment_resumes/`.
  - In admin recruitment dashboard, download candidate resume and verify binary stream integrity.
- [ ] **Razorpay Test Payments:**
  - Initiate checkout on a paid course using Razorpay Test Mode.
  - Complete payment using Razorpay test card / test UPI.
  - Verify webhook event delivers `order.paid` / `payment.captured` and enrolment transitions to `ACTIVE`.
- [ ] **Automated Probe Script:**
  - Run `npm run probe:production` locally to execute all synthetic read-only checks.

---

## 9. Troubleshooting & Common Pitfalls

| Symptom                                                                                          | Root Cause                                                                            | Fix                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| API crashes on boot: `Invalid environment configuration`                                         | Missing `JWT_SECRET`, `DATABASE_URL`, or `EMAIL_TRANSPORT=resend` in production       | Inspect Render logs for Zod prettified validation errors. Add missing variables.                                                 |
| API crashes with: `Test mode in production requires RAZORPAY_ALLOW_TEST_MODE_IN_PRODUCTION=true` | Running `RAZORPAY_MODE=test` with `NODE_ENV=production` without explicit bypass       | Set `RAZORPAY_ALLOW_TEST_MODE_IN_PRODUCTION=true` in Render environment.                                                         |
| Web build fails with: `SITE_INDEXING_ENABLED=true but NEXT_PUBLIC_APP_URL ...`                   | Indexing enabled on a preview or `*.vercel.app` domain                                | Set `SITE_INDEXING_ENABLED=false` or remove the variable in Vercel.                                                              |
| User login succeeds, but refresh fails immediately (401)                                         | Cookie blocked due to cross-site domain mismatch (`*.vercel.app` vs `*.onrender.com`) | Use custom subdomains on `asraacademy.in` or set `AUTH_COOKIE_SAME_SITE=none` + `AUTH_COOKIE_SECURE=true`.                       |
| Resume uploads fail with: `Cloud resume upload failed`                                           | Cloudinary credentials missing or signature mismatch                                  | Check `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. Ensure values have no leading/trailing spaces. |
| Prisma CLI commands fail with connection timeout                                                 | Running migrations through Neon pooler instead of direct endpoint                     | Set `DIRECT_DATABASE_URL` to Neon non-pooled connection string (`ep-name`, not `ep-name-pooler`).                                |
| Resend throws `Resend did not accept the message (validation_error)`                             | Domain not verified in Resend, or `EMAIL_FROM` domain does not match verified domain  | Verify `asraacademy.in` in Resend and update `EMAIL_FROM` to match.                                                              |

---

## 10. Open Clarifications & Client Decisions

The following business and operational decisions must be confirmed by the client/operator prior to public launch:

1. **WhatsApp Support (P-02 / P-03):** Does ASRA Academy want the floating WhatsApp button enabled for this beta? If so, provide the official phone number in international format (`91XXXXXXXXXX`) to set `NEXT_PUBLIC_WHATSAPP_NUMBER`.
2. **Google Meet Automation (AE-01 / AE-02):** Should automatic Google Meet link creation be configured now, or will instructors paste manual meeting links during the private beta?
3. **Render Compute Tier:** Does the client accept the 50-second cold start latency and timer freeze of Render's free tier, or should the $7/mo Starter tier be provisioned immediately?
4. **Vercel Commercial License:** Acknowledge that public commercial launch requires upgrading from Vercel Hobby to Vercel Pro.
5. **Search Engine Indexing Approval (W-04 / U-01):** Keep `SITE_INDEXING_ENABLED=false` until client provides formal sign-off on legal documents (Terms of Service, Privacy Policy, Refund Policy).
