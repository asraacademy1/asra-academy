import {
  PERMISSIONS,
  type AdminRolesDto,
  type AdminUserCapabilities,
  type AdminUserDetail,
  type AdminUserListItem,
  type DirectoryRole,
  type Paginated,
  type PermissionKey,
} from '@asra/types';
import type { AdminUserListQuery, AdminUserStatusInput } from '@asra/validation';
import { prisma } from '../../database/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthContext } from '../../types/auth.js';
import { AppError } from '../../utils/app-error.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import { courseCounts, progressFor } from '../faculty/faculty.queries.js';
import { adminOrderSelect, toAdminOrder } from '../payments/mappers.js';
import { adminAudit } from './audit.js';

/**
 * User directory and account administration (PHASE 12, docs/ADMIN-DASHBOARD.md §6.2, §7).
 *
 * Who may see/manage which account (server-side, per target):
 *  - any account holding ADMIN or SUPER_ADMIN   → `admins.manage`
 *  - otherwise a STUDENT account                → `students.manage`
 *  - otherwise a FACULTY account                → `faculty.manage`
 * Payment history additionally needs `payments.view`; role changes need `roles.manage`.
 *
 * Escalation guards (role changes): nobody changes their own roles or status; a role can only be
 * granted or revoked by someone who already holds EVERY permission of that role; admin-tier roles
 * also need `admins.manage`; the last ACTIVE Super Admin can neither be demoted nor deactivated.
 * Every change is written to the admin audit log in the same transaction.
 */

const ADMIN_TIER = new Set(['ADMIN', 'SUPER_ADMIN']);

const DIRECTORY_FILTER: Record<DirectoryRole, Prisma.UserWhereInput> = {
  STUDENT: { roles: { some: { role: { key: 'STUDENT' } } } },
  FACULTY: { roles: { some: { role: { key: 'FACULTY' } } } },
  ADMIN: { roles: { some: { role: { key: { in: [...ADMIN_TIER] } } } } },
};

const DIRECTORY_PERMISSION: Record<DirectoryRole, PermissionKey> = {
  STUDENT: PERMISSIONS.STUDENTS_MANAGE,
  FACULTY: PERMISSIONS.FACULTY_MANAGE,
  ADMIN: PERMISSIONS.ADMINS_MANAGE,
};

/** The permission needed to view/manage an account with these roles (null = nobody). */
export function permissionForTarget(roles: readonly string[]): PermissionKey | null {
  if (roles.some((role) => ADMIN_TIER.has(role))) return PERMISSIONS.ADMINS_MANAGE;
  if (roles.includes('STUDENT')) return PERMISSIONS.STUDENTS_MANAGE;
  if (roles.includes('FACULTY')) return PERMISSIONS.FACULTY_MANAGE;
  // An account without any role (or only custom roles) is administered like an admin account.
  return PERMISSIONS.ADMINS_MANAGE;
}

function canManageTarget(auth: AuthContext, roles: readonly string[]): boolean {
  const permission = permissionForTarget(roles);
  return permission !== null && auth.permissions.has(permission);
}

const notFound = (): never => {
  throw new AppError('NOT_FOUND', 'User not found');
};

const listSelect = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  status: true,
  emailVerifiedAt: true,
  createdAt: true,
  roles: { select: { role: { select: { key: true } } } },
  studentProfile: { select: { class: { select: { name: true } } } },
  facultyProfile: { select: { designation: true, _count: { select: { courses: true } } } },
  _count: { select: { enrollments: true } },
} satisfies Prisma.UserSelect;

type ListRow = Prisma.UserGetPayload<{ select: typeof listSelect }>;

function toListItem(row: ListRow, activeEnrollments: number): AdminUserListItem {
  const roles = row.roles.map(({ role }) => role.key).sort();
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    status: row.status,
    emailVerified: row.emailVerifiedAt !== null,
    roles,
    createdAt: row.createdAt.toISOString(),
    student: roles.includes('STUDENT')
      ? {
          className: row.studentProfile?.class?.name ?? null,
          activeEnrollments,
          totalEnrollments: row._count.enrollments,
        }
      : null,
    faculty: row.facultyProfile
      ? {
          designation: row.facultyProfile.designation,
          assignedCourses: row.facultyProfile._count.courses,
        }
      : null,
  };
}

async function activeEnrollmentCounts(userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await prisma.enrollment.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds }, status: 'ACTIVE' },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.userId, row._count._all]));
}

/** Roles with their permission keys, for escalation checks. */
async function roleCatalogue() {
  const roles = await prisma.role.findMany({
    select: {
      id: true,
      key: true,
      permissions: { select: { permission: { select: { key: true } } } },
    },
  });
  return new Map(
    roles.map((role) => [
      role.key,
      { id: role.id, permissions: role.permissions.map(({ permission }) => permission.key) },
    ]),
  );
}

/** May `auth` grant/revoke a role with these permissions? */
function canAssignRole(
  auth: AuthContext,
  roleKey: string,
  permissions: readonly string[],
): boolean {
  if (!auth.permissions.has(PERMISSIONS.ROLES_MANAGE)) return false;
  if (ADMIN_TIER.has(roleKey) && !auth.permissions.has(PERMISSIONS.ADMINS_MANAGE)) return false;
  return permissions.every((permission) => auth.permissions.has(permission));
}

async function capabilities(
  auth: AuthContext,
  target: { id: string; roles: string[] },
): Promise<AdminUserCapabilities> {
  const self = target.id === auth.userId;
  const manage = canManageTarget(auth, target.roles);
  const manageRoles = !self && auth.permissions.has(PERMISSIONS.ROLES_MANAGE) && manage;
  let grantableRoles: string[] = [];
  let revocableRoles: string[] = [];
  if (manageRoles) {
    const catalogue = await roleCatalogue();
    const held = new Set(target.roles);
    grantableRoles = [...catalogue]
      .filter(([key, role]) => !held.has(key) && canAssignRole(auth, key, role.permissions))
      .map(([key]) => key)
      .sort();
    revocableRoles =
      target.roles.length > 1
        ? target.roles.filter((key) =>
            canAssignRole(auth, key, catalogue.get(key)?.permissions ?? []),
          )
        : [];
  }
  return {
    changeStatus: !self && manage,
    manageRoles,
    viewPayments:
      auth.permissions.has(PERMISSIONS.PAYMENTS_VIEW) && target.roles.includes('STUDENT'),
    grantableRoles,
    revocableRoles,
  };
}

/** Locks the Super Admin assignments so "last Super Admin" checks cannot race. */
async function lockSuperAdmins(tx: Prisma.TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT u."status" FROM "user_roles" ur
    JOIN "roles" r ON r."id" = ur."role_id"
    JOIN "users" u ON u."id" = ur."user_id"
    WHERE r."key" = 'SUPER_ADMIN'
    FOR UPDATE OF ur, u`;
  return rows.filter((row) => row.status === 'ACTIVE').length;
}

async function targetRoles(tx: Prisma.TransactionClient, id: string) {
  const user = await tx.user.findUnique({
    where: { id },
    select: { id: true, status: true, roles: { select: { role: { select: { key: true } } } } },
  });
  if (!user) return notFound();
  return { ...user, roleKeys: user.roles.map(({ role }) => role.key) };
}

export const usersService = {
  async list(auth: AuthContext, query: AdminUserListQuery): Promise<Paginated<AdminUserListItem>> {
    if (!auth.permissions.has(DIRECTORY_PERMISSION[query.role])) {
      throw new AppError('FORBIDDEN', 'You do not have permission to view these accounts');
    }
    const and: Prisma.UserWhereInput[] = [DIRECTORY_FILTER[query.role]];
    if (query.q) {
      and.push({
        OR: [
          { fullName: { contains: query.q, mode: 'insensitive' } },
          { email: { contains: query.q, mode: 'insensitive' } },
          { phone: { contains: query.q } },
          ...(query.role === 'STUDENT'
            ? [
                {
                  studentProfile: {
                    studentCode: { contains: query.q, mode: 'insensitive' as const },
                  },
                },
              ]
            : []),
        ],
      });
    }
    if (query.status) and.push({ status: query.status });
    if (query.role === 'STUDENT') {
      if (query.classId) and.push({ studentProfile: { classId: query.classId } });
      if (query.enrollment === 'active') and.push({ enrollments: { some: { status: 'ACTIVE' } } });
      if (query.enrollment === 'none') and.push({ enrollments: { none: { status: 'ACTIVE' } } });
    }
    const where: Prisma.UserWhereInput = { AND: and };
    const orderBy: Prisma.UserOrderByWithRelationInput[] =
      query.sort === 'name'
        ? [{ fullName: 'asc' }, { id: 'asc' }]
        : [{ createdAt: query.sort === 'oldest' ? 'asc' : 'desc' }, { id: 'asc' }];
    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.user.findMany({ where, select: listSelect, orderBy, skip, take }),
      prisma.user.count({ where }),
    ]);
    const active = await activeEnrollmentCounts(rows.map((row) => row.id));
    return paginated(
      rows.map((row) => toListItem(row, active.get(row.id) ?? 0)),
      total,
      query,
    );
  },

  async detail(auth: AuthContext, id: string): Promise<AdminUserDetail> {
    const row = await prisma.user.findUnique({
      where: { id },
      select: {
        ...listSelect,
        updatedAt: true,
        studentProfile: {
          select: {
            studentCode: true,
            class: { select: { id: true, name: true } },
            stream: { select: { id: true, name: true } },
          },
        },
        facultyProfile: {
          select: {
            id: true,
            employeeCode: true,
            designation: true,
            specialization: true,
            experienceYears: true,
            isPublic: true,
            _count: { select: { courses: true } },
          },
        },
      },
    });
    if (!row) return notFound();
    const roles = row.roles.map(({ role }) => role.key).sort();
    // 404 rather than 403: an administrator without the matching permission learns nothing.
    if (!canManageTarget(auth, roles)) return notFound();

    const isStudent = roles.includes('STUDENT');
    const caps = await capabilities(auth, { id, roles });
    const [lastSession, enrollmentRows, orders, teachingRows] = await Promise.all([
      prisma.authSession.findFirst({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      isStudent
        ? prisma.enrollment.findMany({
            where: { userId: id },
            select: {
              id: true,
              userId: true,
              courseId: true,
              status: true,
              source: true,
              enrolledAt: true,
              cancelledAt: true,
              completedAt: true,
              lastActivityAt: true,
              course: { select: { title: true } },
            },
            orderBy: [{ enrolledAt: 'desc' }, { id: 'asc' }],
            take: 50,
          })
        : null,
      caps.viewPayments
        ? prisma.order.findMany({
            where: { userId: id },
            select: adminOrderSelect,
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            take: 20,
          })
        : null,
      row.facultyProfile
        ? prisma.courseInstructor.findMany({
            where: { facultyProfileId: row.facultyProfile.id },
            select: {
              isPrimary: true,
              assignedAt: true,
              course: { select: { id: true, title: true, status: true } },
            },
            orderBy: [{ assignedAt: 'desc' }],
          })
        : null,
    ]);

    const [progress, counts] = await Promise.all([
      enrollmentRows ? progressFor(enrollmentRows) : null,
      teachingRows ? courseCounts(teachingRows.map((t) => t.course.id)) : null,
    ]);
    const active = enrollmentRows?.filter((e) => e.status === 'ACTIVE').length ?? 0;

    return {
      ...toListItem(
        {
          ...row,
          studentProfile: row.studentProfile ? { class: row.studentProfile.class } : null,
        },
        active,
      ),
      updatedAt: row.updatedAt.toISOString(),
      lastSignInAt: lastSession?.createdAt.toISOString() ?? null,
      studentProfile: row.studentProfile
        ? {
            studentCode: row.studentProfile.studentCode,
            class: row.studentProfile.class,
            stream: row.studentProfile.stream,
          }
        : null,
      facultyProfile: row.facultyProfile
        ? {
            facultyProfileId: row.facultyProfile.id,
            employeeCode: row.facultyProfile.employeeCode,
            designation: row.facultyProfile.designation,
            specialization: row.facultyProfile.specialization,
            experienceYears: row.facultyProfile.experienceYears,
            isPublic: row.facultyProfile.isPublic,
          }
        : null,
      enrollments:
        enrollmentRows?.map((e, index) => ({
          id: e.id,
          course: { id: e.courseId, title: e.course.title },
          status: e.status,
          source: e.source,
          enrolledAt: e.enrolledAt.toISOString(),
          cancelledAt: e.cancelledAt?.toISOString() ?? null,
          completedAt: e.completedAt?.toISOString() ?? null,
          lastActivityAt: e.lastActivityAt?.toISOString() ?? null,
          progress: progress!.progress[index]!,
        })) ?? null,
      orders: orders?.map(toAdminOrder) ?? null,
      teaching:
        teachingRows?.map((t) => {
          const c = counts?.get(t.course.id);
          return {
            course: t.course,
            isPrimary: t.isPrimary,
            assignedAt: t.assignedAt.toISOString(),
            activeStudents: c?.activeStudents ?? 0,
            pendingReviews: c?.pendingReviews ?? 0,
            upcomingClasses: c?.upcomingClasses ?? 0,
          };
        }) ?? null,
      capabilities: caps,
    };
  },

  /**
   * ACTIVE / INACTIVE / SUSPENDED. A non-ACTIVE account is refused at sign-in, at token refresh
   * and on every authenticated request (the status is re-read each time), so access ends at once.
   */
  async setStatus(
    auth: AuthContext,
    id: string,
    input: AdminUserStatusInput,
  ): Promise<AdminUserDetail> {
    if (id === auth.userId) {
      throw new AppError('FORBIDDEN', 'You cannot change the status of your own account');
    }
    await prisma.$transaction(async (tx) => {
      const activeSuperAdmins = await lockSuperAdmins(tx);
      const target = await targetRoles(tx, id);
      if (!canManageTarget(auth, target.roleKeys)) notFound();
      if (target.status === input.status) return;
      if (
        target.roleKeys.includes('SUPER_ADMIN') &&
        target.status === 'ACTIVE' &&
        activeSuperAdmins <= 1
      ) {
        throw new AppError('CONFLICT', 'The last active Super Admin cannot be deactivated.');
      }
      await tx.user.update({ where: { id }, data: { status: input.status } });
      await adminAudit(tx, {
        action: 'user.status_changed',
        actorId: auth.userId,
        entityType: 'user',
        entityId: id,
        data: {
          from: target.status,
          to: input.status,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
    });
    return usersService.detail(auth, id);
  },

  async grantRole(auth: AuthContext, id: string, roleKey: string): Promise<AdminUserDetail> {
    if (id === auth.userId) throw new AppError('FORBIDDEN', 'You cannot change your own roles');
    await prisma.$transaction(async (tx) => {
      await lockSuperAdmins(tx);
      const target = await targetRoles(tx, id);
      if (!canManageTarget(auth, target.roleKeys)) notFound();
      const role = await tx.role.findUnique({
        where: { key: roleKey },
        select: {
          id: true,
          key: true,
          permissions: { select: { permission: { select: { key: true } } } },
        },
      });
      if (!role) throw new AppError('NOT_FOUND', 'Role not found');
      const permissions = role.permissions.map(({ permission }) => permission.key);
      if (!canAssignRole(auth, role.key, permissions)) {
        throw new AppError(
          'FORBIDDEN',
          'You cannot grant a role that has permissions you do not hold yourself',
        );
      }
      if (target.roleKeys.includes(role.key)) {
        throw new AppError('CONFLICT', 'The user already has this role');
      }
      await tx.userRole.create({ data: { userId: id, roleId: role.id } });
      // Role-specific data lives in profiles; teaching and learning need one.
      if (role.key === 'STUDENT') {
        await tx.studentProfile.upsert({
          where: { userId: id },
          create: { userId: id },
          update: {},
        });
      }
      if (role.key === 'FACULTY') {
        await tx.facultyProfile.upsert({
          where: { userId: id },
          create: { userId: id },
          update: {},
        });
      }
      await adminAudit(tx, {
        action: 'user.role_granted',
        actorId: auth.userId,
        entityType: 'user',
        entityId: id,
        data: { role: role.key, rolesBefore: target.roleKeys },
      });
    });
    return usersService.detail(auth, id);
  },

  async revokeRole(auth: AuthContext, id: string, roleKey: string): Promise<AdminUserDetail> {
    if (id === auth.userId) throw new AppError('FORBIDDEN', 'You cannot change your own roles');
    await prisma.$transaction(async (tx) => {
      const activeSuperAdmins = await lockSuperAdmins(tx);
      const target = await targetRoles(tx, id);
      if (!canManageTarget(auth, target.roleKeys)) notFound();
      const role = await tx.role.findUnique({
        where: { key: roleKey },
        select: {
          id: true,
          key: true,
          permissions: { select: { permission: { select: { key: true } } } },
        },
      });
      if (!role || !target.roleKeys.includes(role.key)) {
        throw new AppError('NOT_FOUND', 'The user does not have this role');
      }
      const permissions = role.permissions.map(({ permission }) => permission.key);
      if (!canAssignRole(auth, role.key, permissions)) {
        throw new AppError(
          'FORBIDDEN',
          'You cannot revoke a role that has permissions you do not hold yourself',
        );
      }
      if (target.roleKeys.length <= 1) {
        throw new AppError(
          'CONFLICT',
          'A user must keep at least one role. Deactivate the account instead.',
        );
      }
      if (role.key === 'SUPER_ADMIN' && target.status === 'ACTIVE' && activeSuperAdmins <= 1) {
        throw new AppError('CONFLICT', 'The last active Super Admin cannot lose that role.');
      }
      if (role.key === 'FACULTY') {
        const assignments = await tx.courseInstructor.count({
          where: { facultyProfile: { userId: id } },
        });
        if (assignments > 0) {
          throw new AppError(
            'CONFLICT',
            'This faculty member is still assigned to courses. Remove the course assignments first.',
          );
        }
      }
      await tx.userRole.delete({ where: { userId_roleId: { userId: id, roleId: role.id } } });
      await adminAudit(tx, {
        action: 'user.role_revoked',
        actorId: auth.userId,
        entityType: 'user',
        entityId: id,
        data: { role: role.key, rolesBefore: target.roleKeys },
      });
    });
    return usersService.detail(auth, id);
  },

  /** `GET /admin/roles` — read-only matrix (custom roles are pending S-01). */
  async roles(): Promise<AdminRolesDto> {
    const [roles, permissions] = await Promise.all([
      prisma.role.findMany({
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          isSystem: true,
          permissions: { select: { permission: { select: { key: true } } } },
          _count: { select: { users: true } },
        },
        orderBy: [{ isSystem: 'desc' }, { key: 'asc' }],
      }),
      prisma.permission.findMany({
        select: { key: true, description: true },
        orderBy: { key: 'asc' },
      }),
    ]);
    return {
      roles: roles.map((role) => ({
        id: role.id,
        key: role.key,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        permissions: role.permissions.map(({ permission }) => permission.key).sort(),
        userCount: role._count.users,
      })),
      permissions,
    };
  },
};
