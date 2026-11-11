import { ClipboardCheck } from 'lucide-react';
import Link from 'next/link';

import { Container } from '@/components/layout/container';
import { CtaBand } from '@/components/public/cta-band';
import { EmptyState } from '@/components/public/empty-state';
import { PageHero } from '@/components/public/page-hero';
import { PublicQuizCard } from '@/components/public/participate/public-quiz-card';
import { Button } from '@/components/ui/button';
import { getPublicAssessments } from '@/lib/participate';
import { buildPageMetadata } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'Assessments',
  description: 'Public open assessments and student evaluation opportunities at ASRA Academy.',
  path: '/participate/assessments',
});

export const dynamic = 'force-dynamic';

export default async function ParticipateAssessmentsPage() {
  const result = await getPublicAssessments(1);

  return (
    <>
      <PageHero
        path="/participate/assessments"
        breadcrumbs={[{ label: 'Participate', href: '/participate' }, { label: 'Assessments' }]}
        eyebrow="Participate · Assessments"
        title="Open Assessments"
        description={
          <p>
            Public open assessments are listed here when announced. Course quizzes and scheduled
            examinations remain available inside the Student Portal for enrolled learners.
          </p>
        }
      />

      <Container className="py-section">
        {!result.ok ? (
          <EmptyState
            icon={<ClipboardCheck />}
            title="Assessments temporarily unavailable"
            description={result.message}
          />
        ) : result.data.items.length === 0 ? (
          <EmptyState
            icon={<ClipboardCheck />}
            title="No public assessments open right now"
            description="Course quizzes and examinations are accessible to enrolled students in the Student Portal, while open quizzes require no course enrolment."
            action={
              <div className="flex flex-wrap justify-center gap-3">
                <Button asChild>
                  <Link href="/participate/quizzes">Browse open quizzes</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/login">Student portal login</Link>
                </Button>
              </div>
            }
          />
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {result.data.items.map((item) => (
              <li key={item.id} className="grid">
                <PublicQuizCard quiz={item} headingLevel="h2" />
              </li>
            ))}
          </ul>
        )}
      </Container>

      <CtaBand
        title="Enrolled in a course?"
        description="Sign in to access your course quizzes, assignments, and scheduled examinations."
        primary={{ label: 'Student login', href: '/login' }}
        secondary={{ label: 'Explore courses', href: '/courses' }}
        tertiary={null}
      />
    </>
  );
}
