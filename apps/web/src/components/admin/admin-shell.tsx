'use client';

import { PERMISSIONS } from '@asra/types';
import {
  Award,
  BarChart3,
  Bell,
  BookOpen,
  Briefcase,
  ClipboardList,
  CreditCard,
  FileText,
  FolderTree,
  GraduationCap,
  History,
  KeyRound,
  Layers,
  LayoutDashboard,
  Loader2,
  LogOut,
  Mail,
  MonitorPlay,
  School,
  ShieldAlert,
  ShieldCheck,
  Shapes,
  Split,
  Trophy,
  UserRoundCheck,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { AdminLayout } from '@/components/layout/admin-layout';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import type { NavGroup, NavItem } from '@/lib/navigation';

import { canUseAdminPortal, hasPermission } from './use-admin';

/**
 * Session gate + shell for `/admin/*`. This decides what the UI shows; it is NOT the security
 * boundary — every `/api/v1/admin/*` endpoint re-checks authentication, permissions and
 * resource access on the server.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const { status, user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (status === 'anonymous') {
      router.replace(`/login?next=${encodeURIComponent(pathname ?? '/admin')}`);
    }
  }, [status, router, pathname]);

  if (status !== 'authenticated' || !user) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <p role="status" className="flex items-center gap-2 type-body text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {status === 'loading' ? 'Checking your session…' : 'Redirecting to sign in…'}
        </p>
      </main>
    );
  }

  if (!canUseAdminPortal(user)) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="grid max-w-md justify-items-center gap-4 rounded-2xl border bg-card p-8 text-center shadow-card">
          <ShieldAlert className="size-10 text-destructive" aria-hidden />
          <h1 className="type-h2 text-heading">No access to administration</h1>
          <p className="type-body text-muted-foreground">
            You are signed in as {user.email}, which does not have administration permissions.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild variant="outline">
              <Link href="/">Go to the website</Link>
            </Button>
            <Button onClick={() => void logout()}>Sign out</Button>
          </div>
        </div>
      </main>
    );
  }

  const can = (permission: string) => hasPermission(user, permission);
  const navigation = buildNavigation(can);
  const pageAllowed = canAccessAdminPath(pathname ?? '/admin', can);

  return (
    <AdminLayout
      navigation={navigation}
      brandHref="/admin"
      headerActions={
        <>
          <NotificationBell />
          <span className="hidden text-right sm:grid">
            <span className="type-label text-heading">{user.fullName}</span>
            <span className="type-caption text-muted-foreground">{user.roles.join(', ')}</span>
          </span>
          <Avatar name={user.fullName} size="sm" />
          <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void logout()}>
            <LogOut className="size-5" aria-hidden />
          </Button>
        </>
      }
    >
      {pageAllowed ? children : <PageNotAvailable />}
    </AdminLayout>
  );
}

/**
 * Shown instead of a page the signed-in account has no permission for (e.g. an Admin opening
 * `/admin/admins` by URL). The page — and therefore its API request — never mounts; the API would
 * answer 403 anyway.
 */
function PageNotAvailable() {
  return (
    <div className="mx-auto grid max-w-md justify-items-center gap-4 rounded-2xl border bg-card p-8 text-center shadow-card">
      <ShieldAlert className="size-10 text-muted-foreground" aria-hidden />
      <h1 className="type-h2 text-heading">This page is not available</h1>
      <p className="type-body text-muted-foreground">
        Your account does not include access to this area of administration.
      </p>
      <Button asChild>
        <Link href="/admin">Go to the dashboard</Link>
      </Button>
    </div>
  );
}

interface AdminRouteRule {
  /** Path prefix (segment-aligned): `/admin/courses` matches `/admin/courses/123`. */
  prefix: string;
  /** The user needs at least one of these… */
  anyOf?: readonly string[];
  /** …and every one of these. */
  allOf?: readonly string[];
}

/**
 * Permission each admin page requires — the same permission its API endpoints require
 * (apps/api/src/modules/**\/*.routes.ts). The most specific prefix wins. Paths without a rule
 * (`/admin`, `/admin/notifications`, unknown paths that 404) need no permission beyond portal
 * access. A UI convenience only: the API remains the security boundary.
 */
export const ADMIN_ROUTE_RULES: readonly AdminRouteRule[] = [
  { prefix: '/admin/analytics', allOf: [PERMISSIONS.ANALYTICS_VIEW] },
  {
    prefix: '/admin/analytics/revenue',
    allOf: [PERMISSIONS.ANALYTICS_VIEW, PERMISSIONS.PAYMENTS_VIEW],
  },
  { prefix: '/admin/students', allOf: [PERMISSIONS.STUDENTS_MANAGE] },
  { prefix: '/admin/faculty', allOf: [PERMISSIONS.FACULTY_MANAGE] },
  { prefix: '/admin/admins', allOf: [PERMISSIONS.ADMINS_MANAGE] },
  {
    prefix: '/admin/users',
    anyOf: [PERMISSIONS.STUDENTS_MANAGE, PERMISSIONS.FACULTY_MANAGE, PERMISSIONS.ADMINS_MANAGE],
  },
  { prefix: '/admin/academic-levels', allOf: [PERMISSIONS.ACADEMIC_STRUCTURE_MANAGE] },
  { prefix: '/admin/classes', allOf: [PERMISSIONS.ACADEMIC_STRUCTURE_MANAGE] },
  { prefix: '/admin/streams', allOf: [PERMISSIONS.ACADEMIC_STRUCTURE_MANAGE] },
  { prefix: '/admin/subjects', allOf: [PERMISSIONS.ACADEMIC_STRUCTURE_MANAGE] },
  { prefix: '/admin/courses', allOf: [PERMISSIONS.COURSES_MANAGE] },
  { prefix: '/admin/course-categories', allOf: [PERMISSIONS.COURSES_MANAGE] },
  { prefix: '/admin/live-classes', allOf: [PERMISSIONS.LIVE_CLASSES_MANAGE] },
  { prefix: '/admin/assessments', allOf: [PERMISSIONS.CONTENT_MANAGE] },
  { prefix: '/admin/academy-quizzes', allOf: [PERMISSIONS.ACADEMY_QUIZZES_MANAGE] },
  { prefix: '/admin/certificates', allOf: [PERMISSIONS.CERTIFICATES_VIEW] },
  { prefix: '/admin/payments', allOf: [PERMISSIONS.PAYMENTS_VIEW] },
  { prefix: '/admin/enrollments', allOf: [PERMISSIONS.ENROLLMENTS_MANAGE] },
  { prefix: '/admin/email-deliveries', allOf: [PERMISSIONS.NOTIFICATIONS_VIEW] },
  { prefix: '/admin/recruitment', allOf: [PERMISSIONS.RECRUITMENT_MANAGE] },
  { prefix: '/admin/roles', allOf: [PERMISSIONS.ROLES_MANAGE] },
  { prefix: '/admin/audit-logs', allOf: [PERMISSIONS.AUDIT_LOGS_VIEW] },
];

const matchesPrefix = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

/** Whether the admin page at `pathname` may be shown to a user with the `can` permissions. */
export function canAccessAdminPath(
  pathname: string,
  can: (permission: string) => boolean,
): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  const rule = ADMIN_ROUTE_RULES.filter((r) => matchesPrefix(path, r.prefix)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  )[0];
  if (!rule) return true;
  return (rule.allOf ?? []).every(can) && (!rule.anyOf || rule.anyOf.some(can));
}

/**
 * Admin navigation (PHASE 12, docs/ADMIN-DASHBOARD.md §2). Each item appears only with the
 * permission its API requires — a convenience, not a security boundary. Modules that do not exist
 * yet (certificates, coupons, announcements, enquiries, blog) are not listed; see
 * docs/CLIENT-CLARIFICATIONS.md AF.
 */
export function buildNavigation(can: (permission: string) => boolean): NavGroup[] {
  const groups: NavGroup[] = [
    {
      items: [
        { label: 'Dashboard', href: '/admin', icon: <LayoutDashboard />, exact: true },
        ...(can(PERMISSIONS.ANALYTICS_VIEW)
          ? [{ label: 'Analytics', href: '/admin/analytics', icon: <BarChart3 /> }]
          : []),
      ],
    },
  ];
  const push = (label: string, items: (NavItem | false)[]) => {
    const visible = items.filter((item): item is NavItem => item !== false);
    if (visible.length > 0) groups.push({ label, items: visible });
  };
  push('Users', [
    can(PERMISSIONS.STUDENTS_MANAGE) && {
      label: 'Students',
      href: '/admin/students',
      icon: <GraduationCap />,
    },
    can(PERMISSIONS.FACULTY_MANAGE) && {
      label: 'Faculty',
      href: '/admin/faculty',
      icon: <UserRoundCheck />,
    },
    can(PERMISSIONS.ADMINS_MANAGE) && {
      label: 'Administrators',
      href: '/admin/admins',
      icon: <ShieldCheck />,
    },
  ]);
  push('Academic', [
    can(PERMISSIONS.ACADEMIC_STRUCTURE_MANAGE) && {
      label: 'Academic levels',
      href: '/admin/academic-levels',
      icon: <Layers />,
    },
    can(PERMISSIONS.ACADEMIC_STRUCTURE_MANAGE) && {
      label: 'Classes',
      href: '/admin/classes',
      icon: <School />,
    },
    can(PERMISSIONS.ACADEMIC_STRUCTURE_MANAGE) && {
      label: 'Streams',
      href: '/admin/streams',
      icon: <Split />,
    },
    can(PERMISSIONS.ACADEMIC_STRUCTURE_MANAGE) && {
      label: 'Subjects',
      href: '/admin/subjects',
      icon: <FolderTree />,
    },
  ]);
  push('Courses', [
    can(PERMISSIONS.COURSES_MANAGE) && {
      label: 'Courses',
      href: '/admin/courses',
      icon: <BookOpen />,
    },
    can(PERMISSIONS.COURSES_MANAGE) && {
      label: 'Categories',
      href: '/admin/course-categories',
      icon: <Shapes />,
    },
  ]);
  push('Learning', [
    can(PERMISSIONS.LIVE_CLASSES_MANAGE) && {
      label: 'Live classes',
      href: '/admin/live-classes',
      icon: <MonitorPlay />,
    },
    can(PERMISSIONS.CONTENT_MANAGE) && {
      label: 'Assessments',
      href: '/admin/assessments',
      icon: <ClipboardList />,
    },
    can(PERMISSIONS.ACADEMY_QUIZZES_MANAGE) && {
      label: 'Academy Quizzes',
      href: '/admin/academy-quizzes',
      icon: <Trophy />,
    },
    can(PERMISSIONS.CERTIFICATES_VIEW) && {
      label: 'Certificates',
      href: '/admin/certificates',
      icon: <Award />,
    },
  ]);
  push('Commerce', [
    can(PERMISSIONS.PAYMENTS_VIEW) && {
      label: 'Orders & payments',
      href: '/admin/payments',
      icon: <CreditCard />,
    },
    can(PERMISSIONS.ENROLLMENTS_MANAGE) && {
      label: 'Enrolments',
      href: '/admin/enrollments',
      icon: <Users />,
    },
  ]);
  push('Communication', [
    { label: 'My notifications', href: '/admin/notifications', icon: <Bell /> },
    can(PERMISSIONS.NOTIFICATIONS_VIEW) && {
      label: 'Email delivery',
      href: '/admin/email-deliveries',
      icon: <Mail />,
    },
  ]);
  push('Recruitment', [
    can(PERMISSIONS.RECRUITMENT_MANAGE) && {
      label: 'Overview',
      href: '/admin/recruitment',
      icon: <Briefcase />,
      exact: true,
    },
    can(PERMISSIONS.RECRUITMENT_MANAGE) && {
      label: 'Job Openings',
      href: '/admin/recruitment/jobs',
      icon: <FileText />,
    },
    can(PERMISSIONS.RECRUITMENT_MANAGE) && {
      label: 'Applications',
      href: '/admin/recruitment/applications',
      icon: <UserRoundCheck />,
    },
  ]);
  push('Settings', [
    can(PERMISSIONS.ROLES_MANAGE) && {
      label: 'Roles & permissions',
      href: '/admin/roles',
      icon: <KeyRound />,
    },
    can(PERMISSIONS.AUDIT_LOGS_VIEW) && {
      label: 'Audit logs',
      href: '/admin/audit-logs',
      icon: <History />,
    },
  ]);
  return groups;
}
