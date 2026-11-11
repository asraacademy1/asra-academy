import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PERMISSIONS, USER_ROLES } from '@asra/types';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { PERMISSION_DEFINITIONS, SYSTEM_ROLES } from '../src/database/seed/access-control.data.js';
import {
  SEED_TRANSACTION_OPTIONS,
  seedAccessControl,
} from '../src/database/seed/access-control.seed.js';
import { seedCertificateDefaults } from '../src/modules/certificates/bootstrap.js';

type TransactionArgs = Parameters<typeof prisma.$transaction>;

async function snapshot() {
  const [roles, permissions, grants] = await Promise.all([
    prisma.role.count(),
    prisma.permission.count(),
    prisma.rolePermission.count(),
  ]);
  return { roles, permissions, grants };
}

after(() => disconnectPrisma());

describe('access-control seed', () => {
  before(async () => {
    // Start from empty RBAC tables so counts are exact. No users exist in the test database.
    await prisma.userRole.deleteMany();
    await prisma.rolePermission.deleteMany();
    await prisma.role.deleteMany();
    await prisma.permission.deleteMany();
  });

  it('creates the four system roles', async () => {
    const result = await seedAccessControl(prisma);
    assert.equal(result.roles, 4);

    const roles = await prisma.role.findMany({ orderBy: { key: 'asc' } });
    assert.deepEqual(
      roles.map((role) => role.key),
      [...USER_ROLES].sort(),
    );
    assert.ok(roles.every((role) => role.isSystem));
  });

  it('creates every defined permission and grants them per role', async () => {
    const permissions = await prisma.permission.findMany();
    assert.equal(permissions.length, Object.keys(PERMISSION_DEFINITIONS).length);

    for (const definition of SYSTEM_ROLES) {
      const role = await prisma.role.findUniqueOrThrow({
        where: { key: definition.key },
        include: { permissions: { include: { permission: true } } },
      });
      assert.deepEqual(
        role.permissions.map((grant) => grant.permission.key).sort(),
        [...definition.permissions].sort(),
        `grants for ${definition.key}`,
      );
    }

    const superAdmin = await prisma.role.findUniqueOrThrow({
      where: { key: 'SUPER_ADMIN' },
      include: { _count: { select: { permissions: true } } },
    });
    assert.equal(superAdmin._count.permissions, permissions.length);
  });

  it('is idempotent: re-running creates no duplicates', async () => {
    const first = await snapshot();
    const rerun = await seedAccessControl(prisma);
    const again = await seedAccessControl(prisma);
    assert.equal(rerun.grantsAdded, 0);
    assert.equal(again.grantsAdded, 0);
    assert.deepEqual(await snapshot(), first);
  });

  it('runs in one transaction with limits above Prisma defaults (remote Neon latency)', async () => {
    let options: unknown;
    const recorder = {
      $transaction: (work: TransactionArgs[0], opts: TransactionArgs[1]) => {
        options = opts;
        return prisma.$transaction(work, opts);
      },
    } as unknown as typeof prisma;

    await seedAccessControl(recorder);
    assert.deepEqual(options, SEED_TRANSACTION_OPTIONS);
    assert.ok(SEED_TRANSACTION_OPTIONS.timeout > 5_000);
    assert.ok(SEED_TRANSACTION_OPTIONS.maxWait > 2_000);
  });

  it('keeps grants added outside the seed (additive sync)', async () => {
    const student = await prisma.role.findUniqueOrThrow({ where: { key: 'STUDENT' } });
    const extra = await prisma.permission.findUniqueOrThrow({
      where: { key: PERMISSIONS.COURSES_MANAGE },
    });
    await prisma.rolePermission.create({ data: { roleId: student.id, permissionId: extra.id } });

    await seedAccessControl(prisma);
    const kept = await prisma.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId: student.id, permissionId: extra.id } },
    });
    assert.ok(kept);
    await prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId: student.id, permissionId: extra.id } },
    });
  });

  it('is atomic: a failure on the last statement leaves no partial RBAC data', async () => {
    await prisma.rolePermission.deleteMany();
    await prisma.role.deleteMany();
    await prisma.permission.deleteMany();

    // Fail the final grant insert, after every role and permission upsert has run.
    const failing = {
      $transaction: (work: TransactionArgs[0], opts: TransactionArgs[1]) =>
        prisma.$transaction(
          (tx) =>
            work(
              new Proxy(tx, {
                get: (target, property, receiver) =>
                  property === 'rolePermission'
                    ? { createMany: () => Promise.reject(new Error('simulated failure')) }
                    : Reflect.get(target, property, receiver),
              }),
            ),
          opts,
        ),
    } as unknown as typeof prisma;

    await assert.rejects(seedAccessControl(failing), /simulated failure/);
    assert.deepEqual(await snapshot(), { roles: 0, permissions: 0, grants: 0 });

    await seedAccessControl(prisma);
    assert.equal((await snapshot()).roles, SYSTEM_ROLES.length);
  });
});

describe('certificate defaults seed', () => {
  it('initializes the 3 default templates and singleton settings idempotently without demo certificates or users', async () => {
    await prisma.certificateSettings.deleteMany();
    await prisma.certificateTemplateSignature.deleteMany();
    await prisma.certificateTemplate.deleteMany();

    const usersBefore = await prisma.user.count();
    const certsBefore = await prisma.certificate.count();
    const sigsBefore = await prisma.certificateSignature.count();

    const first = await seedCertificateDefaults(prisma);
    assert.equal(first.templates, 3);
    assert.equal(first.settingsReady, true);

    // Customize one template & settings to verify repeat seed never overwrites production edits
    await prisma.certificateTemplate.update({
      where: { key: 'classic-institutional' },
      data: { defaultTitle: 'CUSTOM ACADEMY TITLE' },
    });
    await prisma.certificateSettings.update({
      where: { id: 'default' },
      data: { academyName: 'ASRA Custom Production Title' },
    });

    const second = await seedCertificateDefaults(prisma);
    assert.equal(second.templates, 3);
    assert.equal(second.settingsReady, true);

    const classic = await prisma.certificateTemplate.findUniqueOrThrow({
      where: { key: 'classic-institutional' },
    });
    const settings = await prisma.certificateSettings.findUniqueOrThrow({
      where: { id: 'default' },
    });
    assert.equal(classic.defaultTitle, 'CUSTOM ACADEMY TITLE');
    assert.equal(settings.academyName, 'ASRA Custom Production Title');

    assert.equal(await prisma.user.count(), usersBefore);
    assert.equal(await prisma.certificate.count(), certsBefore);
    assert.equal(await prisma.certificateSignature.count(), sigsBefore);
  });
});
