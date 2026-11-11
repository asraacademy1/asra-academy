'use client';

import {
  BarChart3,
  BookOpen,
  ClipboardList,
  FileQuestion,
  FolderTree,
  Inbox,
  LayoutDashboard,
  Loader2,
  LogOut,
  MonitorPlay,
  NotebookPen,
  ShieldAlert,
  UserRound,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';

import { canUseAdminPortal } from '@/components/admin/use-admin';
import { AnnouncementProvider } from '@/components/announcements/announcement-provider';
import { useAuth } from '@/components/auth/auth-provider';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { Sidebar } from '@/components/layout/sidebar';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { isFaculty } from '@/lib/faculty/portal';
import type { NavGroup } from '@/lib/navigation';
import { isStudent } from '@/lib/student/learning';

/** Faculty portal navigation (PHASE 08). Hiding an item is not access control. */
export const facultyNavigation: NavGroup[] = [
  {
    items: [
      { label: 'Dashboard', href: '/faculty/dashboard', icon: <LayoutDashboard />, exact: true },
      { label: 'My courses', href: '/faculty/courses', icon: <BookOpen /> },
      { label: 'Content', href: '/faculty/content', icon: <FolderTree /> },
      { label: 'Students', href: '/faculty/students', icon: <Users /> },
      { label: 'Live classes', href: '/faculty/classes', icon: <MonitorPlay /> },
    ],
  },
  {
    label: 'Assessments',
    items: [
      { label: 'Assignments', href: '/faculty/assignments', icon: <NotebookPen /> },
      { label: 'Submissions', href: '/faculty/submissions', icon: <Inbox /> },
      { label: 'Quizzes', href: '/faculty/quizzes', icon: <FileQuestion /> },
      { label: 'Exams', href: '/faculty/exams', icon: <ClipboardList /> },
    ],
  },
  {
    label: 'Insights',
    items: [
      { label: 'Performance', href: '/faculty/performance', icon: <BarChart3 /> },
      { label: 'Profile', href: '/faculty/profile', icon: <UserRound /> },
    ],
  },
];

/**
 * Session gate + shell for `/faculty/*`. Decides what the UI shows; the API re-checks the session,
 * the FACULTY role, each permission and the course assignment on every request.
 */
export function FacultyShell({ children }: { children: React.ReactNode }) {
  const { status, user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (status === 'anonymous') {
      router.replace(`/login?next=${encodeURIComponent(pathname ?? '/faculty/dashboard')}`);
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

  if (!isFaculty(user)) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <div className="grid max-w-md justify-items-center gap-4 rounded-2xl border bg-card p-8 text-center shadow-card">
          <ShieldAlert className="size-10 text-destructive" aria-hidden />
          <h1 className="type-h2 text-heading">Faculty portal</h1>
          <p className="type-body text-muted-foreground">
            You are signed in as {user.email}, which is not a faculty account.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {canUseAdminPortal(user) ? (
              <Button asChild variant="outline">
                <Link href="/admin">Open administration</Link>
              </Button>
            ) : isStudent(user) ? (
              <Button asChild variant="outline">
                <Link href="/student/dashboard">Go to my dashboard</Link>
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
      contextLabel="Faculty portal"
      brandHref="/faculty/dashboard"
      sidebar={<Sidebar groups={facultyNavigation} label="Faculty portal" />}
      headerActions={
        <>
          <NotificationBell />
          <span className="hidden text-right sm:grid">
            <span className="type-label text-heading">{user.fullName}</span>
            <span className="type-caption text-muted-foreground">Faculty</span>
          </span>
          <Avatar name={user.fullName} size="sm" />
          <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void logout()}>
            <LogOut className="size-5" aria-hidden />
          </Button>
        </>
      }
    >
      <AnnouncementProvider audiences={['FACULTY']}>{children}</AnnouncementProvider>
    </DashboardLayout>
  );
}
