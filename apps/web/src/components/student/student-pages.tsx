'use client';

import type {
  CertificateDto,
  LearningHistoryItem,
  LiveClassDto,
  LessonContentType,
  Paginated,
  StudentCourseCard,
  StudentEnrollmentRecord,
  StudentFeatures,
  StudentLessonListItem,
  StudentOrderDto,
  StudentResultItem,
} from '@asra/types';
import {
  Award,
  CheckCircle2,
  CreditCard,
  Download,
  ExternalLink,
  FileQuestion,
  GraduationCap,
  History,
  MonitorPlay,
  NotebookPen,
  PlayCircle,
  TrendingUp,
  Video,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/public/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CLASS_TIMING_LABELS, canJoinClass, classTiming } from '@/lib/faculty/portal';
import { formatDate, formatDateTime, isSafeExternalUrl } from '@/lib/format';
import { formatAmount, ORDER_STATUS, REFUND_STATE_LABEL } from '@/lib/payments';
import { courseHref, formatClock, LESSON_TYPE_LABELS, learnHref } from '@/lib/student/learning';

import { AcademyResults } from './academy-quizzes/leaderboard';
import { AssessmentResults } from './assessment-pages';
import { CourseProgress, ErrorPanel, ListPager, LoadingPanel } from './student-ui';
import { errorMessage, useApiResource, useStudentApi, withPage } from './use-student';

const home = { label: 'Dashboard', href: '/student/dashboard' };

function useFeatures() {
  const api = useStudentApi();
  return useApiResource('/student/features', () => api.get<StudentFeatures>('/student/features'));
}

/** Loads a paginated student list and renders loading/error/empty states around it. */
function PagedList<T>({
  path,
  extra,
  label,
  empty,
  children,
}: {
  path: string;
  extra?: Record<string, string>;
  label: string;
  empty: React.ReactNode;
  children: (items: T[]) => React.ReactNode;
}) {
  const api = useStudentApi();
  const [page, setPage] = React.useState(1);
  const url = withPage(path, page, extra);
  const list = useApiResource(url, () => api.get<Paginated<T>>(url));
  if (list.error && !list.data) {
    return <ErrorPanel message={errorMessage(list.error)} onRetry={list.reload} />;
  }
  if (!list.data) return <LoadingPanel label={`Loading ${label}…`} />;
  if (list.data.items.length === 0) return <>{empty}</>;
  return (
    <div className="grid gap-6">
      {children(list.data.items)}
      <ListPager
        pagination={list.data.pagination}
        onPageChange={setPage}
        label={`${label} pages`}
      />
    </div>
  );
}

/** Lessons of one kind across enrolled courses, grouped by course in curriculum order. */
function LessonItems({ items }: { items: StudentLessonListItem[] }) {
  return (
    <ul className="grid gap-3">
      {items.map((item) => {
        const clock = formatClock(item.durationSeconds);
        return (
          <li key={item.lesson.lessonId}>
            <Card className="gap-3 sm:flex-row sm:items-center">
              <div className="grid min-w-0 flex-1 gap-1">
                <span className="type-caption text-muted-foreground">
                  {item.course.title} · {item.lesson.moduleTitle} › {item.lesson.chapterTitle}
                </span>
                <h2 className="type-h4 break-words text-heading">{item.lesson.lessonTitle}</h2>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{LESSON_TYPE_LABELS[item.lesson.contentType]}</Badge>
                  {clock ? <Badge variant="secondary">{clock}</Badge> : null}
                  {item.completedAt ? (
                    <Badge variant="success">
                      <CheckCircle2 aria-hidden /> Completed
                    </Badge>
                  ) : null}
                </span>
              </div>
              <Button asChild size="sm" variant="outline" className="self-start sm:self-center">
                <Link href={learnHref(item.course.id, item.lesson.lessonId)}>Open lesson</Link>
              </Button>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

/** Quizzes / assignments: real placeholder lessons + an honest note about the missing engine. */
export function AssessmentLessonsPage({ kind }: { kind: 'QUIZ' | 'ASSIGNMENT' }) {
  const features = useFeatures();
  const quiz = kind === 'QUIZ';
  const feature = quiz ? features.data?.quizAttempts : features.data?.assignmentSubmissions;
  return (
    <>
      <PageHeader
        title={quiz ? 'Quizzes' : 'Assignments'}
        breadcrumbs={[home, { label: quiz ? 'Quizzes' : 'Assignments' }]}
        description={feature?.message}
      />
      <PagedList<StudentLessonListItem>
        path="/student/lessons"
        extra={{ contentType: kind }}
        label={quiz ? 'quizzes' : 'assignments'}
        empty={
          <EmptyState
            icon={quiz ? <FileQuestion /> : <NotebookPen />}
            title={quiz ? 'No quizzes in your courses' : 'No assignments in your courses'}
            description="When your faculty add them to your courses, they appear here."
          />
        }
      >
        {(items) => <LessonItems items={items} />}
      </PagedList>
    </>
  );
}

/**
 * Live classes of the student's enrolled courses (PHASE 08/11): upcoming classes with their
 * joining link, past classes with their recording when faculty added one. Recorded lectures are
 * the video lessons of the courses.
 */
export function ClassesPage() {
  const features = useFeatures();
  const router = useRouter();
  // `?when=past` (e.g. from a "recording available" notification) opens the past tab.
  const when = useSearchParams().get('when') === 'past' ? 'past' : 'upcoming';
  const setWhen = (next: 'upcoming' | 'past') =>
    router.replace(next === 'past' ? '/student/classes?when=past' : '/student/classes', {
      scroll: false,
    });
  return (
    <>
      <PageHeader title="Classes" breadcrumbs={[home, { label: 'Classes' }]} />
      <section aria-labelledby="live-heading" className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="live-heading" className="type-h2 text-heading">
            Live classes
          </h2>
          <Tabs value={when} onValueChange={(value) => setWhen(value as 'upcoming' | 'past')}>
            <TabsList aria-label="Which classes">
              <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
              <TabsTrigger value="past">Past and recordings</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {features.data ? (
          <p className="type-body-sm text-muted-foreground">{features.data.liveClasses.message}</p>
        ) : null}
        <PagedList<LiveClassDto>
          key={when}
          path="/student/live-classes"
          extra={{ when }}
          label="live classes"
          empty={
            <EmptyState
              icon={<MonitorPlay />}
              title={when === 'upcoming' ? 'No upcoming live classes' : 'No past live classes'}
              description={
                when === 'upcoming'
                  ? 'When a class is scheduled for one of your courses, it appears here and you are notified.'
                  : 'Classes appear here after they end, with the recording when your faculty adds it.'
              }
            />
          }
        >
          {(items) => <LiveClassItems items={items} />}
        </PagedList>
      </section>
      <section aria-labelledby="recorded-heading" className="grid gap-3">
        <h2 id="recorded-heading" className="type-h2 text-heading">
          Recorded lectures
        </h2>
        <PagedList<StudentLessonListItem>
          path="/student/lessons"
          extra={{ contentType: 'VIDEO' }}
          label="recorded lectures"
          empty={
            <EmptyState
              icon={<PlayCircle />}
              title="No recorded lectures yet"
              description="Video lessons of your courses appear here."
            />
          }
        >
          {(items) => <LessonItems items={items} />}
        </PagedList>
      </section>
    </>
  );
}

/** Upcoming classes of ONE enrolled course (course page). Renders nothing when there are none. */
export function CourseLiveClasses({ courseId }: { courseId: string }) {
  const api = useStudentApi();
  const url = withPage('/student/live-classes', 1, { courseId, pageSize: '5' });
  const list = useApiResource(url, () => api.get<Paginated<LiveClassDto>>(url));
  if (!list.data || list.data.items.length === 0) return null;
  return (
    <section aria-labelledby="course-classes-heading" className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="course-classes-heading" className="type-h2 text-heading">
          Upcoming live classes
        </h2>
        <Link href="/student/classes" className="type-body-sm text-primary hover:underline">
          All classes
        </Link>
      </div>
      <LiveClassItems items={list.data.items} showCourse={false} />
    </section>
  );
}

export function ResultsPage() {
  const features = useFeatures();
  return (
    <>
      <PageHeader
        title="Results"
        breadcrumbs={[home, { label: 'Results' }]}
        description={features.data?.results.message}
      />
      <section aria-labelledby="assessment-results-heading" className="grid gap-3">
        <h2 id="assessment-results-heading" className="type-h2 text-heading">
          Quizzes and exams
        </h2>
        <AssessmentResults />
      </section>
      <section aria-labelledby="academy-results-heading" className="grid gap-3">
        <h2 id="academy-results-heading" className="type-h2 text-heading">
          Academy Quizzes
        </h2>
        <AcademyResults />
      </section>
      <h2 className="type-h2 text-heading">Assignments</h2>
      <PagedList<StudentResultItem>
        path="/student/results"
        label="results"
        empty={
          <EmptyState
            icon={<GraduationCap />}
            title="No assignment results released yet"
            description="When your faculty release the marks for an assignment you submitted, they appear here."
            action={
              <Button asChild variant="outline">
                <Link href="/student/progress">See your course progress</Link>
              </Button>
            }
          />
        }
      >
        {(items) => (
          <ul className="grid gap-3">
            {items.map((item) => (
              <li key={item.submissionId}>
                <Card className="gap-3">
                  <CardHeader className="gap-1">
                    <CardTitle
                      as="h2"
                      className="flex flex-wrap items-center justify-between gap-2"
                    >
                      <Link
                        href={learnHref(item.course.id, item.lesson.lessonId)}
                        className="rounded-sm hover:text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                      >
                        {item.lesson.lessonTitle}
                      </Link>
                      <Badge variant="success" className="tabular-nums">
                        {item.marksAwarded} / {item.maxMarks}
                      </Badge>
                    </CardTitle>
                    <p className="type-caption text-muted-foreground">
                      {item.course.title} · released {formatDate(item.releasedAt)}
                    </p>
                  </CardHeader>
                  {item.feedback ? (
                    <CardContent>
                      <p className="type-body-sm whitespace-pre-line">{item.feedback}</p>
                    </CardContent>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </PagedList>
    </>
  );
}

function LiveClassItems({
  items,
  showCourse = true,
}: {
  items: LiveClassDto[];
  showCourse?: boolean;
}) {
  return (
    <ul className="grid gap-3">
      {items.map((item) => {
        const timing = classTiming(item);
        return (
          <li key={item.id}>
            <Card className="gap-3 sm:flex-row sm:items-center">
              <div className="grid min-w-0 flex-1 gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <h3 className="type-h4 break-words text-heading">{item.title}</h3>
                  <Badge variant={CLASS_BADGE[timing]}>{CLASS_TIMING_LABELS[timing]}</Badge>
                </span>
                <span className="type-body-sm text-muted-foreground">
                  {showCourse ? `${item.course.title} · ` : ''}
                  {formatDateTime(item.startsAt, item.timeZone)} IST · {item.durationMinutes} min
                  {item.host ? ` · ${item.host}` : ''}
                </span>
                {item.description ? (
                  <p className="type-body-sm whitespace-pre-line">{item.description}</p>
                ) : null}
                {timing === 'scheduled' && !item.joinUrl ? (
                  <span className="type-caption text-muted-foreground">
                    The joining link has not been added yet. You will be notified when it is.
                  </span>
                ) : null}
                {(timing === 'ended' || timing === 'completed') && !item.recordingUrl ? (
                  <span className="type-caption text-muted-foreground">No recording yet.</span>
                ) : null}
              </div>
              <span className="flex flex-wrap gap-2 self-start sm:self-center">
                {canJoinClass(item) && isSafeExternalUrl(item.joinUrl) ? (
                  <Button asChild size="sm">
                    <a href={item.joinUrl} target="_blank" rel="noopener noreferrer">
                      <Video aria-hidden /> Join class
                    </a>
                  </Button>
                ) : null}
                {item.recordingUrl && isSafeExternalUrl(item.recordingUrl) ? (
                  <Button asChild size="sm" variant="outline">
                    <a href={item.recordingUrl} target="_blank" rel="noopener noreferrer">
                      <PlayCircle aria-hidden /> Watch recording
                    </a>
                  </Button>
                ) : null}
              </span>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

const CLASS_BADGE = {
  scheduled: 'info',
  ended: 'secondary',
  completed: 'success',
  cancelled: 'destructive',
} as const;

/**
 * Order and payment history (PHASE 10). Every status shown is the server's: an order is "Paid"
 * only after the API verified the payment with Razorpay. Receipts exist for paid orders only.
 */
export function PaymentsPage() {
  const features = useFeatures();
  return (
    <>
      <PageHeader
        title="Payments"
        breadcrumbs={[home, { label: 'Payments' }]}
        description={features.data?.payments.message}
      />
      <PagedList<StudentOrderDto>
        path="/student/orders"
        label="payments"
        empty={
          <EmptyState
            icon={<CreditCard />}
            title="No payments yet"
            description="When you buy a course, your order, payment and receipt appear here."
            action={
              <Button asChild variant="outline">
                <Link href="/student/courses?tab=catalog">Browse courses</Link>
              </Button>
            }
          />
        }
      >
        {(items) => <OrderItems items={items} />}
      </PagedList>
    </>
  );
}

function OrderItems({ items }: { items: StudentOrderDto[] }) {
  const api = useStudentApi();
  // Orders re-read by "Check status" replace the page's copy until the page changes.
  const [updated, setUpdated] = React.useState<Record<string, StudentOrderDto>>({});
  const orders = items.map((order) => updated[order.id] ?? order);
  const [checking, setChecking] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function check(id: string) {
    setChecking(id);
    setError(null);
    try {
      const order = await api.post<StudentOrderDto>(`/student/orders/${id}/refresh`);
      setUpdated((current) => ({ ...current, [id]: order }));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setChecking(null);
    }
  }

  return (
    <div className="grid gap-3">
      {error ? (
        <p role="alert" className="type-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ul className="grid gap-3">
        {orders.map((order) => {
          const status = ORDER_STATUS[order.status];
          const refund = REFUND_STATE_LABEL[order.refundState];
          const lastPayment = order.payments.at(-1);
          return (
            <li key={order.id}>
              <Card className="gap-3 sm:flex-row sm:items-center">
                <div className="grid min-w-0 flex-1 gap-1">
                  <span className="type-caption text-muted-foreground">
                    Order {order.reference} · {formatDate(order.paidAt ?? order.createdAt)}
                    {order.mode === 'TEST' ? ' · Test mode' : ''}
                  </span>
                  <h2 className="type-h4 break-words text-heading">{order.course.title}</h2>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="type-label tabular-nums">
                      {formatAmount(order.price.amountMinor, order.price.currency)}
                    </span>
                    <Badge variant={status.tone}>{status.label}</Badge>
                    {refund ? <Badge variant="info">{refund}</Badge> : null}
                    {order.status !== 'PAID' && lastPayment?.status === 'FAILED' ? (
                      <Badge variant="destructive">Last attempt failed</Badge>
                    ) : null}
                    {order.nextStep === 'WAIT' ? (
                      <Badge variant="info">Being confirmed</Badge>
                    ) : null}
                  </span>
                  {order.status !== 'PAID' && order.failureReason ? (
                    <span className="type-caption text-muted-foreground">
                      {order.failureReason}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2 self-start sm:self-center">
                  {order.receiptAvailable ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/student/payments/${order.id}/receipt`}>Receipt</Link>
                    </Button>
                  ) : null}
                  {order.nextStep === 'OPEN_COURSE' ? (
                    <Button asChild size="sm">
                      <Link href={courseHref(order.course.id)}>Open course</Link>
                    </Button>
                  ) : null}
                  {order.nextStep === 'PAY' ? (
                    <Button asChild size="sm">
                      <Link href={`/student/checkout/${order.course.slug}`}>Pay now</Link>
                    </Button>
                  ) : null}
                  {order.nextStep === 'PAY' || order.nextStep === 'WAIT' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => check(order.id)}
                      loading={checking === order.id}
                      loadingText="Checking…"
                    >
                      Check status
                    </Button>
                  ) : null}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Progress of every active course, from the API's lesson-completion records. */
export function ProgressPage() {
  return (
    <>
      <PageHeader
        title="Progress"
        breadcrumbs={[home, { label: 'Progress' }]}
        description="Progress counts the published lessons you have marked complete. Quiz and assignment lessons are not counted yet."
      />
      <PagedList<StudentCourseCard>
        path="/student/courses"
        label="courses"
        empty={
          <EmptyState
            icon={<TrendingUp />}
            title="No progress to show yet"
            description="Enrol in a course and complete lessons to see your progress here."
            action={
              <Button asChild>
                <Link href="/student/courses?tab=find">Find courses</Link>
              </Button>
            }
          />
        }
      >
        {(items) => (
          <ul className="grid gap-3">
            {items.map((course) => (
              <li key={course.id}>
                <Card className="gap-4 md:flex-row md:items-center">
                  <div className="grid min-w-0 flex-1 gap-1">
                    <h2 className="type-h4 text-heading">
                      <Link
                        href={courseHref(course.id)}
                        className="hover:text-primary hover:underline"
                      >
                        {course.title}
                      </Link>
                    </h2>
                    <span className="type-caption text-muted-foreground">
                      {course.enrollment.lastActivityAt
                        ? `Last studied ${formatDateTime(course.enrollment.lastActivityAt)}`
                        : 'Not started yet'}
                      {course.progress.completedAt
                        ? ` · Completed ${formatDate(course.progress.completedAt)}`
                        : ''}
                    </span>
                  </div>
                  <div className="w-full md:w-72">
                    <CourseProgress progress={course.progress} label={`${course.title} progress`} />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </PagedList>
    </>
  );
}

/** Official certificates earned upon course completion (PHASE 13). */
export function CertificatesPage() {
  const features = useFeatures();
  const api = useStudentApi();
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);

  const handleDownload = async (cert: CertificateDto) => {
    try {
      setDownloadingId(cert.id);
      const blob = await api.download(`/api/v1/student/certificates/${cert.id}/download`);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ASRA-Certificate-${cert.certificateNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch {
      alert('Unable to download certificate at this time. Please try again.');
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Certificates"
        breadcrumbs={[home, { label: 'Certificates' }]}
        description={features.data?.certificates.message}
      />
      <PagedList<CertificateDto>
        path="/student/certificates"
        label="certificates"
        empty={
          <EmptyState
            icon={<Award />}
            title="No certificates earned yet"
            description="When you complete all lessons and pass the required assessments for an enrolled course, your official certificate will appear here."
          />
        }
      >
        {(items) => (
          <ul className="grid gap-4">
            {items.map((item) => {
              const isIssued = item.status === 'ISSUED';
              return (
                <li key={item.id}>
                  <Card className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="type-h4 font-semibold text-heading">{item.courseTitle}</h2>
                        {isIssued ? (
                          <Badge
                            variant="outline"
                            className="border-emerald-300 bg-emerald-50 font-medium text-emerald-700"
                          >
                            Verified Credential
                          </Badge>
                        ) : (
                          <Badge variant="destructive">Revoked</Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        <span>Completed: {formatDate(item.completedAt)}</span>
                        <span>Issued: {formatDate(item.issuedAt)}</span>
                        <span className="flex items-center gap-1 rounded border bg-muted px-2 py-0.5 font-mono text-xs">
                          ID: {item.certificateNumber}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 pt-2 md:pt-0">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={downloadingId === item.id}
                        onClick={() => void handleDownload(item)}
                      >
                        <Download className="mr-1.5 h-4 w-4" />
                        {downloadingId === item.id ? 'Downloading...' : 'Download PDF'}
                      </Button>
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={`/verify/${item.certificateNumber}`} target="_blank">
                          <ExternalLink className="mr-1.5 h-4 w-4" />
                          Verify
                        </Link>
                      </Button>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </PagedList>
    </>
  );
}

/** The student's own recent lesson activity. */
export function HistoryPage() {
  return (
    <>
      <PageHeader
        title="Learning history"
        breadcrumbs={[home, { label: 'Learning history' }]}
        description="Lessons you have opened, most recent first."
      />
      <PagedList<LearningHistoryItem>
        path="/student/history"
        label="history"
        empty={
          <EmptyState
            icon={<History />}
            title="No learning activity yet"
            description="Lessons you open will appear here."
          />
        }
      >
        {(items) => (
          <Card className="p-0 sm:p-0">
            <ul className="divide-y">
              {items.map((item) => (
                <li
                  key={item.lesson.lessonId}
                  className="flex flex-wrap items-center gap-3 px-5 py-4"
                >
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <Link
                      href={learnHref(item.course.id, item.lesson.lessonId)}
                      className="type-label break-words text-primary hover:underline"
                    >
                      {item.lesson.lessonTitle}
                    </Link>
                    <span className="type-caption text-muted-foreground">
                      {item.course.title} · {item.lesson.moduleTitle} › {item.lesson.chapterTitle}
                    </span>
                  </div>
                  <div className="grid justify-items-end gap-1 text-right">
                    {item.completedAt ? (
                      <Badge variant="success">
                        <CheckCircle2 aria-hidden /> Completed {formatDate(item.completedAt)}
                      </Badge>
                    ) : (
                      <Badge variant="outline">{lessonTypeLabel(item.lesson.contentType)}</Badge>
                    )}
                    <span className="type-caption text-muted-foreground">
                      Last opened {formatDateTime(item.lastViewedAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </PagedList>
    </>
  );
}

const lessonTypeLabel = (type: LessonContentType) => LESSON_TYPE_LABELS[type];

/** Enrolment records (including cancelled ones) for the profile page. */
export function EnrollmentRecords() {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Enrolled courses</CardTitle>
      </CardHeader>
      <CardContent>
        <PagedList<StudentEnrollmentRecord>
          path="/student/enrollments"
          label="enrolments"
          empty={<p className="type-body-sm text-muted-foreground">No enrolments yet.</p>}
        >
          {(items) => (
            <ul className="divide-y">
              {items.map((item) => (
                <li
                  key={item.enrollment.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                >
                  <div className="grid gap-0.5">
                    <Link
                      href={courseHref(item.course.id)}
                      className="type-label text-primary hover:underline"
                    >
                      {item.course.title}
                    </Link>
                    <span className="type-caption text-muted-foreground">
                      Enrolled {formatDate(item.enrollment.enrolledAt)} ·{' '}
                      {item.enrollment.source === 'FREE' ? 'Free course' : 'By the academy'}
                    </span>
                  </div>
                  <Badge variant={item.enrollment.status === 'ACTIVE' ? 'success' : 'secondary'}>
                    {item.enrollment.status === 'ACTIVE'
                      ? 'Active'
                      : `Cancelled ${formatDate(item.enrollment.cancelledAt) ?? ''}`}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </PagedList>
      </CardContent>
    </Card>
  );
}
