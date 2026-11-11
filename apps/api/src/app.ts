import type { IncomingMessage, ServerResponse } from 'node:http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import helmetImport, { type HelmetOptions } from 'helmet';
import { API_PREFIX } from './config/constants.js';
import { env } from './config/env.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { requestLogger } from './middleware/request-logger.js';
import { paymentWebhooksRouter } from './modules/payments/payments.routes.js';
import { apiRouter } from './routes/index.js';

/**
 * Helmet's default export is its middleware factory. The explicit type keeps that true under
 * Vercel's Express builder, which type-checks without the ESM resolution mode, picks Helmet's
 * CommonJS typings (index.d.cts) and would otherwise see the module object (TS2349).
 * A tsconfig `paths` pin cannot fix this: tsx applies `paths` at runtime too.
 */
const helmet = helmetImport as unknown as (options?: Readonly<HelmetOptions>) => RequestHandler;

/** Builds the Express application without binding a port (keeps it testable). */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Behind a reverse proxy / load balancer in hosted environments.
  app.set('trust proxy', env.isProduction ? 1 : false);

  app.use(requestLogger);
  // JSON-only API: Helmet's defaults (nosniff, HSTS, frameguard, a deny-all CSP, CORP …) are
  // appropriate as-is — the API serves no HTML, scripts or styles.
  app.use(helmet());
  app.use(
    cors({
      // Explicit allow-list (never `*`): required because credentials (the refresh cookie) are
      // allowed. Unknown origins get no CORS headers, so browsers block their reads.
      origin: env.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: [
        'Content-Disposition',
        'X-Request-Id',
        'Retry-After',
        'RateLimit',
        'RateLimit-Policy',
      ],
      maxAge: 600,
    }),
  );
  // Default-deny caching (PHASE 14): nothing the API returns may be stored by a browser or shared
  // cache unless its route opts in explicitly after success — only the anonymous public catalogue
  // does (PUBLIC_CATALOGUE_CACHE_CONTROL). Personal data can't leak through a CDN because a new
  // route forgot its header. Routers that already set `no-store` keep doing so.
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(cookieParser());
  // Payment webhooks need the RAW body for signature verification (docs/PAYMENTS.md §7), so they
  // are mounted before the JSON parser, which would otherwise consume and transform it.
  app.use(`${API_PREFIX}/payments/webhooks`, paymentWebhooksRouter);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.use(API_PREFIX, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

let serverlessApp: Express | undefined;

/**
 * Vercel entrypoint: the Express preset deploys this file (the first one importing `express`) and
 * calls its default export per request. `server.ts` remains the long-running entrypoint. The app
 * is built on first request so importing `createApp` elsewhere doesn't construct a second one.
 */
export default function serverlessHandler(req: IncomingMessage, res: ServerResponse): void {
  serverlessApp ??= createApp();
  serverlessApp(req, res);
}
