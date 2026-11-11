import type { PublicParticipateActivitiesDto } from '@asra/types';
import { Award, ClipboardCheck, Radio, Sparkles, Trophy } from 'lucide-react';
import Link from 'next/link';

import { Container } from '@/components/layout/container';
import { Section } from '@/components/layout/section';
import { EmptyState } from '@/components/public/empty-state';
import { Button } from '@/components/ui/button';
import { PublicQuizCard } from './public-quiz-card';

export function ParticipateLandingView({
  activities,
}: {
  activities: PublicParticipateActivitiesDto;
}) {
  const { liveQuizzes, upcomingQuizzes, competitions, assessments, summary } = activities;

  return (
    <>
      <Section
        id="live-quizzes"
        title="Live Quizzes"
        description={
          summary.liveQuizzesCount > 0
            ? 'Published quizzes currently accepting registrations and live participation.'
            : 'Academic quizzes that are open right now appear here.'
        }
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/participate/quizzes?status=live">View all live quizzes</Link>
          </Button>
        }
      >
        {liveQuizzes.length === 0 ? (
          <EmptyState
            icon={<Radio />}
            title="No quiz is live right now"
            description="Check upcoming quizzes below to register ahead of schedule."
            action={
              <Button asChild variant="outline">
                <Link href="/participate/quizzes?status=upcoming">Browse upcoming quizzes</Link>
              </Button>
            }
          />
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {liveQuizzes.map((quiz) => (
              <li key={quiz.id} className="grid">
                <PublicQuizCard quiz={quiz} headingLevel="h3" />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="upcoming-quizzes"
        tone="muted"
        title="Upcoming Quizzes"
        description={
          summary.upcomingQuizzesCount > 0
            ? 'Register in advance for scheduled quizzes opening soon.'
            : 'Scheduled academic quizzes appear here as soon as they are announced.'
        }
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/participate/quizzes?status=upcoming">View all upcoming quizzes</Link>
          </Button>
        }
      >
        {upcomingQuizzes.length === 0 ? (
          <EmptyState
            icon={<Trophy />}
            title="No upcoming quizzes scheduled yet"
            description="New academic quizzes are published regularly. Sign up for updates or check back soon."
            action={
              <Button asChild variant="outline">
                <Link href="/contact">Contact ASRA Academy</Link>
              </Button>
            }
          />
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {upcomingQuizzes.map((quiz) => (
              <li key={quiz.id} className="grid">
                <PublicQuizCard quiz={quiz} headingLevel="h3" />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Container className="grid gap-8 py-section md:grid-cols-2">
        <section aria-labelledby="competitions-heading" className="grid content-start gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="competitions-heading" className="type-h2 text-heading">
              Competitions
            </h2>
            <Button asChild variant="ghost" size="sm">
              <Link href="/participate/competitions">Explore</Link>
            </Button>
          </div>
          {competitions.length === 0 ? (
            <EmptyState
              icon={<Award />}
              title="No standalone competitions open right now"
              description="Open academic competitions and olympiad-style quizzes will appear here when scheduled."
              action={
                <Button asChild variant="outline" size="sm">
                  <Link href="/participate/quizzes">View open quizzes</Link>
                </Button>
              }
            />
          ) : (
            <ul className="grid gap-4">
              {competitions.map((item) => (
                <li key={item.id}>
                  <PublicQuizCard quiz={item} headingLevel="h3" />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="assessments-heading" className="grid content-start gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="assessments-heading" className="type-h2 text-heading">
              Assessments
            </h2>
            <Button asChild variant="ghost" size="sm">
              <Link href="/participate/assessments">Explore</Link>
            </Button>
          </div>
          {assessments.length === 0 ? (
            <EmptyState
              icon={<ClipboardCheck />}
              title="No public assessments open right now"
              description="Course quizzes and examinations are available to enrolled students inside the Student Portal."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link href="/courses">Explore courses</Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link href="/login">Student login</Link>
                  </Button>
                </div>
              }
            />
          ) : (
            <ul className="grid gap-4">
              {assessments.map((item) => (
                <li key={item.id}>
                  <PublicQuizCard quiz={item} headingLevel="h3" />
                </li>
              ))}
            </ul>
          )}
        </section>
      </Container>

      <Container className="pb-section">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-asra-green-50 p-6">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-1 size-5 shrink-0 text-asra-gold-800" aria-hidden />
            <div className="grid gap-1">
              <p className="type-label text-heading">Verified account required for registration</p>
              <p className="type-body-sm text-muted-foreground">
                Browse any quiz publicly, then sign in with a verified student account to register
                and participate when the quiz window opens.
              </p>
            </div>
          </div>
          <Button asChild variant="outline">
            <Link href="/register">Create student account</Link>
          </Button>
        </div>
      </Container>
    </>
  );
}
