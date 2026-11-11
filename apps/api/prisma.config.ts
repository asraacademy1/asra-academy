import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Environment lives in the monorepo root `.env`; an `apps/api/.env` (if present) takes precedence.
loadEnv({
  path: [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')],
  quiet: true,
});

/**
 * Local hosts connect cleanly over loopback without waiting on unreachable IPv6 addresses.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);
const REMOTE_CLI_CONNECT_TIMEOUT_SECONDS = '20';

/**
 * Ensures Prisma CLI connections to remote PostgreSQL hosts (e.g. Neon) allow enough time to
 * fail through unreachable IPv6 addresses (~4s each) before falling back to IPv4, without
 * altering credentials, SSL/channel-binding parameters, existing `connect_timeout`, or runtime URLs.
 */
export function resolvePrismaCliDatasourceUrl(rawUrl: string | undefined): string | undefined {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (
      !LOCAL_HOSTS.has(parsed.hostname.toLowerCase()) &&
      !parsed.searchParams.has('connect_timeout')
    ) {
      parsed.searchParams.set('connect_timeout', REMOTE_CLI_CONNECT_TIMEOUT_SECONDS);
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

/**
 * Migrations and Prisma CLI commands use a *direct* (non-pooled) connection.
 * - Neon (production): DIRECT_DATABASE_URL = direct endpoint, DATABASE_URL = pooled endpoint.
 * - Local Docker: both point at the same PostgreSQL container.
 * Runtime queries use DATABASE_URL through the driver adapter in src/lib/prisma.ts.
 */
const migrationUrl = resolvePrismaCliDatasourceUrl(
  process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL,
);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  ...(migrationUrl ? { datasource: { url: migrationUrl } } : {}),
});
