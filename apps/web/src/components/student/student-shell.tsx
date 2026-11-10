'use client';

import {
  Award,
  BookOpen,
  ClipboardList,
  CreditCard,
  FileQuestion,
  GraduationCap,
  History,
  LayoutDashboard,
  Loader2,
  LogOut,
  MonitorPlay,
  NotebookPen,
  ShieldAlert,
  TrendingUp,
  Trophy,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

import { canUseAdminPortal } from '@/components/admin/use-admin';
import { useAuth } from '@/components/auth/auth-provider';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { Sidebar } from '@/components/layout/sidebar';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { isStudent } from '@/lib/student/learning';
import type { NavGroup } from '@/lib/navigation';

/** Student portal navigation (PHASE 07). Hiding an item is not access control. */
export const studentNavigation: NavGroup[] = [
  {
    items: [
      { label: 'Dashboard', href: '/student/dashboard', icon: <LayoutDashboard />, exact: true },
      { label: 'My courses', href: '/student/courses', icon: <BookOpen /> },
      { label: 'Classes', href: '/student/classes', icon: <MonitorPlay /> },
    ],
  },
  {
    label: 'Assessments',
    items: [
      { label: 'Assignments', href: '/student/assignments', icon: <NotebookPen /> },
      { label: 'Quizzes', href: '/student/quizzes', icon: <FileQuestion /> },
      { label: 'Exams', href: '/student/exams', icon: <ClipboardList /> },
      { label: 'Academy Quizzes', href: '/student/academy-quizzes', icon: <Trophy /> },
    ],
  },
  {
    label: 'Progress',
    items: [
      { label: 'Progress', href: '/student/progress', icon: <TrendingUp /> },
      { label: 'Results', href: '/student/results', icon: <GraduationCap /> },
      { label: 'Certificates', href: '/student/certificates', icon: <Award /> },
    ],
  },
  {
    label: 'Account',
    items: [
      { label: 'Profile', href: '/student/profile', icon: <UserRound /> },
      { label: 'Learning history', href: '/student/history', icon: <History /> },
      { label: 'Payments', href: '/student/payments', icon: <CreditCard /> },
    ],
  },
];

/**
 * Session gate + shell for `/student/*`. Decides what the UI shows; the API re-checks the session,
 * the STUDENT role and the per-course enrolment on every request.
 */
export function StudentShell({ children }: { children: React.ReactNode }) {
  const { status, user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (status === 'anonymous') {
      router.replace(`/login?next=${encodeURIComponent(pathname ?? '/student/dashboard')}`);
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

  if (!isStudent(user)) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="grid max-w-md justify-items-center gap-4 rounded-2xl border bg-card p-8 text-center shadow-card">
          <ShieldAlert className="size-10 text-destructive" aria-hidden />
          <h1 className="type-h2 text-heading">Student portal</h1>
          <p className="type-body text-muted-foreground">
            You are signed in as {user.email}, which is not a student account.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {canUseAdminPortal(user) ? (
              <Button asChild variant="outline">
                <Link href="/admin">Open administration</Link>
              </Button>
            ) : (
              <Button asChild variant="outline">
                <Link href="/">Go to the website</Link>
              </Button>
            )}
            <Button onClick={() => void logout()}>Sign out</Button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <DashboardLayout
      contextLabel="Student portal"
      brandHref="/student/dashboard"
      sidebar={<Sidebar groups={studentNavigation} label="Student portal" />}
      sidebarFooter={
        <Link
          href="/courses"
          className="type-body-sm text-muted-foreground hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Browse the course catalogue
        </Link>
      }
      headerActions={
        <>
          <NotificationBell />
          <span className="hidden text-right sm:grid">
            <span className="type-label text-heading">{user.fullName}</span>
            <span className="type-caption text-muted-foreground">Student</span>
          </span>
          <Avatar name={user.fullName} size="sm" />
          <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void logout()}>
            <LogOut className="size-5" aria-hidden />
          </Button>
        </>
      }
    >
      {children}
    </DashboardLayout>
  );
}
