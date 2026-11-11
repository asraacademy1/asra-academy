/**
 * Build-time deployment configuration for `next.config.ts` (PHASE 14, docs/SECURITY.md).
 * Plain TypeScript without path aliases: it is imported by next.config.ts and by tests.
 */

/** Third-party origins the browser genuinely talks to. Keep in sync with the features using them. */
const RAZORPAY = 'https://*.razorpay.com'; // Checkout script (checkout.*), its iframe and API (api.*)
const VIDEO_EMBEDS = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com']; // video-player.tsx

interface HeaderOptions {
  /** `NEXT_PUBLIC_API_URL` — the browser calls the API directly (auth, portals, verification). */
  apiUrl: string;
  /** `NEXT_PUBLIC_APP_URL` — the site's own canonical origin. */
  appUrl: string;
  isDev: boolean;
}

/**
 * Content-Security-Policy without nonces (Next.js guide "Without Nonces"): pages stay statically
 * prerendered and CDN-cacheable. `'unsafe-inline'` scripts are required by Next.js' inline
 * bootstrap without nonces, so the policy's value is in what it forbids: scripts from any other
 * host, plugins, `<base>` hijacking, framing by other sites, and form posts or connections to
 * unexpected origins.
 */
export function buildContentSecurityPolicy({ apiUrl, appUrl, isDev }: HeaderOptions): string {
  const apiOrigin = new URL(apiUrl).origin;
  const secure = new URL(appUrl).protocol === 'https:' && new URL(apiUrl).protocol === 'https:';
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      "'unsafe-inline'",
      ...(isDev ? ["'unsafe-eval'"] : []),
      'https://checkout.razorpay.com',
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    // Course thumbnails are administrator-supplied HTTPS URLs on any host (DB CHECK: https only).
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", apiOrigin, RAZORPAY, ...(isDev ? ['ws:'] : [])],
    // Directly hosted lesson videos (any HTTPS host) play in a native <video>.
    'media-src': ["'self'", 'blob:', 'https:'],
    // Same-origin blob URLs allow authenticated PDF previews inside <iframe> modals without
    // making private documents public or permitting <object>/<embed>.
    'frame-src': ["'self'", 'blob:', ...VIDEO_EMBEDS, RAZORPAY],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'", RAZORPAY],
    'frame-ancestors': ["'none'"],
  };
  const policy = Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`);
  // Only when both origins are HTTPS: on a plain-http local build it would break API calls.
  if (secure && !isDev) policy.push('upgrade-insecure-requests');
  return policy.join('; ');
}

export function buildSecurityHeaders(options: HeaderOptions): { key: string; value: string }[] {
  const headers = [
    { key: 'Content-Security-Policy', value: buildContentSecurityPolicy(options) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // Legacy equivalent of `frame-ancestors 'none'` for older browsers (clickjacking).
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    },
    // Razorpay may open a bank/UPI pop-up that must keep its opener.
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  ];
  if (!options.isDev && new URL(options.appUrl).protocol === 'https:') {
    // No includeSubDomains/preload: other subdomains of the academy's domain are not ours to pin.
    headers.push({ key: 'Strict-Transport-Security', value: 'max-age=63072000' });
  }
  return headers;
}

/**
 * Indexing must only ever be switched on for the real public domain (CLIENT-CLARIFICATIONS W-04):
 * canonical URLs, Open Graph URLs and the sitemap are all derived from NEXT_PUBLIC_APP_URL, so a
 * localhost or preview origin would be published to search engines. Fails the build instead.
 */
export function assertIndexableSiteUrl(appUrl: string | undefined): void {
  let url: URL;
  try {
    url = new URL(appUrl ?? '');
  } catch {
    throw new Error('SITE_INDEXING_ENABLED=true requires NEXT_PUBLIC_APP_URL to be set');
  }
  const host = url.hostname;
  const problems = [
    url.protocol !== 'https:' && 'must use https',
    (host === 'localhost' || /^(127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(host)) &&
      'must not be a local address',
    host.endsWith('.vercel.app') && 'must be the production domain, not a *.vercel.app preview',
    url.pathname !== '/' && 'must be an origin without a path',
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new Error(
      `SITE_INDEXING_ENABLED=true but NEXT_PUBLIC_APP_URL (${url.origin}) ${problems.join(', ')}`,
    );
  }
}
