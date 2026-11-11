import Link from 'next/link';

import { Container } from '@/components/layout/container';
import { CtaBand } from '@/components/public/cta-band';
import { EmptyState } from '@/components/public/empty-state';
import { PageHero } from '@/components/public/page-hero';
import { ParticipateLandingView } from '@/components/public/participate/participate-landing';
import { Button } from '@/components/ui/button';
import { getPublicParticipateActivities } from '@/lib/participate';
import { buildPageMetadata } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'Participate',
  description:
    'Discover live quizzes, upcoming quizzes, competitions, and assessments at ASRA Academy and register with a verified student account.',
  path: '/participate',
});

export const dynamic = 'force-dynamic';

export default async function ParticipatePage() {
  const result = await getPublicParticipateActivities();

  return (
    <>
      <PageHero
        path="/participate"
        breadcrumbs={[{ label: 'Participate' }]}
        eyebrow="Participate"
        title="Quizzes, competitions, and assessments"
        description={
          <p>
            Explore live and upcoming academic quizzes, open competitions, and participation
            opportunities hosted by ASRA Academy. Register in advance with a verified student
            account.
          </p>
        }
        actions={
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/participate/quizzes?status=live">Live quizzes</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/participate/quizzes?status=upcoming">Upcoming quizzes</Link>
            </Button>
          </div>
        }
      />

      {result.ok ? (
        <ParticipateLandingView activities={result.data} />
      ) : (
        <Container className="py-section">
          <EmptyState
            title="Activities temporarily unavailable"
            description={result.message}
            action={
              <Button asChild variant="outline">
                <Link href="/participate/quizzes">Browse quizzes</Link>
              </Button>
            }
          />
        </Container>
      )}

      <CtaBand
        title="Ready to take part?"
        description="Sign in or register for a free verified student account to join open academic quizzes."
        primary={{ label: 'Create student account', href: '/register?next=/participate' }}
        secondary={{ label: 'Student login', href: '/login?next=/participate' }}
        tertiary={null}
      />
    </>
  );
}
