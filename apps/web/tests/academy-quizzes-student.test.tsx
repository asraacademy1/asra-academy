/**
 * Academy Quizzes, student side: the fullscreen START rule (no attempt request unless fullscreen
 * was entered; unsupported devices get a clear message), browser-only mark-for-review storage,
 * labels, the quiz card and the result screen. Server behaviour (eligibility, deadlines, linear
 * navigation, release rules) is covered by apps/api/tests/academy-quizzes-student.test.ts.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { StudentAcademyAttemptDto, StudentAcademyQuizItem } from '@asra/types';

import { AcademyAttemptOutcome } from '@/components/student/academy-quizzes/attempt-player';
import { AcademyQuizCard } from '@/components/student/academy-quizzes/quiz-list';
import { studentNavigation } from '@/components/student/student-shell';
import {
  enterFullscreen,
  FULLSCREEN_MESSAGES,
  fullscreenSupported,
  leaveFullscreen,
  readMarked,
  releaseLabel,
  isFullscreen,
  RESUME_FULLSCREEN_MESSAGES,
  startOnlyInFullscreen,
  timingLabel,
  writeMarked,
} from '@/lib/student/academy-quizzes';

/** A minimal document whose fullscreen behaviour the test controls. */
function fakeDocument(options: {
  standard?: boolean;
  webkit?: boolean;
  enabled?: boolean;
  refuse?: boolean;
}) {
  const doc: Record<string, unknown> = {
    fullscreenElement: null,
    fullscreenEnabled: options.standard ? options.enabled !== false : undefined,
    webkitFullscreenEnabled: options.webkit ? options.enabled !== false : undefined,
    exits: 0,
  };
  const element: Record<string, unknown> = {};
  if (options.standard) {
    element.requestFullscreen = async () => {
      if (options.refuse) throw new Error('Permissions check failed');
      doc.fullscreenElement = element;
    };
    doc.exitFullscreen = async () => {
      doc.exits = (doc.exits as number) + 1;
      doc.fullscreenElement = null;
    };
  }
  if (options.webkit) {
    element.webkitRequestFullscreen = () => {
      setTimeout(() => (doc.webkitFullscreenElement = element), 20);
    };
  }
  doc.documentElement = element;
  return doc as unknown as Document & { exits: number };
}

describe('fullscreen start requirement', () => {
  it('reports iPhone-style browsers as unsupported', async () => {
    const iphone = fakeDocument({ webkit: true, enabled: false });
    assert.equal(fullscreenSupported(iphone), false);
    assert.equal(await enterFullscreen(iphone), 'unsupported');
    assert.match(FULLSCREEN_MESSAGES.unsupported, /iPhone/);
  });

  it('reports a refused permission', async () => {
    assert.equal(await enterFullscreen(fakeDocument({ standard: true, refuse: true })), 'refused');
  });

  it('enters fullscreen with the standard and WebKit APIs', async () => {
    assert.equal(await enterFullscreen(fakeDocument({ standard: true })), 'entered');
    assert.equal(await enterFullscreen(fakeDocument({ webkit: true })), 'entered');
    assert.equal(await enterFullscreen(fakeDocument({ webkit: true }), 0), 'refused');
  });

  it('tells a resuming student that their time is still running', () => {
    assert.match(RESUME_FULLSCREEN_MESSAGES.refused, /still running/);
    assert.match(RESUME_FULLSCREEN_MESSAGES.unsupported, /still running/);
    assert.doesNotMatch(RESUME_FULLSCREEN_MESSAGES.refused, /not running/);
  });

  it('creates the attempt only while fullscreen is on', async () => {
    let created = 0;
    const off = await startOnlyInFullscreen(
      () => false,
      async () => ++created,
    );
    assert.deepEqual(off, { started: false, message: FULLSCREEN_MESSAGES.left });
    assert.equal(created, 0);

    const doc = fakeDocument({ standard: true });
    assert.equal(await enterFullscreen(doc), 'entered');
    const on = await startOnlyInFullscreen(
      () => isFullscreen(doc),
      async () => ++created,
    );
    assert.deepEqual(on, { started: true, value: 1 });
  });

  it('leaving fullscreen at the end is a courtesy and safe when not in fullscreen', async () => {
    const doc = fakeDocument({ standard: true });
    leaveFullscreen(doc);
    assert.equal(doc.exits, 0);
    await enterFullscreen(doc);
    leaveFullscreen(doc);
    assert.equal(doc.exits, 1);
  });
});

describe('mark for review (browser only)', () => {
  const globals = globalThis as { window?: unknown };
  afterEach(() => {
    delete globals.window;
  });

  it('keeps marks per attempt in local storage', () => {
    const store = new Map<string, string>();
    globals.window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    };
    writeMarked('a1', new Set(['q1', 'q2']));
    assert.deepEqual([...readMarked('a1')], ['q1', 'q2']);
    assert.equal(readMarked('a2').size, 0);
    writeMarked('a1', new Set());
    assert.equal(store.size, 0);
  });

  it('works without storage (private mode) instead of failing', () => {
    globals.window = {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
        removeItem: () => {
          throw new Error('blocked');
        },
      },
    };
    assert.doesNotThrow(() => writeMarked('a1', new Set(['q1'])));
    assert.equal(readMarked('a1').size, 0);
  });
});

describe('student labels and screens', () => {
  it('describes timing and result release', () => {
    assert.equal(
      timingLabel({ timerMode: 'OVERALL', durationMinutes: 30, questionTimeSeconds: null }),
      '30 minutes',
    );
    assert.equal(
      timingLabel({ timerMode: 'PER_QUESTION', durationMinutes: null, questionTimeSeconds: 45 }),
      '45 seconds per question',
    );
    assert.match(releaseLabel('SCHEDULED', '2 Dec 2026, 10:00 am IST'), /2 Dec 2026/);
    assert.match(releaseLabel('MANUAL', null), /after the quiz ends/);
  });

  it('lists Academy Quizzes in the student navigation', () => {
    const items = studentNavigation.flatMap((group) => group.items);
    assert.ok(items.some((item) => item.href === '/student/academy-quizzes'));
  });

  const item = (over: Partial<StudentAcademyQuizItem> = {}): StudentAcademyQuizItem => ({
    id: 'q1',
    slug: 'science-olympiad',
    title: 'Science Olympiad',
    summary: 'Win prizes',
    banner: null,
    phase: 'LIVE',
    startsAt: '2026-12-01T04:30:00.000Z',
    endsAt: '2026-12-01T06:30:00.000Z',
    timerMode: 'OVERALL',
    durationMinutes: 30,
    questionTimeSeconds: null,
    questionsPerAttempt: 20,
    hasPrizes: true,
    eligible: true,
    participation: { attemptsUsed: 0, maxAttempts: 1, inProgressAttemptId: null, bestResult: null },
    ...over,
  });

  it('renders a quiz card with its state, schedule in IST and next action', () => {
    const live = renderToStaticMarkup(<AcademyQuizCard quiz={item()} />);
    assert.match(live, /Live now/);
    assert.match(live, /Prizes/);
    assert.match(live, /IST/);
    assert.match(live, /30 minutes · 20 questions/);
    assert.match(live, /View and start/);
    assert.match(live, /href="\/student\/academy-quizzes\/science-olympiad"/);

    const running = renderToStaticMarkup(
      <AcademyQuizCard
        quiz={item({
          participation: {
            attemptsUsed: 1,
            maxAttempts: 1,
            inProgressAttemptId: 'a1',
            bestResult: null,
          },
        })}
      />,
    );
    assert.match(running, /Attempt in progress/);
    assert.match(running, />Continue</);

    const ineligible = renderToStaticMarkup(<AcademyQuizCard quiz={item({ eligible: false })} />);
    assert.match(ineligible, /Not eligible/);
    assert.match(ineligible, /View details/);
  });

  const attempt = (over: Partial<StudentAcademyAttemptDto> = {}): StudentAcademyAttemptDto => ({
    id: 'a1',
    quiz: { id: 'q1', slug: 'science-olympiad', title: 'Science Olympiad' },
    attemptNumber: 1,
    status: 'SUBMITTED',
    startedAt: '2026-12-01T05:00:00.000Z',
    deadlineAt: '2026-12-01T05:30:00.000Z',
    submittedAt: '2026-12-01T05:20:00.000Z',
    serverNow: '2026-12-01T05:20:00.000Z',
    timerMode: 'OVERALL',
    navigation: 'FREE',
    requireAnswerToAdvance: false,
    questionCount: 1,
    currentPosition: null,
    currentQuestionDeadlineAt: null,
    negativeMarking: false,
    maxScore: 2,
    questions: [
      {
        id: 'aq1',
        position: 0,
        type: 'SINGLE_CHOICE',
        prompt: 'What is 2 + 3?',
        marks: 2,
        negativeMarks: 0,
        options: [
          { id: 'o1', text: '4', image: null },
          { id: 'o2', text: '5', image: null },
        ],
        images: [],
        selectedOptionIds: ['o2'],
        textAnswer: null,
        answerSequence: 1,
      },
    ],
    resultState: 'RELEASED',
    resultsAt: null,
    result: { rawScore: 2, penalty: 0, score: 2, maxScore: 2, percent: 100, passed: true },
    review: null,
    ...over,
  });

  it('shows a released score, and a pending one with its scheduled IST time', () => {
    const released = renderToStaticMarkup(<AcademyAttemptOutcome attempt={attempt()} />);
    assert.match(released, /Passed/);
    assert.match(released, /100%/);
    assert.match(released, /Your answers/);
    assert.doesNotMatch(released, /faculty/);

    const waiting = renderToStaticMarkup(
      <AcademyAttemptOutcome
        attempt={attempt({
          resultState: 'AWAITING_RELEASE',
          result: null,
          resultsAt: '2026-12-02T04:30:00.000Z',
        })}
      />,
    );
    assert.match(waiting, /Result not published yet/);
    assert.match(waiting, /IST/);
    assert.doesNotMatch(waiting, /Passed/);

    const expired = renderToStaticMarkup(
      <AcademyAttemptOutcome attempt={attempt({ status: 'EXPIRED' })} />,
    );
    assert.match(expired, /Submitted automatically/);
  });
});
