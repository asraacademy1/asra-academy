/**
 * Database seed entry point (`npm run db:seed`, also run by `npm run db:reset`).
 *
 * Seeds ONLY foundational reference data and is safe to run repeatedly:
 *   - system roles: SUPER_ADMIN, ADMIN, FACULTY, STUDENT
 *   - the initial permission catalogue and role → permission grants
 *   - the three default certificate templates and singleton certificate settings
 *
 * It deliberately creates NO user accounts (no default admin, no passwords), NO sample
 * certificates, and NO academic catalogue (classes, subjects, courses). See docs/DATABASE.md §Seed.
 */
import { seedAccessControl } from '../src/database/seed/access-control.seed.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { seedCertificateDefaults } from '../src/modules/certificates/bootstrap.js';

async function main(): Promise<void> {
  const [row] = await prisma.$queryRaw<{ database: string }[]>`
    SELECT current_database() AS database
  `;
  console.log(`[seed] Seeding database "${row?.database}"`);

  const rbac = await seedAccessControl(prisma);
  console.log(
    `[seed] Roles: ${rbac.roles} · Permissions: ${rbac.permissions} · ` +
      `New role grants: ${rbac.grantsAdded}`,
  );

  const certs = await seedCertificateDefaults(prisma);
  console.log(
    `[seed] Certificate templates: ${certs.templates} · Settings initialized: ${certs.settingsReady}`,
  );
  console.log('[seed] Done.');
}

main()
  .catch((error: unknown) => {
    console.error('[seed] Failed:', error);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
