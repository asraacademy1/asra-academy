import { Award } from 'lucide-react';
import Link from 'next/link';

import { Container } from '@/components/layout/container';
import { CtaBand } from '@/components/public/cta-band';
import { EmptyState } from '@/components/public/empty-state';
import { PageHero } from '@/components/public/page-hero';
import { PublicQuizCard } from '@/components/public/participate/public-quiz-card';
import { Button } from '@/components/ui/button';
import { getPublicCompetitions } from '@/lib/participate';
import { buildPageMetadata } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'Competitions',
  description: 'Academic competitions and olympiads hosted by ASRA Academy.',
  path: '/participate/competitions',
});

export const dynamic = 'force-dynamic';

export default async function ParticipateCompetitionsPage() {
  const result = await getPublicCompetitions(1);

  return (
    <>
      <PageHero
        path="/participate/competitions"
        breadcrumbs={[{ label: 'Participate', href: '/participate' }, { label: 'Competitions' }]}
        eyebrow="Participate · Competitions"
        title="Academic Competitions"
        description={
          <p>
            Public academic competitions and olympiad challenges organized by ASRA Academy. Open
            events are published here with schedules, eligibility, and registration details.
          </p>
        }
      />

      <Container className="py-section">
        {!result.ok ? (
          <EmptyState
            icon={<Award />}
            title="Competitions temporarily unavailable"
            description={result.message}
          />
        ) : result.data.items.length === 0 ? (
          <EmptyState
            icon={<Award />}
            title="No public competitions open right now"
            description="Standalone competitions will be announced here when scheduled. Meanwhile, explore our live and upcoming Academic Quizzes."
            action={
              <div className="flex flex-wrap justify-center gap-3">
                <Button asChild>
                  <Link href="/participate/quizzes">Browse Academic Quizzes</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/participate">Back to Participate</Link>
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
        title="Looking for open quizzes?"
        description="View published live and upcoming quizzes you can register for today."
        primary={{ label: 'Explore quizzes', href: '/participate/quizzes' }}
        secondary={{ label: 'Contact us', href: '/contact' }}
        tertiary={null}
      />
    </>
  );
}
