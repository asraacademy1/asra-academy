import type {
  AttemptStartDto,
  FacultyExamDetail,
  FacultyQuizDetail,
  QuestionDto,
} from '@asra/types';
import { setClockForTests } from '../../src/lib/clock.js';
import { login, registerVerifiedStudent, resetAuthState } from './auth.js';
import {
  apiAs,
  createFaculty,
  createPublishableCourse,
  expectStatus,
  tokenFor,
  type Api,
} from './catalog.js';
import { TestClient } from './http.js';

/**
 * Shared world for the PHASE 09 assessment suites (real HTTP, real database):
 *
 *   course A — taught by Alice; students Sam and Una enrolled
 *   course B — taught by Bob;   student Tara enrolled
 *
 * Every suite pins the server clock with `at()`; nothing waits in real time.
 */

export type Faculty = Awaited<ReturnType<typeof newFaculty>>;
export type Student = Awaited<ReturnType<typeof newStudent>>;

export async function newFaculty(baseUrl: string) {
  const { user, facultyProfileId } = await createFaculty();
  const client = new TestClient(baseUrl);
  const session = await login(client, user.email);
  return {
    api: apiAs(client, session.accessToken),
    userId: user.id,
    facultyProfileId,
    token: session.accessToken,
  };
}

export async function newStudent(baseUrl: string) {
  const client = new TestClient(baseUrl);
  const email = await registerVerifiedStudent(client);
  const session = await login(client, email);
  return {
    api: apiAs(client, session.accessToken),
    userId: session.user.id,
    email,
    token: session.accessToken,
  };
}

/** The same student signed in against another API instance (e.g. after a "restart"). */
export async function signInAgain(baseUrl: string, student: { email: string; userId: string }) {
  const client = new TestClient(baseUrl);
  const session = await login(client, student.email);
  return {
    api: apiAs(client, session.accessToken),
    userId: student.userId,
    email: student.email,
    token: session.accessToken,
  };
}

export async function buildWorld(baseUrl: string) {
  setClockForTests(null);
  await resetAuthState();
  const admin = apiAs(new TestClient(baseUrl), await tokenFor(new TestClient(baseUrl), 'ADMIN'));
  const [alice, bob, sam, una, tara] = await Promise.all([
    newFaculty(baseUrl),
    newFaculty(baseUrl),
    newStudent(baseUrl),
    newStudent(baseUrl),
    newStudent(baseUrl),
  ]);
  const courseA = await createPublishableCourse(admin, { priceMinor: 0, currency: 'INR' });
  const courseB = await createPublishableCourse(admin, { priceMinor: 0, currency: 'INR' });
  for (const [course, faculty] of [
    [courseA, alice],
    [courseB, bob],
  ] as const) {
    expectStatus(
      await admin('PUT', `/admin/courses/${course.courseId}/instructors`, {
        instructors: [{ facultyProfileId: faculty.facultyProfileId, isPrimary: true }],
      }),
      200,
    );
    expectStatus(await admin('POST', `/admin/courses/${course.courseId}/publish`), 200);
  }
  for (const [student, course] of [
    [sam, courseA],
    [una, courseA],
    [tara, courseB],
  ] as const) {
    expectStatus(await student.api('POST', `/student/courses/${course.courseId}/enroll`), 201);
  }
  return { admin, alice, bob, sam, una, tara, courseA, courseB };
}

export type World = Awaited<ReturnType<typeof buildWorld>>;

/** Pins the server clock (UTC). */
export function at(iso: string | Date): Date {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  setClockForTests(date);
  return date;
}

export const plusMinutes = (date: Date, minutes: number) =>
  new Date(date.getTime() + minutes * 60_000);

// --- Question builders -----------------------------------------------------------------------

export const mcq = (marks = 2, negativeMarks = 0) => ({
  type: 'SINGLE_CHOICE' as const,
  prompt: 'What is 2 + 3?',
  explanation: 'Add the numbers.',
  marks,
  negativeMarks,
  options: [
    { text: '4', isCorrect: false },
    { text: '5', isCorrect: true },
    { text: '6', isCorrect: false },
  ],
});

export const trueFalse = (marks = 1, negativeMarks = 0) => ({
  type: 'TRUE_FALSE' as const,
  prompt: 'The square root of 49 is 7.',
  marks,
  negativeMarks,
  options: [
    { text: 'True', isCorrect: true },
    { text: 'False', isCorrect: false },
  ],
});

export const multi = (marks = 3, negativeMarks = 0) => ({
  type: 'MULTIPLE_CHOICE' as const,
  prompt: 'Which numbers are prime?',
  marks,
  negativeMarks,
  options: [
    { text: '2', isCorrect: true },
    { text: '3', isCorrect: true },
    { text: '4', isCorrect: false },
    { text: '9', isCorrect: false },
  ],
});

export const written = (marks = 5) => ({
  type: 'SHORT_ANSWER' as const,
  prompt: 'Explain the quadratic formula.',
  marks,
});

/** Correct option ids of a source question (by its option text), for answering. */
export function optionIdsByText(
  question: { options: { id: string; text: string }[] },
  ...texts: string[]
) {
  return texts.map((text) => {
    const option = question.options.find((o) => o.text === text);
    if (!option) throw new Error(`No option "${text}"`);
    return option.id;
  });
}

// --- Quiz helpers ----------------------------------------------------------------------------

export const quizRules = {
  timeLimitMinutes: null as number | null,
  maxAttempts: 2,
  passPercent: 50,
  negativeMarking: false,
  shuffleQuestions: false,
  shuffleOptions: false,
  questionsPerAttempt: null as number | null,
  showResultImmediately: true,
  answerReveal: 'AFTER_SUBMISSION' as 'NEVER' | 'AFTER_SUBMISSION' | 'AFTER_CLOSE',
};

/** DRAFT QUIZ lesson + quiz, with the given questions, then (optionally) published end to end. */
export async function createQuiz(
  faculty: Faculty,
  chapterId: string,
  options: {
    rules?: Partial<typeof quizRules>;
    questions?: ReturnType<typeof mcq | typeof trueFalse | typeof multi>[];
    publish?: boolean;
  } = {},
) {
  const created = await faculty.api<FacultyQuizDetail>(
    'POST',
    `/faculty/chapters/${chapterId}/quizzes`,
    {
      title: 'Numbers quiz',
      instructions: 'Answer every question. Calculators are not allowed.',
      ...quizRules,
      ...options.rules,
    },
  );
  expectStatus(created, 201);
  const lessonId = created.body.data.lessonId;
  const questions: QuestionDto[] = [];
  for (const question of options.questions ?? [mcq(), trueFalse(), multi()]) {
    const response = await faculty.api<QuestionDto>(
      'POST',
      `/faculty/quizzes/${lessonId}/questions`,
      question,
    );
    expectStatus(response, 201);
    questions.push(response.body.data);
  }
  if (options.publish !== false) {
    expectStatus(
      await faculty.api('PATCH', `/faculty/lessons/${lessonId}`, { status: 'PUBLISHED' }),
      200,
    );
    expectStatus(
      await faculty.api('POST', `/faculty/quizzes/${lessonId}/status`, { action: 'publish' }),
      200,
    );
  }
  return { lessonId, quizId: created.body.data.quiz!.id, questions };
}

export async function startQuiz(student: Student, lessonId: string, status = 201) {
  const response = await student.api<AttemptStartDto>(
    'POST',
    `/student/lessons/${lessonId}/quiz/attempts`,
  );
  expectStatus(response, status);
  return response.body.data.attempt;
}

// --- Exam helpers ----------------------------------------------------------------------------

export async function createExam(
  faculty: Faculty,
  courseId: string,
  window: { opensAt: Date; closesAt: Date },
  options: {
    durationMinutes?: number;
    maxAttempts?: number;
    questions?: object[];
    publish?: boolean;
    extra?: Record<string, unknown>;
  } = {},
) {
  const created = await faculty.api<FacultyExamDetail>(
    'POST',
    `/faculty/courses/${courseId}/exams`,
    {
      title: 'Mid-term examination',
      instructions: 'Read every question carefully.',
      opensAt: window.opensAt.toISOString(),
      closesAt: window.closesAt.toISOString(),
      durationMinutes: options.durationMinutes ?? 60,
      maxAttempts: options.maxAttempts ?? 1,
      passPercent: 40,
      negativeMarking: false,
      shuffleQuestions: false,
      shuffleOptions: false,
      answerReveal: 'AFTER_CLOSE',
      ...options.extra,
    },
  );
  expectStatus(created, 201);
  const examId = created.body.data.id;
  const questions: QuestionDto[] = [];
  for (const question of options.questions ?? [mcq(4), multi(3), trueFalse(3)]) {
    const response = await faculty.api<QuestionDto>(
      'POST',
      `/faculty/exams/${examId}/questions`,
      question,
    );
    expectStatus(response, 201);
    questions.push(response.body.data);
  }
  if (options.publish !== false) {
    expectStatus(
      await faculty.api('POST', `/faculty/exams/${examId}/status`, { action: 'publish' }),
      200,
    );
  }
  return { examId, questions };
}

export async function startExam(student: Student, examId: string, status = 201) {
  const response = await student.api<AttemptStartDto>('POST', `/student/exams/${examId}/attempts`);
  expectStatus(response, status);
  return response.body.data;
}

/** Saves one answer (choice ids by option TEXT, matched against the attempt's own options). */
export async function answer(
  student: Student,
  attempt: {
    id: string;
    questions: { id: string; prompt: string; options: { id: string; text: string }[] }[];
  },
  prompt: string,
  texts: string[],
  sequence = 1,
) {
  const question = attempt.questions.find((q) => q.prompt === prompt);
  if (!question) throw new Error(`No question "${prompt}" in attempt`);
  return student.api('PUT', `/student/attempts/${attempt.id}/answers/${question.id}`, {
    selectedOptionIds: optionIdsByText(question, ...texts),
    sequence,
  });
}

export type { Api };
