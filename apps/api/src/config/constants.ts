export const API_PREFIX = '/api/v1';

export const APP_NAME = 'ASRA Academy API';

/** Maximum time to wait for in-flight requests and connections to close on shutdown. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Maximum time a readiness probe waits for a dependency (PostgreSQL / Redis). */
export const DEPENDENCY_CHECK_TIMEOUT_MS = 2_000;

// --- HTTP caching (PHASE 14) --------------------------------------------------------------

/**
 * Every API response is `Cache-Control: no-store` by default (app.ts). Only anonymous,
 * non-personalised GET responses opt in, and only on success. Browsers always revalidate
 * (`max-age=0`); a shared cache/CDN may keep a copy for `s-maxage` seconds, so an unpublished
 * course can stay visible on the public site for at most about a minute (docs/PERFORMANCE.md).
 */
export const PUBLIC_CATALOGUE_CACHE_CONTROL =
  'public, max-age=0, s-maxage=60, stale-while-revalidate=60';
export const SITEMAP_FEED_CACHE_CONTROL =
  'public, max-age=0, s-maxage=300, stale-while-revalidate=300';

/** Upper bound of course URLs in the sitemap feed (one sitemap file holds up to 50,000 URLs). */
export const SITEMAP_COURSE_LIMIT = 5_000;

// --- Authentication (PHASE 03) ------------------------------------------------------------

/** HttpOnly cookie carrying the refresh token. Scoped to the auth routes only. */
export const REFRESH_COOKIE_NAME = 'asra_refresh';
export const REFRESH_COOKIE_PATH = `${API_PREFIX}/auth`;

/**
 * Rate limits for the public auth endpoints, per client IP and fixed window.
 * Login counts only FAILED attempts so a user who logs in successfully is never throttled.
 * Refresh counts only failed attempts that PRESENT a refresh cookie (token guessing): every page
 * load refreshes and a 429 signs the user out, so valid sessions and cookie-less visitors must not
 * share a per-IP budget (school networks, mobile CGNAT).
 */
export const AUTH_RATE_LIMITS = {
  login: { windowMinutes: 15, limit: 10, skipSuccessfulRequests: true },
  register: { windowMinutes: 60, limit: 5 },
  refresh: { windowMinutes: 15, limit: 60, skipSuccessfulRequests: true, requireCookie: true },
  forgotPassword: { windowMinutes: 15, limit: 5 },
  resetPassword: { windowMinutes: 15, limit: 10 },
  verifyEmail: { windowMinutes: 15, limit: 10 },
  resendVerification: { windowMinutes: 15, limit: 3 },
} as const;

export type AuthRateLimitName = keyof typeof AUTH_RATE_LIMITS;

// --- Assessments (PHASE 09) ---------------------------------------------------------------

/**
 * Per-STUDENT limits on attempt endpoints (fixed 1-minute windows). Generous enough for normal
 * exam use — autosave fires per answer change, debounced in the browser — while capping scripted
 * hammering of start/submit.
 */
export const ASSESSMENT_RATE_LIMITS = {
  attemptStart: { windowMinutes: 1, limit: 20 },
  answerSave: { windowMinutes: 1, limit: 300 },
  attemptSubmit: { windowMinutes: 1, limit: 30 },
  /** Question/option image uploads (each ≤ 100 KB). */
  mediaUpload: { windowMinutes: 1, limit: 30 },
} as const;

export type AssessmentRateLimitName = keyof typeof ASSESSMENT_RATE_LIMITS;

/** How often the API process finalizes attempts whose deadline passed while nobody was online. */
export const ASSESSMENT_EXPIRY_SWEEP_MS = 30_000;

/**
 * Request-path finalization of expired Academy Quiz attempts (there is no scheduler on Vercel).
 * One request finalizes at most `maxPerRequest` attempts, in transactions of `batchSize`, and
 * starts no new batch once `budgetMs` has elapsed; the rest is reported as pending and the next
 * request continues. Worst case per request ≈ budgetMs + one batch.
 */
export const ACADEMY_FINALIZE_LIMITS = {
  batchSize: 50,
  maxPerRequest: 250,
  budgetMs: 3_000,
} as const;

// --- Payments (PHASE 10) ------------------------------------------------------------------

/**
 * Per-USER limits on payment endpoints (fixed 1-minute windows), plus a per-IP ceiling on the
 * public webhook (Razorpay retries anything that is not 2xx, so a 429 there is never lost data).
 */
export const PAYMENT_RATE_LIMITS = {
  orderCreate: { windowMinutes: 1, limit: 10 },
  verify: { windowMinutes: 1, limit: 20 },
  refresh: { windowMinutes: 1, limit: 30 },
  refund: { windowMinutes: 1, limit: 10 },
  webhook: { windowMinutes: 1, limit: 600 },
} as const;

export type PaymentRateLimitName = keyof typeof PAYMENT_RATE_LIMITS;

/** How often the API process re-checks unsettled orders, refunds and confirmation emails. */
export const PAYMENT_RECONCILE_SWEEP_MS = 60_000;

// --- Notifications & live classes (PHASE 11) ------------------------------------------------

/** How often the API process retries pending notification emails. */
export const NOTIFICATION_EMAIL_SWEEP_MS = 30_000;
/** Attempts per notification email before it is marked FAILED (backoff 1, 4, 9, 16 … minutes). */
export const NOTIFICATION_EMAIL_MAX_ATTEMPTS = 5;
/** A SENDING claim older than this was left by a crashed process and may be taken over. */
export const NOTIFICATION_EMAIL_CLAIM_LEASE_MS = 5 * 60_000;
/** Recipients per notification fan-out insert batch (bounded statement size). */
export const NOTIFICATION_FANOUT_BATCH = 500;
/** Upper bound for one Google API call (token refresh or meeting creation). */
export const GOOGLE_API_TIMEOUT_MS = 10_000;
/** A meeting-creation claim older than this was left by a crashed process (retry allowed). */
export const MEETING_CLAIM_LEASE_MS = 2 * 60_000;

// --- Certificates (PHASE 13) ----------------------------------------------------------------

/** Per-IP limits for public certificate verification endpoint (fixed 1-minute window). */
export const CERTIFICATE_RATE_LIMITS = {
  verify: { windowMinutes: 1, limit: 60 },
} as const;

// --- Recruitment & Careers (PHASE 16) --------------------------------------------------------

/** Per-IP limits for public careers application submission and resume uploads. */
export const RECRUITMENT_RATE_LIMITS = {
  apply: { windowMinutes: 15, limit: 15 },
  upload: { windowMinutes: 15, limit: 30 },
} as const;

export type RecruitmentRateLimitName = keyof typeof RECRUITMENT_RATE_LIMITS;
