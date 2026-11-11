'use client';

import type {
  CertificateDto,
  CertificateEligibilityResult,
  StudentCourseOverview,
} from '@asra/types';
import { Award, Clock, Download, ExternalLink, FileImage, UserRound } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { MetaList } from '@/components/asra/shared/card-parts';
import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { ApiClientError } from '@/lib/api';
import { triggerBlobDownload } from '@/lib/certificates';
import { formatDuration } from '@/lib/format';
import { priceParts } from '@/lib/payments';
import { courseEyebrow, learnHref } from '@/lib/student/learning';

import { EnrolButton } from './student-courses';
import { CourseOutline, CurriculumNav } from './curriculum-nav';
import { CourseLiveClasses } from './student-pages';
import { CourseProgress, CourseThumb, ErrorPanel, LessonPath, LoadingPanel } from './student-ui';
import { errorMessage, useApiResource, useStudentApi } from './use-student';

const crumbs = [
  { label: 'Dashboard', href: '/student/dashboard' },
  { label: 'My courses', href: '/student/courses' },
];

/** `/student/courses/[courseId]`: overview, access state and curriculum. */
export function CourseOverview({ courseId }: { courseId: string }) {
  const api = useStudentApi();
  const path = `/student/courses/${courseId}`;
  const overview = useApiResource(path, () => api.get<StudentCourseOverview>(path));

  if (overview.error && !overview.data) {
    const missing =
      overview.error instanceof ApiClientError &&
      (overview.error.status === 404 || overview.error.status === 422);
    return (
      <>
        <PageHeader
          title={missing ? 'Course not found' : 'Course'}
          breadcrumbs={[...crumbs, { label: 'Not found' }]}
        />
        {missing ? (
          <div className="grid justify-items-start gap-3">
            <p className="type-body text-muted-foreground">
              This course does not exist or is not available.
            </p>
            <Button asChild variant="outline">
              <Link href="/student/courses">Back to my courses</Link>
            </Button>
          </div>
        ) : (
          <ErrorPanel message={errorMessage(overview.error)} onRetry={overview.reload} />
        )}
      </>
    );
  }
  if (!overview.data) return <LoadingPanel label="Loading course…" rows={6} />;

  const course = overview.data;
  const eyebrow = courseEyebrow(course);
  const duration = formatDuration(course.durationMinutes);
  const paragraphs = (course.description ?? '').split(/\n{2,}/).filter((p) => p.trim());

  return (
    <>
      <PageHeader
        title={course.title}
        description={eyebrow || undefined}
        breadcrumbs={[...crumbs, { label: course.title }]}
      />

      <Card className="gap-0 overflow-hidden p-0 sm:p-0 md:flex-row">
        <CourseThumb
          course={course}
          className="md:w-2/5 md:shrink-0"
          sizes="(min-width: 768px) 40vw, 100vw"
        />
        <CardContent className="grid content-start gap-4 p-5 sm:p-6">
          {course.summary ? <p className="type-body-lg">{course.summary}</p> : null}
          <MetaList
            items={[
              {
                icon: UserRound,
                label: 'Faculty',
                value: course.instructors.map((i) => i.fullName).join(', ') || null,
              },
              { icon: Clock, label: 'Learning time', value: duration ? `About ${duration}` : null },
            ]}
          />
          <AccessPanel course={course} onEnrolled={overview.replace} />
        </CardContent>
      </Card>

      {paragraphs.length > 0 ? (
        <section aria-labelledby="about-heading" className="grid max-w-prose gap-3">
          <h2 id="about-heading" className="type-h2 text-heading">
            About this course
          </h2>
          {paragraphs.map((paragraph, index) => (
            <p key={index} className="type-body whitespace-pre-line">
              {paragraph}
            </p>
          ))}
        </section>
      ) : null}

      {course.access === 'ENROLLED' ? <CourseLiveClasses courseId={course.id} /> : null}

      <section aria-labelledby="curriculum-heading" className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="curriculum-heading" className="type-h2 text-heading">
            Curriculum
          </h2>
          <span className="type-body-sm text-muted-foreground">
            {course.lessonCount} lesson{course.lessonCount === 1 ? '' : 's'}
          </span>
        </div>
        {course.curriculum ? (
          <CurriculumNav courseId={course.id} modules={course.curriculum.modules} />
        ) : (
          <CourseOutline outline={course.outline} />
        )}
      </section>
    </>
  );
}

function AccessPanel({
  course,
  onEnrolled,
}: {
  course: StudentCourseOverview;
  onEnrolled: (course: StudentCourseOverview) => void;
}) {
  if (course.access === 'ENROLLED' && course.curriculum) {
    const progress = course.curriculum.progress;
    return (
      <div className="grid gap-3">
        <Badge variant="success" className="justify-self-start">
          Enrolled
        </Badge>
        <CourseProgress progress={progress} />
        {course.resumeLesson ? (
          <>
            <LessonPath lesson={course.resumeLesson} />
            <Button asChild className="justify-self-start">
              <Link href={learnHref(course.id, course.resumeLesson.lessonId)}>
                {course.enrollment?.lastActivityAt ? 'Continue learning' : 'Start course'}
              </Link>
            </Button>
          </>
        ) : (
          <p className="type-body-sm text-muted-foreground">
            No lessons are published in this course yet.
          </p>
        )}
        <CourseCertificateBanner courseId={course.id} />
      </div>
    );
  }
  if (course.access === 'PURCHASE') {
    const price = priceParts(course.price);
    return (
      <div className="grid justify-items-start gap-3">
        {price ? (
          <p className="flex flex-wrap items-baseline gap-2">
            <span className="type-h3 text-heading tabular-nums">{price.now}</span>
            {price.was ? (
              <s className="type-body text-muted-foreground tabular-nums">{price.was}</s>
            ) : null}
          </p>
        ) : null}
        <p className="type-body text-muted-foreground">
          Buy this course to open the lessons and save your progress. Payment is processed securely
          by Razorpay.
        </p>
        <Button asChild>
          <Link href={`/student/checkout/${course.slug}`}>Buy course</Link>
        </Button>
      </div>
    );
  }
  if (course.access === 'FREE_ENROLMENT') {
    return (
      <div className="grid justify-items-start gap-3">
        <p className="type-body text-muted-foreground">
          This course is free. Enrol to open the lessons and save your progress.
        </p>
        <EnrolButton
          courseId={course.id}
          title={course.title}
          onEnrolled={onEnrolled}
          size="default"
        />
      </div>
    );
  }
  return (
    <Alert
      tone="info"
      title={
        course.enrollment?.status === 'CANCELLED'
          ? 'Your enrolment in this course was cancelled'
          : 'Enrolment is arranged by the academy'
      }
    >
      <p>
        {course.enrollment?.status === 'CANCELLED'
          ? 'Contact ASRA Academy if you would like to rejoin this course.'
          : 'This course cannot be bought online right now. Contact ASRA Academy to join it; once the academy enrols you, the lessons open here.'}
      </p>
      <div>
        <Button asChild size="sm" variant="outline">
          <Link href="/contact">Contact the academy</Link>
        </Button>
      </div>
    </Alert>
  );
}

function CourseCertificateBanner({ courseId }: { courseId: string }) {
  const api = useStudentApi();
  const path = `/student/courses/${courseId}/certificate/eligibility`;
  const eligibility = useApiResource(path, () => api.get<CertificateEligibilityResult>(path));
  const [claiming, setClaiming] = React.useState(false);
  const [downloadingFormat, setDownloadingFormat] = React.useState<'pdf' | 'png' | null>(null);

  const data = eligibility.data;
  if (!data) return null;

  const handleClaim = async () => {
    try {
      setClaiming(true);
      await api.post<CertificateDto>(`/student/courses/${courseId}/certificate`);
      toast.success('Certificate issued', {
        description: 'Your official course certificate is ready.',
      });
      eligibility.reload();
    } catch (err) {
      toast.error('Unable to issue certificate', { description: errorMessage(err) });
    } finally {
      setClaiming(false);
    }
  };

  const handleDownload = async (cert: CertificateDto, format: 'pdf' | 'png') => {
    try {
      setDownloadingFormat(format);
      const blob = await api.download(`/api/v1/student/certificates/${cert.id}/download/${format}`);
      triggerBlobDownload(blob, `ASRA-Certificate-${cert.certificateNumber}.${format}`);
    } catch (err) {
      toast.error(`${format.toUpperCase()} download failed`, { description: errorMessage(err) });
    } finally {
      setDownloadingFormat(null);
    }
  };

  if (data.state === 'ALREADY_ISSUED' && data.certificate) {
    const cert = data.certificate;
    return (
      <div className="mt-1 grid gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50/70 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
            <Award className="size-4 text-emerald-700" />
            Course Certificate Issued
          </div>
          <span className="rounded border border-emerald-300 bg-white px-2 py-0.5 font-mono text-xs text-emerald-900">
            {cert.certificateNumber}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={downloadingFormat !== null}
            onClick={() => void handleDownload(cert, 'png')}
          >
            <FileImage className="size-4" />
            {downloadingFormat === 'png' ? 'Rendering…' : 'Download PNG'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={downloadingFormat !== null}
            onClick={() => void handleDownload(cert, 'pdf')}
          >
            <Download className="size-4" />
            {downloadingFormat === 'pdf' ? 'Rendering…' : 'Download PDF'}
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <Link href={`/verify/${cert.certificateNumber}`} target="_blank">
              <ExternalLink className="size-4" />
              Verify
            </Link>
          </Button>
          <Button size="sm" variant="link" asChild>
            <Link href="/student/certificates">View all certificates</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (data.state === 'ELIGIBLE') {
    return (
      <div className="mt-1 grid gap-2.5 rounded-lg border border-amber-200 bg-amber-50/70 p-3.5">
        <div className="flex items-center gap-2 text-sm font-semibold text-amber-950">
          <Award className="size-4 text-amber-700" />
          Eligible for Official Certificate
        </div>
        <p className="type-caption text-amber-900/90">
          You have completed all required lessons and assessments. Claim your verified credential
          now.
        </p>
        <div>
          <Button type="button" size="sm" disabled={claiming} onClick={() => void handleClaim()}>
            <Award className="size-4" />
            {claiming ? 'Issuing Certificate…' : 'Claim Certificate'}
          </Button>
        </div>
      </div>
    );
  }

  if (data.reasons.length > 0) {
    return (
      <div className="mt-1 grid gap-1 rounded-lg border border-border bg-muted/40 p-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-heading">
          <Award className="size-3.5 text-muted-foreground" />
          Certificate Requirements Remaining
        </p>
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {data.reasons.slice(0, 3).map((r) => (
            <li key={r.code}>{r.message}</li>
          ))}
        </ul>
      </div>
    );
  }

  return null;
}
