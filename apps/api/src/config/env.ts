import path from 'node:path';
import { appEnvironmentSchema } from '@asra/validation';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

// Local development reads the monorepo root `.env`. In hosted environments variables come
// from the platform and these files simply do not exist.
loadEnv({
  path: [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')],
  quiet: true,
});

const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

/** Treats `VAR=` (empty) in .env files the same as an unset variable. */
const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

/** Integer setting with a default; empty values fall back to the default. */
const intSetting = (fallback: number, min: number, max: number) =>
  z.preprocess(
    (value) => emptyToUndefined(value) ?? String(fallback),
    z.coerce.number().int().min(min).max(max),
  );

/** Boolean setting accepting true/false/1/0; empty or unset → undefined. */
const boolSetting = z.preprocess(
  emptyToUndefined,
  z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .optional(),
);

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

/**
 * True for `address` or `Display Name <address>` with a syntactically valid address on a real
 * domain. Whether Resend has verified that domain can only be known by Resend at send time.
 */
function isDeliverableSender(from: string): boolean {
  const match = /^\s*(?:[^<>]*<([^<>\s]+)>|([^<>\s]+))\s*$/.exec(from);
  const address = match?.[1] ?? match?.[2];
  if (!address || !z.email().safeParse(address).success) return false;
  return address.split('@')[1]?.toLowerCase() !== 'localhost';
}

const RAZORPAY_PREFIX = { test: 'RAZORPAY_TEST', live: 'RAZORPAY_LIVE' } as const;

const envSchema = z
  .object({
    NODE_ENV: appEnvironmentSchema.default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // Runtime connection (Neon: pooled endpoint; local: Docker PostgreSQL).
    DATABASE_URL: postgresUrl,
    // Prisma CLI / migrations only (Neon: direct endpoint). Not used by the running API, but
    // validated when present so a malformed value is caught early.
    DIRECT_DATABASE_URL: z.preprocess(emptyToUndefined, postgresUrl.optional()),
    // Upper bound of the per-process `pg` pool. Keep small on Neon (the pooler multiplexes).
    DATABASE_POOL_MAX: intSetting(10, 1, 100),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }).default('redis://localhost:6379'),

    NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
    CORS_ORIGINS: csv.optional(),

    // --- Authentication (PHASE 03, docs/AUTHENTICATION.md) -------------------------------
    // HS256 signing key for access tokens. Required in every environment.
    JWT_SECRET: z.preprocess(
      emptyToUndefined,
      z
        .string({ error: 'JWT_SECRET is required (see .env.example for how to generate one)' })
        .min(32, 'JWT_SECRET must be at least 32 characters'),
    ),
    JWT_ISSUER: z.preprocess(emptyToUndefined, z.string().min(1).default('asra-academy-api')),
    JWT_AUDIENCE: z.preprocess(emptyToUndefined, z.string().min(1).default('asra-academy-web')),
    JWT_ACCESS_TTL_MINUTES: intSetting(15, 1, 60),
    REFRESH_SESSION_TTL_DAYS: intSetting(30, 1, 90),
    PASSWORD_RESET_TTL_MINUTES: intSetting(30, 5, 24 * 60),
    EMAIL_VERIFICATION_TTL_HOURS: intSetting(24, 1, 7 * 24),

    // Refresh-token cookie. Secure defaults to true outside development/test.
    AUTH_COOKIE_SECURE: boolSetting,
    AUTH_COOKIE_SAME_SITE: z.preprocess(
      emptyToUndefined,
      z.enum(['strict', 'lax', 'none']).default('strict'),
    ),
    AUTH_COOKIE_DOMAIN: optionalString,

    // --- Email (provider: Resend — CLIENT-CLARIFICATIONS Q-01) ----------------------------
    // console: development only — prints messages (including links) to the API log.
    // memory:  automated tests only — keeps messages in process memory.
    // resend:  real delivery via Resend; requires EMAIL_API_KEY and a verified-domain EMAIL_FROM.
    EMAIL_TRANSPORT: z.preprocess(
      emptyToUndefined,
      z.enum(['console', 'memory', 'resend']).optional(),
    ),
    EMAIL_FROM: z.preprocess(
      emptyToUndefined,
      z.string().min(3).default('ASRA Academy <no-reply@localhost>'),
    ),
    // Provider API key (Resend). Secret: never logged or echoed in validation messages.
    EMAIL_API_KEY: optionalString,

    // --- Rate limiting --------------------------------------------------------------------
    // redis: shared across API instances (falls back to per-process memory if Redis is down).
    // memory: per-process only; default for tests.
    RATE_LIMIT_STORE: z.preprocess(emptyToUndefined, z.enum(['redis', 'memory']).optional()),

    // --- Payments: Razorpay (PHASE 10, docs/PAYMENTS.md) ----------------------------------
    // Mode used for NEW orders. Unset = online checkout disabled (no silent fallback to either
    // mode). Existing orders are always processed with the credentials of the mode they were
    // created in, so the other mode's keys may stay configured while its orders settle.
    RAZORPAY_MODE: z.preprocess(emptyToUndefined, z.enum(['test', 'live']).optional()),
    // Secrets: never logged, echoed in validation messages or sent to the browser.
    RAZORPAY_TEST_KEY_ID: optionalString,
    RAZORPAY_TEST_KEY_SECRET: optionalString,
    RAZORPAY_TEST_WEBHOOK_SECRET: optionalString,
    RAZORPAY_LIVE_KEY_ID: optionalString,
    RAZORPAY_LIVE_KEY_SECRET: optionalString,
    RAZORPAY_LIVE_WEBHOOK_SECRET: optionalString,
    // A production deployment (NODE_ENV=production) may run TEST mode only with this explicit
    // acknowledgement — e.g. a staging deployment. Live mode never needs it.
    RAZORPAY_ALLOW_TEST_MODE_IN_PRODUCTION: boolSetting,
    // Minutes an unpaid order stays open for checkout before a new one is created.
    PAYMENT_ORDER_TTL_MINUTES: intSetting(30, 5, 24 * 60),

    // --- Live classes: Google Meet REST API (PHASE 11, docs/LIVE-CLASSES.md §4) -------------
    // OAuth 2.0 client of the academy's Google Cloud project plus a refresh token granted by the
    // Google account that will OWN the meetings (scope meetings.space.created). All three or none:
    // unset = automatic Google Meet links are disabled and staff paste links manually.
    // Secrets: never logged, echoed in validation messages or sent to the browser.
    GOOGLE_MEET_CLIENT_ID: optionalString,
    GOOGLE_MEET_CLIENT_SECRET: optionalString,
    GOOGLE_MEET_REFRESH_TOKEN: optionalString,

    // --- File storage: Cloudinary (Recruitment resume storage) -----------------------------
    // Credentials from Cloudinary Dashboard. Required in production; optional in development.
    // Secrets: never logged, echoed in validation messages or sent to the browser.
    CLOUDINARY_CLOUD_NAME: optionalString,
    CLOUDINARY_API_KEY: optionalString,
    CLOUDINARY_API_SECRET: optionalString,
  })
  .transform((env) => ({
    ...env,
    AUTH_COOKIE_SECURE: env.AUTH_COOKIE_SECURE ?? !['development', 'test'].includes(env.NODE_ENV),
    EMAIL_TRANSPORT: env.EMAIL_TRANSPORT ?? (env.NODE_ENV === 'test' ? 'memory' : 'console'),
    RATE_LIMIT_STORE: env.RATE_LIMIT_STORE ?? (env.NODE_ENV === 'test' ? 'memory' : 'redis'),
    isCloudinaryConfigured: Boolean(
      env.CLOUDINARY_CLOUD_NAME?.trim() &&
      env.CLOUDINARY_API_KEY?.trim() &&
      env.CLOUDINARY_API_SECRET?.trim(),
    ),
  }))
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.AUTH_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_COOKIE_SECURE'],
        message: 'Must be true in production (refresh cookie requires HTTPS)',
      });
    }
    // console/memory never deliver anything. Refusing to start is safer than silently pretending
    // verification/reset emails were sent. An unset transport defaults to console, so production
    // fails closed until Resend is configured explicitly.
    if (env.EMAIL_TRANSPORT !== 'resend') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_TRANSPORT'],
        message: `"${env.EMAIL_TRANSPORT}" is a development/test transport. Set EMAIL_TRANSPORT=resend in production.`,
      });
    }
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_TRANSPORT !== 'resend') return;
    // Messages name the variable only — never its value.
    if (!env.EMAIL_API_KEY?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_API_KEY'],
        message: 'Required when EMAIL_TRANSPORT=resend',
      });
    }
    if (!isDeliverableSender(env.EMAIL_FROM)) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_FROM'],
        message:
          'Must be "address" or "Name <address>" on a domain verified in Resend (not localhost) when EMAIL_TRANSPORT=resend',
      });
    }
  })
  .superRefine((env, ctx) => {
    // Messages name variables only — never values (keys and secrets).
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    for (const mode of ['test', 'live'] as const) {
      const prefix = RAZORPAY_PREFIX[mode];
      const keyId = env[`${prefix}_KEY_ID`]?.trim();
      const keySecret = env[`${prefix}_KEY_SECRET`]?.trim();
      // A key id always belongs to exactly one environment: refuse a live key in the test slot
      // and vice versa, so test and live credentials can never be mixed up.
      if (keyId && !keyId.startsWith(`rzp_${mode}_`)) {
        issue(
          `${prefix}_KEY_ID`,
          `Must be a Razorpay ${mode}-mode key id (starts with rzp_${mode}_)`,
        );
      }
      if (Boolean(keyId) !== Boolean(keySecret)) {
        issue(
          keyId ? `${prefix}_KEY_SECRET` : `${prefix}_KEY_ID`,
          'Key id and key secret must be set together',
        );
      }
    }
    const mode = env.RAZORPAY_MODE;
    if (!mode) return;
    const prefix = RAZORPAY_PREFIX[mode];
    if (!env[`${prefix}_KEY_ID`]?.trim() || !env[`${prefix}_KEY_SECRET`]?.trim()) {
      issue(
        `${prefix}_KEY_ID`,
        `RAZORPAY_MODE=${mode} requires ${prefix}_KEY_ID and ${prefix}_KEY_SECRET`,
      );
    }
    if (mode === 'live' && env.NODE_ENV !== 'production') {
      // Development machines and automated tests must never be able to take real money.
      issue('RAZORPAY_MODE', 'Live mode is only allowed with NODE_ENV=production');
    }
    if (env.NODE_ENV !== 'production') return;
    if (!env[`${prefix}_WEBHOOK_SECRET`]?.trim()) {
      // Without webhooks a payment whose browser callback is lost is only found by reconciliation.
      issue(`${prefix}_WEBHOOK_SECRET`, `Required in production when RAZORPAY_MODE=${mode}`);
    }
    if (mode === 'test' && !env.RAZORPAY_ALLOW_TEST_MODE_IN_PRODUCTION) {
      issue(
        'RAZORPAY_MODE',
        'Test mode in production requires RAZORPAY_ALLOW_TEST_MODE_IN_PRODUCTION=true (e.g. staging)',
      );
    }
  })
  .superRefine((env, ctx) => {
    // Google Meet credentials only make sense together (messages name variables, never values).
    const google = {
      GOOGLE_MEET_CLIENT_ID: env.GOOGLE_MEET_CLIENT_ID?.trim(),
      GOOGLE_MEET_CLIENT_SECRET: env.GOOGLE_MEET_CLIENT_SECRET?.trim(),
      GOOGLE_MEET_REFRESH_TOKEN: env.GOOGLE_MEET_REFRESH_TOKEN?.trim(),
    };
    const set = Object.values(google).filter(Boolean).length;
    if (set === 0 || set === 3) return;
    for (const [name, value] of Object.entries(google)) {
      if (!value) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message:
            'GOOGLE_MEET_CLIENT_ID, GOOGLE_MEET_CLIENT_SECRET and GOOGLE_MEET_REFRESH_TOKEN must be set together',
        });
      }
    }
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_COOKIE_SAME_SITE === 'none' && !env.AUTH_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_COOKIE_SAME_SITE'],
        message: 'SameSite=None requires AUTH_COOKIE_SECURE=true',
      });
    }
  })
  .superRefine((env, ctx) => {
    // Cloudinary credentials (recruitment resume storage)
    const cloudinary = {
      CLOUDINARY_CLOUD_NAME: env.CLOUDINARY_CLOUD_NAME?.trim(),
      CLOUDINARY_API_KEY: env.CLOUDINARY_API_KEY?.trim(),
      CLOUDINARY_API_SECRET: env.CLOUDINARY_API_SECRET?.trim(),
    };
    if (env.NODE_ENV === 'production') {
      // Production resume uploads must use Cloudinary (hosted container storage is ephemeral;
      // local disk fallback would lose files on container restart/sleep).
      for (const [name, value] of Object.entries(cloudinary)) {
        if (!value) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: `${name} is required in production for Cloudinary resume storage`,
          });
        }
      }
    } else {
      // In development/test, Cloudinary is optional; if partially configured, all three must be set together.
      const set = Object.values(cloudinary).filter(Boolean).length;
      if (set > 0 && set < 3) {
        for (const [name, value] of Object.entries(cloudinary)) {
          if (!value) {
            ctx.addIssue({
              code: 'custom',
              path: [name],
              message:
                'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET must be set together',
            });
          }
        }
      }
    }
  });

/** Validates an environment without side effects (tests use this; the module parses process.env). */
export function parseEnv(source: Record<string, string | undefined>) {
  return envSchema.safeParse(source);
}

const parsed = parseEnv(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',
  // Normalised to bare origins (scheme://host[:port]) so they compare equal to `Origin` headers.
  corsOrigins: (raw.CORS_ORIGINS?.length ? raw.CORS_ORIGINS : [raw.NEXT_PUBLIC_APP_URL]).map(
    (origin) => new URL(origin).origin,
  ),
  isCloudinaryConfigured: Boolean(
    raw.CLOUDINARY_CLOUD_NAME && raw.CLOUDINARY_API_KEY && raw.CLOUDINARY_API_SECRET,
  ),
} as const;

export type Env = typeof env;
