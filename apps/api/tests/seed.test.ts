import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PERMISSIONS, USER_ROLES } from '@asra/types';
import { QUIZORA_2026_TEMPLATE_KEY } from '@asra/validation';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { PERMISSION_DEFINITIONS, SYSTEM_ROLES } from '../src/database/seed/access-control.data.js';
import {
  SEED_TRANSACTION_OPTIONS,
  seedAccessControl,
} from '../src/database/seed/access-control.seed.js';
import { seedCertificateDefaults } from '../src/modules/certificates/bootstrap.js';
import { LEGACY_CERTIFICATE_TEMPLATES } from '../src/modules/certificates/templates.data.js';

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
  it('initializes the ASRA QUIZORA 2026 template and singleton settings idempotently without demo certificates or users', async () => {
    await prisma.certificateSettings.deleteMany();
    await prisma.certificateTemplateSignature.deleteMany();
    await prisma.certificateTemplate.deleteMany();

    const usersBefore = await prisma.user.count();
    const certsBefore = await prisma.certificate.count();
    const sigsBefore = await prisma.certificateSignature.count();

    const first = await seedCertificateDefaults(prisma);
    assert.equal(first.templates, 2); // Design 1 (default) + Design 2
    assert.equal(first.settingsReady, true);
    const quizora = await prisma.certificateTemplate.findUniqueOrThrow({
      where: { key: QUIZORA_2026_TEMPLATE_KEY },
    });
    assert.equal(quizora.style, 'QUIZORA_PARTICIPATION');
    assert.equal(quizora.isActive, true);
    assert.equal(quizora.isDefault, true);
    assert.equal(
      (await prisma.certificateSettings.findUniqueOrThrow({ where: { id: 'default' } }))
        .defaultTemplateId,
      quizora.id,
    );

    // Customize the template & settings to verify repeat seed never overwrites production edits
    await prisma.certificateTemplate.update({
      where: { key: QUIZORA_2026_TEMPLATE_KEY },
      data: { defaultBodyText: 'has successfully attempted the {title} on {date}.' },
    });
    await prisma.certificateSettings.update({
      where: { id: 'default' },
      data: { academyName: 'ASRA Custom Production Title' },
    });

    const second = await seedCertificateDefaults(prisma);
    assert.equal(second.templates, 2);
    assert.equal(second.settingsReady, true);

    const reloaded = await prisma.certificateTemplate.findUniqueOrThrow({
      where: { key: QUIZORA_2026_TEMPLATE_KEY },
    });
    const settings = await prisma.certificateSettings.findUniqueOrThrow({
      where: { id: 'default' },
    });
    assert.equal(reloaded.defaultBodyText, 'has successfully attempted the {title} on {date}.');
    assert.equal(settings.academyName, 'ASRA Custom Production Title');

    assert.equal(await prisma.user.count(), usersBefore);
    assert.equal(await prisma.certificate.count(), certsBefore);
    assert.equal(await prisma.certificateSignature.count(), sigsBefore);
  });

  it('archives (never deletes) pre-existing legacy templates and moves the default to QUIZORA', async () => {
    await prisma.certificateSettings.deleteMany();
    await prisma.certificateTemplateSignature.deleteMany();
    await prisma.certificateTemplate.deleteMany();

    // Simulate a production database seeded before the replacement (Classic = default).
    const legacyIds: string[] = [];
    for (const tpl of LEGACY_CERTIFICATE_TEMPLATES) {
      const row = await prisma.certificateTemplate.create({
        data: {
          key: tpl.key,
          name: tpl.name,
          style: tpl.style,
          description: tpl.description,
          defaultTitle: tpl.defaultTitle,
          defaultSubtitle: tpl.defaultSubtitle,
          defaultBodyText: tpl.defaultBodyText,
          issuingAuthority: tpl.issuingAuthority,
          config: tpl.config as unknown as object,
          isActive: true,
          isDefault: tpl.isDefault,
        },
      });
      legacyIds.push(row.id);
    }
    await prisma.certificateSettings.create({
      data: { id: 'default', defaultTemplateId: legacyIds[0]! },
    });

    const result = await seedCertificateDefaults(prisma);
    assert.equal(result.templates, 5, 'legacy rows are kept for history');

    const legacyRows = await prisma.certificateTemplate.findMany({
      where: { id: { in: legacyIds } },
    });
    assert.equal(legacyRows.length, 3);
    assert.ok(legacyRows.every((r) => !r.isActive && !r.isDefault));

    const quizora = await prisma.certificateTemplate.findUniqueOrThrow({
      where: { key: QUIZORA_2026_TEMPLATE_KEY },
    });
    assert.equal(quizora.isActive, true);
    assert.equal(quizora.isDefault, true);
    const settings = await prisma.certificateSettings.findUniqueOrThrow({
      where: { id: 'default' },
    });
    assert.equal(settings.defaultTemplateId, quizora.id);

    const archivedAudits = await prisma.certificateAuditLog.findMany({
      where: { action: 'template.archived', entityId: { in: legacyIds } },
    });
    assert.equal(archivedAudits.length, 3);

    // Idempotent: a second run writes nothing new
    await seedCertificateDefaults(prisma);
    assert.equal(
      await prisma.certificateAuditLog.count({
        where: { action: 'template.archived', entityId: { in: legacyIds } },
      }),
      3,
    );
  });
});
