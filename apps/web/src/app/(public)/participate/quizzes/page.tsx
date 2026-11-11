import type { ParticipateQuizFilter } from '@asra/validation';
import { Radio, Trophy } from 'lucide-react';
import Link from 'next/link';

import { Container } from '@/components/layout/container';
import { CtaBand } from '@/components/public/cta-band';
import { EmptyState } from '@/components/public/empty-state';
import { PageHero } from '@/components/public/page-hero';
import { PublicQuizCard } from '@/components/public/participate/public-quiz-card';
import { Button } from '@/components/ui/button';
import { getPublicParticipateQuizzes, parseParticipateQuizFilter } from '@/lib/participate';
import { buildPageMetadata } from '@/lib/seo';
import { cn } from '@/lib/utils';

export const metadata = buildPageMetadata({
  title: 'Academic Quizzes',
  description:
    'Browse live and upcoming ASRA Academy quizzes. Open every published quiz publicly, review rules and schedules, and register with a verified account.',
  path: '/participate/quizzes',
});

export const dynamic = 'force-dynamic';

const FILTERS: { key: ParticipateQuizFilter; label: string; href: string }[] = [
  { key: 'all', label: 'All open quizzes', href: '/participate/quizzes' },
  { key: 'live', label: 'Live quizzes', href: '/participate/quizzes?status=live' },
  { key: 'upcoming', label: 'Upcoming quizzes', href: '/participate/quizzes?status=upcoming' },
];

const EMPTY_COPY: Record<
  ParticipateQuizFilter,
  { title: string; description: string; cta?: { label: string; href: string } }
> = {
  all: {
    title: 'No live or upcoming quizzes right now',
    description:
      'New academic quizzes are published here before they open. Check back soon or create a student account to get ready.',
    cta: { label: 'Back to Participate', href: '/participate' },
  },
  live: {
    title: 'No quiz is live right now',
    description: 'View upcoming quizzes to see when the next quiz opens and register early.',
    cta: { label: 'View upcoming quizzes', href: '/participate/quizzes?status=upcoming' },
  },
  upcoming: {
    title: 'No upcoming quizzes scheduled',
    description: 'Check live quizzes or view all participate activities.',
    cta: { label: 'View live quizzes', href: '/participate/quizzes?status=live' },
  },
};

export default async function ParticipateQuizzesPage({
  searchParams,
}: PageProps<'/participate/quizzes'>) {
  const params = await searchParams;
  const status = parseParticipateQuizFilter(params.status);
  const rawPage = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  const page = Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 1000 ? rawPage : 1;

  const result = await getPublicParticipateQuizzes({ status, page, pageSize: 12 });

  const filterHref = (targetPage: number) =>
    status === 'all'
      ? `/participate/quizzes?page=${targetPage}`
      : `/participate/quizzes?status=${status}&page=${targetPage}`;

  const heroTitle =
    status === 'live'
      ? 'Live Academic Quizzes'
      : status === 'upcoming'
        ? 'Upcoming Academic Quizzes'
        : 'Academic Quizzes';

  return (
    <>
      <PageHero
        path="/participate/quizzes"
        breadcrumbs={[{ label: 'Participate', href: '/participate' }, { label: 'Quizzes' }]}
        eyebrow="Participate · Quizzes"
        title={heroTitle}
        description={
          <p>
            Open academic quizzes from ASRA Academy — no course enrolment required. Review full
            instructions, schedules in IST, and register ahead of time.
          </p>
        }
      />

      <Container className="grid gap-8 py-section">
        <nav aria-label="Filter quizzes by status" className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => {
            const active = status === filter.key;
            return (
              <Link
                key={filter.key}
                href={filter.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-control-sm items-center rounded-full border px-4 py-2 type-body-sm font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-foreground hover:bg-secondary',
                )}
              >
                {filter.label}
              </Link>
            );
          })}
        </nav>

        {!result.ok ? (
          <EmptyState
            icon={<Trophy />}
            title="Quizzes temporarily unavailable"
            description={result.message}
          />
        ) : result.data.items.length === 0 ? (
          <EmptyState
            icon={status === 'live' ? <Radio /> : <Trophy />}
            title={EMPTY_COPY[status].title}
            description={EMPTY_COPY[status].description}
            action={
              EMPTY_COPY[status].cta ? (
                <Button asChild variant="outline">
                  <Link href={EMPTY_COPY[status].cta!.href}>{EMPTY_COPY[status].cta!.label}</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid gap-8">
            <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {result.data.items.map((quiz) => (
                <li key={quiz.id} className="grid">
                  <PublicQuizCard quiz={quiz} headingLevel="h2" />
                </li>
              ))}
            </ul>

            {result.data.pagination.pageCount > 1 ? (
              <nav
                aria-label="Quiz pages"
                className="flex items-center justify-between border-t pt-6"
              >
                <p className="type-body-sm text-muted-foreground">
                  Page {result.data.pagination.page} of {result.data.pagination.pageCount}
                </p>
                <div className="flex gap-2">
                  {result.data.pagination.page > 1 ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={filterHref(result.data.pagination.page - 1)}>Previous</Link>
                    </Button>
                  ) : null}
                  {result.data.pagination.page < result.data.pagination.pageCount ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={filterHref(result.data.pagination.page + 1)}>Next</Link>
                    </Button>
                  ) : null}
                </div>
              </nav>
            ) : null}
          </div>
        )}
      </Container>

      <CtaBand
        title="Register with a verified student account"
        description="Sign in or create an account to confirm your seat in upcoming quizzes."
        primary={{ label: 'Sign in', href: '/login?next=/participate/quizzes' }}
        secondary={{ label: 'All activities', href: '/participate' }}
        tertiary={null}
      />
    </>
  );
}
