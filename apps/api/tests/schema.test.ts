import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { resolvePrismaCliDatasourceUrl } from '../prisma.config.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';

/** Runs the Prisma CLI against the test database (env from tests/setup-env.ts). */
function prismaCli(args: string[]) {
  return spawnSync('npx', ['prisma', ...args], { encoding: 'utf8', env: process.env });
}

after(() => disconnectPrisma());

describe('Prisma schema & migrations', () => {
  it('validates the schema', () => {
    const result = prismaCli(['validate']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it('has every committed migration applied to the test database', () => {
    const result = prismaCli(['migrate', 'status']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Database schema is up to date/);
  });

  it('migrations produce exactly the schema in schema.prisma (no drift)', () => {
    // Exit code: 0 = no difference, 2 = difference, 1 = error.
    const result = prismaCli([
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--exit-code',
    ]);
    assert.equal(result.status, 0, `Schema drift detected:\n${result.stdout}${result.stderr}`);
  });

  it('generated client exposes every Phase 02 model', () => {
    const models = [
      'user',
      'role',
      'permission',
      'userRole',
      'rolePermission',
      'studentProfile',
      'facultyProfile',
      'academicLevel',
      'class',
      'stream',
      'subject',
      'course',
      'courseCategory',
      'courseInstructor',
      'module',
      'chapter',
      'lesson',
      'resource',
    ] as const;
    for (const model of models) {
      assert.equal(typeof prisma[model].findMany, 'function', `prisma.${model} missing`);
    }
  });

  it('database enforces the hand-written CHECK constraints', async () => {
    const rows = await prisma.$queryRaw<{ name: string }[]>`
      SELECT conname AS name FROM pg_constraint WHERE contype = 'c' ORDER BY conname
    `;
    const names = rows.map((row) => row.name);
    for (const expected of [
      'users_email_normalized',
      'roles_key_format',
      'permissions_key_format',
      'courses_slug_format',
      'courses_published_at_required',
      'resources_location_exclusive',
      'modules_position_non_negative',
      // PHASE 06
      'courses_duration_minutes_positive',
      'courses_price_minor_non_negative',
      'courses_price_currency_consistent',
      'courses_currency_format',
      'courses_discount_consistent',
      'courses_discount_requires_price',
      'courses_discount_value_valid',
      'courses_thumbnail_location_exclusive',
      'courses_thumbnail_url_https',
    ]) {
      assert.ok(names.includes(expected), `missing CHECK constraint ${expected}`);
    }
  });

  it('adds connect_timeout=20 to remote Prisma CLI datasource URLs without duplicating parameters', () => {
    const remote =
      'postgresql://user:p%40ss@ep-calm-pond.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
    const resolved = resolvePrismaCliDatasourceUrl(remote);
    assert.ok(resolved);
    const parsed = new URL(resolved);
    assert.equal(parsed.username, 'user');
    assert.equal(parsed.password, 'p%40ss');
    assert.equal(parsed.hostname, 'ep-calm-pond.ap-southeast-1.aws.neon.tech');
    assert.equal(parsed.pathname, '/neondb');
    assert.equal(parsed.searchParams.get('sslmode'), 'require');
    assert.equal(parsed.searchParams.get('channel_binding'), 'require');
    assert.deepEqual(parsed.searchParams.getAll('connect_timeout'), ['20']);

    // Idempotent when already resolved or when an explicit connect_timeout is supplied.
    assert.equal(resolvePrismaCliDatasourceUrl(resolved), resolved);
    const customTimeout =
      'postgresql://user:pass@ep-calm-pond.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&connect_timeout=30';
    assert.equal(resolvePrismaCliDatasourceUrl(customTimeout), customTimeout);

    // Local development / test URLs stay unmodified.
    const localUrl = 'postgresql://asra:local@localhost:5432/asra_academy_test?schema=public';
    assert.equal(resolvePrismaCliDatasourceUrl(localUrl), localUrl);
    assert.equal(resolvePrismaCliDatasourceUrl(''), undefined);
    assert.equal(resolvePrismaCliDatasourceUrl(undefined), undefined);
  });
});
