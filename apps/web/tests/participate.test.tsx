/**
 * Academic Quiz public access & Participate UI unit/component tests:
 *   - Navbar PARTICIPATE dropdown (Quizzes, Competitions, Assessments) on desktop + mobile
 *   - Footer PARTICIPATE dynamic column alongside Learn, Academy, Careers
 *   - Public routes, robots/sitemap compatibility, and filter parsing
 *   - Participate landing page, public quiz cards & detail rendering (safe public fields only)
 *   - Auth return-URL persistence for public quiz registration
 *   - Admin public link & visibility rules (hide draft/private; expose View Public Page & Copy URL)
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AdminAcademyQuizDetail,
  PublicAcademyQuizDetail,
  PublicParticipateActivitiesDto,
} from '@asra/types';

import { PRIVATE_PATH_PREFIXES } from '@/app/robots';
import {
  ParticipantsTable,
  participantsExportPath,
  participantsQueryString,
} from '@/components/admin/academy-quizzes/participants';
import { buildFooterColumns } from '@/components/layout/footer';
import { ParticipateLandingView } from '@/components/public/participate/participate-landing';
import { PublicQuizCard } from '@/components/public/participate/public-quiz-card';
import { PublicQuizDetailView } from '@/components/public/participate/public-quiz-detail-view';
import { footerNavigation, publicNavigation } from '@/config/navigation';
import {
  emptyForm,
  formFromDetail,
  formToBody,
  publicQuizAccessState,
  publishedPatch,
} from '@/lib/admin/academy-quizzes';
import { loginHref } from '@/lib/auth/return-to';
import { isActiveNavItem } from '@/lib/navigation';
import {
  eligibilitySummaryText,
  parseParticipateQuizFilter,
  publicQuizHref,
} from '@/lib/participate';
import { getIndexablePaths } from '@/lib/sitemap';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

const SAMPLE_QUIZ: PublicAcademyQuizDetail = {
  id: 'quiz-1',
  slug: 'quizora-2026',
  title: 'Quizora 2026',
  summary: 'Annual science and general knowledge competition.',
  banner: null,
  phase: 'UPCOMING',
  startsAt: '2026-12-01T04:30:00.000Z',
  endsAt: '2026-12-01T06:30:00.000Z',
  timeZone: 'Asia/Kolkata',
  timerMode: 'OVERALL',
  durationMinutes: 45,
  questionTimeSeconds: null,
  questionsPerAttempt: 20,
  totalMarks: 40,
  hasPrizes: true,
  eligibleClasses: [{ id: 'c1', name: 'Class 10' }],
  eligibleStreams: [],
  registrationOpen: true,
  registrationClosedReason: null,
  description: 'Open quiz for school students across India.',
  instructions: 'Ensure a stable internet connection before opening the quiz.',
  prizes: [{ position: 1, title: 'Merit Trophy', description: 'Top scorer award', image: null }],
  navigation: 'FREE',
  requireAnswerToAdvance: false,
  negativeMarking: false,
  passPercent: 40,
  maxAttempts: 1,
  resultsAt: null,
  resultRelease: 'IMMEDIATE',
  answerReveal: 'AFTER_CLOSE',
  leaderboardVisible: true,
  serverNow: '2026-11-25T00:00:00.000Z',
};

describe('Participate navbar & footer navigation', () => {
  it('adds PARTICIPATE with Quizzes, Competitions, Assessments alongside existing nav items', () => {
    const participate = publicNavigation.find((item) => item.label === 'Participate');
    assert.ok(participate);
    assert.equal(participate.href, '/participate');
    assert.deepEqual(
      participate.children?.map((c) => [c.label, c.href]),
      [
        ['Quizzes', '/participate/quizzes'],
        ['Competitions', '/participate/competitions'],
        ['Assessments', '/participate/assessments'],
      ],
    );
    assert.ok(isActiveNavItem('/participate/quizzes/quizora-2026', participate));
    assert.ok(!isActiveNavItem('/courses/english', participate));
    assert.ok(publicNavigation.some((item) => item.href === '/courses'));
    assert.ok(publicNavigation.some((item) => item.href === '/careers'));
  });

  it('builds Footer PARTICIPATE column with Live & Upcoming Quizzes and conditional activities', () => {
    assert.ok(footerNavigation.some((col) => col.title === 'Learn'));
    assert.ok(footerNavigation.some((col) => col.title === 'Academy'));
    assert.ok(footerNavigation.some((col) => col.title === 'Careers'));
    assert.ok(footerNavigation.some((col) => col.title === 'Participate'));

    const defaultCols = buildFooterColumns(footerNavigation, [], {
      hasCompetitions: false,
      hasAssessments: false,
    });
    const partDefault = defaultCols.find((col) => col.title === 'Participate')!;
    assert.deepEqual(
      partDefault.links.map((l) => [l.label, l.href]),
      [
        ['Live Quizzes', '/participate/quizzes?status=live'],
        ['Upcoming Quizzes', '/participate/quizzes?status=upcoming'],
      ],
    );

    const expandedCols = buildFooterColumns(footerNavigation, [], {
      hasCompetitions: true,
      hasAssessments: true,
    });
    const partExpanded = expandedCols.find((col) => col.title === 'Participate')!;
    assert.deepEqual(
      partExpanded.links.map((l) => [l.label, l.href]),
      [
        ['Live Quizzes', '/participate/quizzes?status=live'],
        ['Upcoming Quizzes', '/participate/quizzes?status=upcoming'],
        ['Competitions', '/participate/competitions'],
        ['Assessments', '/participate/assessments'],
      ],
    );
  });

  it('keeps all Participate App Router pages present and indexable', () => {
    const publicDir = path.resolve(import.meta.dirname, '../src/app/(public)');
    for (const segments of [
      ['participate', 'page.tsx'],
      ['participate', 'quizzes', 'page.tsx'],
      ['participate', 'quizzes', '[slug]', 'page.tsx'],
      ['participate', 'competitions', 'page.tsx'],
      ['participate', 'assessments', 'page.tsx'],
    ]) {
      assert.ok(existsSync(path.join(publicDir, ...segments)), segments.join('/'));
    }
    const indexable = getIndexablePaths();
    assert.ok(indexable.includes('/participate'));
    assert.ok(indexable.includes('/participate/quizzes'));
    for (const prefix of PRIVATE_PATH_PREFIXES) {
      assert.ok(!'/participate/quizzes/quizora-2026'.startsWith(prefix));
    }
  });
});

describe('Public Participate pages, cards & registration helpers', () => {
  it('parses filter params and formats return URLs cleanly', () => {
    assert.equal(parseParticipateQuizFilter('LIVE'), 'live');
    assert.equal(parseParticipateQuizFilter('upcoming'), 'upcoming');
    assert.equal(parseParticipateQuizFilter('unknown'), 'all');
    assert.equal(publicQuizHref('quizora-2026'), '/participate/quizzes/quizora-2026');
    assert.equal(
      loginHref('/participate/quizzes/quizora-2026'),
      '/login?next=%2Fparticipate%2Fquizzes%2Fquizora-2026',
    );
    assert.match(eligibilitySummaryText(SAMPLE_QUIZ), /Classes: Class 10/);
  });

  it('renders ParticipateLandingView sections and empty states', () => {
    const activities: PublicParticipateActivitiesDto = {
      summary: {
        liveQuizzesCount: 0,
        upcomingQuizzesCount: 1,
        competitionsCount: 0,
        assessmentsCount: 0,
      },
      liveQuizzes: [],
      upcomingQuizzes: [SAMPLE_QUIZ],
      competitions: [],
      assessments: [],
      serverNow: SAMPLE_QUIZ.serverNow,
    };
    const out = html(<ParticipateLandingView activities={activities} />);
    assert.match(out, /Live Quizzes/);
    assert.match(out, /Upcoming Quizzes/);
    assert.match(out, /Competitions/);
    assert.match(out, /Assessments/);
    assert.match(out, /No quiz is live right now/);
    assert.match(out, /Quizora 2026/);
  });

  it('renders PublicQuizCard and PublicQuizDetailView without private question or answer fields', () => {
    const cardHtml = html(<PublicQuizCard quiz={SAMPLE_QUIZ} />);
    assert.match(cardHtml, /Quizora 2026/);
    assert.match(cardHtml, /View Details/);
    assert.match(cardHtml, /Register Now/);

    const detailHtml = html(<PublicQuizDetailView quiz={SAMPLE_QUIZ} />);
    assert.match(detailHtml, /<h1[^>]*>Quizora 2026<\/h1>/);
    assert.match(detailHtml, /Merit Trophy/);
    assert.match(detailHtml, /Class 10/);
    assert.match(detailHtml, /Open quiz for school students/);
    assert.match(detailHtml, /Ensure a stable internet connection/);
    assert.doesNotMatch(detailHtml, /isCorrect|publishProblems/);
  });
});

describe('Admin public access rules & visibility form state', () => {
  function adminQuiz(
    status: 'DRAFT' | 'PUBLISHED' | 'CLOSED',
    visibility: 'PUBLIC' | 'PRIVATE',
  ): AdminAcademyQuizDetail {
    return {
      id: 'q1',
      slug: 'quizora-2026',
      title: 'Quizora 2026',
      status,
      visibility,
      phase: status === 'DRAFT' ? 'DRAFT' : status === 'CLOSED' ? 'CLOSED' : 'UPCOMING',
      startsAt: SAMPLE_QUIZ.startsAt,
      endsAt: SAMPLE_QUIZ.endsAt,
      questionCount: 5,
      registrationsCount: 12,
      attempts: { total: 0, inProgress: 0, pendingEvaluation: 0, evaluated: 0 },
      publishedAt: status === 'DRAFT' ? null : '2026-11-25T00:00:00.000Z',
      updatedAt: '2026-11-25T00:00:00.000Z',
      settings: {
        title: 'Quizora 2026',
        slug: 'quizora-2026',
        summary: null,
        description: null,
        instructions: null,
        startsAt: SAMPLE_QUIZ.startsAt,
        endsAt: SAMPLE_QUIZ.endsAt,
        resultsAt: null,
        timeZone: 'Asia/Kolkata',
        timerMode: 'OVERALL',
        durationMinutes: 45,
        questionTimeSeconds: null,
        navigation: 'FREE',
        requireAnswerToAdvance: false,
        selection: 'ALL',
        questionsPerAttempt: null,
        easyCount: null,
        mediumCount: null,
        hardCount: null,
        shuffleQuestions: false,
        shuffleOptions: false,
        negativeMarking: false,
        passPercent: 40,
        maxAttempts: 1,
        eligibleClassIds: [],
        eligibleStreamIds: [],
        resultRelease: 'IMMEDIATE',
        answerReveal: 'AFTER_CLOSE',
        leaderboardVisibility: 'SIGNED_IN',
        visibility,
        maskNames: false,
        attemptCounting: 'BEST',
        tieBreak: 'TIME_TAKEN',
      },
      banner: null,
      prizes: [],
      eligibleClasses: [],
      eligibleStreams: [],
      questions: [],
      pool: { total: 5, EASY: 5, MEDIUM: 0, HARD: 0, unrated: 0 },
      questionsPerAttempt: 5,
      totalMarksPerAttempt: 10,
      publishProblems: [],
      resultsPublishedAt: null,
      closedAt: null,
      serverNow: '2026-11-25T00:00:00.000Z',
    };
  }

  it('exposes public URL only when published and PUBLIC; hides draft and PRIVATE quizzes', () => {
    const pub = publicQuizAccessState(adminQuiz('PUBLISHED', 'PUBLIC'));
    assert.equal(pub.available, true);
    assert.equal(pub.path, '/participate/quizzes/quizora-2026');

    const closed = publicQuizAccessState(adminQuiz('CLOSED', 'PUBLIC'));
    assert.equal(closed.available, true);
    assert.equal(closed.path, '/participate/quizzes/quizora-2026');

    const priv = publicQuizAccessState(adminQuiz('PUBLISHED', 'PRIVATE'));
    assert.equal(priv.available, false);
    assert.equal(priv.path, null);

    const draft = publicQuizAccessState(adminQuiz('DRAFT', 'PUBLIC'));
    assert.equal(draft.available, false);
    assert.equal(draft.path, null);
  });

  it('includes visibility in emptyForm, formFromDetail, formToBody, and publishedPatch', () => {
    assert.equal(emptyForm().visibility, 'PUBLIC');
    const detail = adminQuiz('PUBLISHED', 'PRIVATE');
    const form = formFromDetail(detail);
    assert.equal(form.visibility, 'PRIVATE');
    const body = formToBody(form);
    assert.equal(body.visibility, 'PRIVATE');
    assert.equal(publishedPatch(body).visibility, 'PRIVATE');
  });

  it('renders ParticipantsTable with serial numbers, phone fallback, verification & status badges, and builds filter/export URLs', () => {
    const query = participantsQueryString({
      page: 2,
      limit: 10,
      search: 'aarav',
      sort: 'oldest',
      verificationStatus: 'VERIFIED',
    });
    assert.equal(query, 'page=2&limit=10&sort=oldest&verificationStatus=VERIFIED&search=aarav');
    assert.equal(
      participantsExportPath('q1', {
        search: 'aarav',
        sort: 'newest',
        verificationStatus: 'ALL',
      }),
      '/admin/academy-quizzes/q1/participants/export?sort=newest&verificationStatus=ALL&search=aarav',
    );

    const tableHtml = html(
      <ParticipantsTable
        page={2}
        limit={10}
        items={[
          {
            id: 'r1',
            userId: 'u1',
            studentName: 'Aarav Khan',
            email: 'aarav@example.test',
            phone: '+919876543210',
            registeredAt: '2026-11-25T10:00:00.000Z',
            emailVerified: true,
            status: 'REGISTERED',
          },
          {
            id: 'r2',
            userId: 'u2',
            studentName: 'Zoya Fatima',
            email: 'zoya@example.test',
            phone: null,
            registeredAt: '2026-11-25T11:00:00.000Z',
            emailVerified: false,
            status: 'REGISTERED',
          },
        ]}
      />,
    );
    assert.match(tableHtml, />11</);
    assert.match(tableHtml, />12</);
    assert.match(tableHtml, /Aarav Khan/);
    assert.match(tableHtml, /\+919876543210/);
    assert.match(tableHtml, />Verified</);
    assert.match(tableHtml, />Unverified</);
    assert.match(tableHtml, />Registered</);
  });
});
