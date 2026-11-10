import type {
  AdminAcademyQuizDetail,
  QuestionDto,
  StudentAcademyAttemptDto,
  StudentAcademyAttemptStartDto,
} from '@asra/types';
import { prisma } from '../../src/database/prisma.js';
import { at, mcq, plusMinutes, type Student } from './assessment.js';
import { expectStatus, type Api } from './catalog.js';

/** Academy Quiz helpers shared by the HTTP suites (the server clock is pinned with `at()`). */

export const T0 = new Date('2026-12-01T04:30:00.000Z');
export const STARTS = plusMinutes(T0, 60);
export const ENDS = plusMinutes(T0, 180);
export const ADMIN = '/admin/academy-quizzes';
export const STUDENT = '/student/academy-quizzes';
export const ATTEMPTS = '/student/academy-attempts';

export const academyQuestion = (
  marks = 2,
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null = null,
) => ({ ...mcq(marks), difficulty });

/** Creates, fills and publishes a quiz (at T0), then moves the clock to `now`. */
export async function publishedQuiz(
  admin: Api,
  settings: Record<string, unknown> = {},
  questions: object[] = [academyQuestion(), academyQuestion(), academyQuestion()],
  now: Date = plusMinutes(STARTS, 1),
) {
  at(T0);
  const created = await admin<AdminAcademyQuizDetail>('POST', ADMIN, {
    title: `Olympiad ${Math.random().toString(36).slice(2, 8)}`,
    startsAt: STARTS.toISOString(),
    endsAt: ENDS.toISOString(),
    ...('timerMode' in settings ? {} : { durationMinutes: 30 }),
    ...settings,
  });
  expectStatus(created, 201);
  const quiz = created.body.data;
  const added: QuestionDto[] = [];
  for (const body of questions) {
    const response = await admin<QuestionDto>('POST', `${ADMIN}/${quiz.id}/questions`, body);
    expectStatus(response, 201);
    added.push(response.body.data);
  }
  expectStatus(await admin('POST', `${ADMIN}/${quiz.id}/status`, { action: 'publish' }), 200);
  at(now);
  return { ...quiz, questions: added };
}

export async function startAttempt(student: Student, slug: string, status = 201) {
  const response = await student.api<StudentAcademyAttemptStartDto>(
    'POST',
    `${STUDENT}/${slug}/attempts`,
    { acceptedInstructions: true },
  );
  expectStatus(response, status);
  return response.body.data?.attempt;
}

/** The correct (or a wrong) option of an attempt question, read from the snapshot. */
export async function optionOf(attemptQuestionId: string, correct = true) {
  const row = await prisma.attemptQuestion.findUniqueOrThrow({ where: { id: attemptQuestionId } });
  const options = (row.snapshot as { options: { id: string; isCorrect: boolean }[] }).options;
  return options.find((option) => option.isCorrect === correct)!.id;
}

export async function answerQuestion(
  student: Student,
  attemptId: string,
  questionId: string,
  { correct = true, sequence = 1 } = {},
) {
  return student.api('PUT', `${ATTEMPTS}/${attemptId}/answers/${questionId}`, {
    selectedOptionIds: [await optionOf(questionId, correct)],
    sequence,
  });
}

/** Starts at `startAt`, answers `correctCount` questions correctly, submits at `submitAt`. */
export async function takeQuiz(
  student: Student,
  slug: string,
  { correctCount, startAt, submitAt }: { correctCount: number; startAt: Date; submitAt: Date },
) {
  at(startAt);
  const attempt = (await startAttempt(student, slug))!;
  for (const [index, question] of attempt.questions.entries()) {
    expectStatus(
      await answerQuestion(student, attempt.id, question.id, { correct: index < correctCount }),
      200,
    );
  }
  at(submitAt);
  const final = await student.api<StudentAcademyAttemptDto>(
    'POST',
    `${ATTEMPTS}/${attempt.id}/submit`,
  );
  expectStatus(final, 200);
  return final.body.data;
}
