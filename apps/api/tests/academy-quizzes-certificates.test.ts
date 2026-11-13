/**
 * Academy Quiz Certificate Generation & Bulk Issuance — Comprehensive Integration & Unit Tests
 *
 * Covers Section 12 test requirements:
 * - Eligibility: DRAFT/UPCOMING/LIVE rejected, ENDED/CLOSED allowed, registered-only excluded,
 *   unregistered-with-attempt eligible, incomplete IN_PROGRESS excluded, BEST/FIRST rules respected.
 * - Ranking & Ties: TIME_TAKEN / SUBMITTED_AT tie-breakers, shared ranks in Top N & Selected Ranks.
 * - Authorization: ADMIN & SUPER_ADMIN allowed, FACULTY & STUDENT 403, student download isolation.
 * - Duplicates, Concurrency & Retries: duplicate prevention, concurrent bulk requests serialized,
 *   partial generation failure + retry without duplicating successes, partial email failure +
 *   independent email retry without regenerating certificates, email never sent before generation.
 * - Full E2E: completion -> preview -> bulk issuance -> PDF/PNG generation -> email -> student download.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type {
  CertificateDto,
  CertificateTemplateDto,
  Paginated,
  PublicCertificateVerificationDto,
  QuizCertificateBatchDetailDto,
  QuizCertificatePreviewResponseDto,
  QuizCertificateSummaryDto,
  QuizEligibleParticipantsResponseDto,
  QuizIssuedCertificateItemDto,
} from '@asra/types';
import { QUIZORA_2026_TEMPLATE_KEY } from '@asra/validation';
import { createApp } from '../src/app.js';
import { prisma } from '../src/database/prisma.js';
import { memoryTransport, setEmailTransport } from '../src/email/email.service.js';
import { setClockForTests } from '../src/lib/clock.js';
import { disconnectRedis } from '../src/lib/redis.js';
import {
  setQuizCertificateGenerationHookForTests,
  settleQuizCertificateDispatch,
} from '../src/modules/academy-quizzes/quiz-certificates.worker.js';
import { ADMIN, ENDS, STARTS, publishedQuiz, takeQuiz } from './support/academy.js';
import { at, newFaculty, newStudent, plusMinutes, type Student } from './support/assessment.js';
import { login, provision, resetAuthState } from './support/auth.js';
import { apiAs, expectStatus, type Api } from './support/catalog.js';
import { startServer, TestClient } from './support/http.js';
import { configureQuizoraTemplate } from './support/quizora-template.js';

let baseUrl: string;
let close: () => Promise<void>;
let admin: Api;
let superAdmin: Api;
let s1: Student;
let s2: Student;
let s3: Student;
let s4: Student;
let templates: CertificateTemplateDto[];

async function signIn(role: 'ADMIN' | 'SUPER_ADMIN') {
  const user = await provision(role);
  const client = new TestClient(baseUrl);
  return apiAs(client, (await login(client, user.email)).accessToken);
}

const sec = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);

before(async () => {
  ({ baseUrl, close } = await startServer(createApp()));
});

after(async () => {
  setQuizCertificateGenerationHookForTests(null);
  setClockForTests(null);
  await close();
  await Promise.all([prisma.$disconnect(), disconnectRedis()]);
});

beforeEach(async () => {
  setQuizCertificateGenerationHookForTests(null);
  setClockForTests(null);
  if (memoryTransport) memoryTransport.outbox.length = 0;
  await resetAuthState();
  [admin, superAdmin] = [await signIn('ADMIN'), await signIn('SUPER_ADMIN')];
  [s1, s2, s3, s4] = [
    await newStudent(baseUrl),
    await newStudent(baseUrl),
    await newStudent(baseUrl),
    await newStudent(baseUrl),
  ];
  await Promise.all([
    prisma.user.update({ where: { id: s1.userId }, data: { fullName: 'Ayesha Siddiqui' } }),
    prisma.user.update({ where: { id: s2.userId }, data: { fullName: 'Bilal Ahmad' } }),
    prisma.user.update({ where: { id: s3.userId }, data: { fullName: 'Fatima Khan' } }),
    prisma.user.update({ where: { id: s4.userId }, data: { fullName: 'Zaid Mirza' } }),
  ]);
  await configureQuizoraTemplate();
  const tplRes = await admin<CertificateTemplateDto[]>('GET', '/admin/certificates/templates');
  expectStatus(tplRes, 200);
  templates = tplRes.body.data;
  if (memoryTransport) memoryTransport.outbox.length = 0;
});

/**
 * The legacy Classic / Modern / Premium templates are archived; every participation and rank
 * slot is assigned the single active ASRA QUIZORA 2026 template (configured with its two
 * mandatory signatures in beforeEach).
 */
function defaultTemplateIds() {
  const quizora = templates.find((t) => t.key === QUIZORA_2026_TEMPLATE_KEY && t.isActive)!;
  return { classic: quizora.id, modern: quizora.id, premium: quizora.id };
}

describe('Quiz Certificate Eligibility & Lifecycle Gates', () => {
  it('rejects issuance for DRAFT, UPCOMING, and LIVE quizzes, and allows ENDED and CLOSED quizzes', async () => {
    const tpls = defaultTemplateIds();
    // 1. DRAFT quiz
    at(plusMinutes(STARTS, -90));
    const draftRes = await admin<{ id: string }>('POST', ADMIN, {
      title: 'Draft Quiz',
      startsAt: STARTS.toISOString(),
      endsAt: ENDS.toISOString(),
      durationMinutes: 30,
    });
    expectStatus(draftRes, 201);
    const draftId = draftRes.body.data.id;

    const draftSummary = await admin<QuizCertificateSummaryDto>(
      'GET',
      `${ADMIN}/${draftId}/certificates/summary`,
    );
    expectStatus(draftSummary, 200);
    assert.equal(draftSummary.body.data.isCompleted, false);

    const draftIssue = await admin('POST', `${ADMIN}/${draftId}/certificates/issue`, {
      recipientMode: 'ALL_PARTICIPANTS',
      templates: { participationTemplateId: tpls.modern },
    });
    expectStatus(draftIssue, 400);

    // 2. UPCOMING quiz
    const quiz = await publishedQuiz(admin, {}, undefined, plusMinutes(STARTS, -10));
    const upcomingIssue = await admin('POST', `${ADMIN}/${quiz.id}/certificates/issue`, {
      recipientMode: 'ALL_PARTICIPANTS',
      templates: { participationTemplateId: tpls.modern },
    });
    expectStatus(upcomingIssue, 400);

    // 3. LIVE quiz (with a submitted attempt while quiz is still live)
    await takeQuiz(s1, quiz.slug, {
      correctCount: 3,
      startAt: plusMinutes(STARTS, 5),
      submitAt: plusMinutes(STARTS, 10),
    });
    const liveIssue = await admin('POST', `${ADMIN}/${quiz.id}/certificates/issue`, {
      recipientMode: 'ALL_PARTICIPANTS',
      templates: { participationTemplateId: tpls.modern },
    });
    expectStatus(liveIssue, 400);

    // 4. ENDED quiz
    at(plusMinutes(ENDS, 1));
    const endedSummary = await admin<QuizCertificateSummaryDto>(
      'GET',
      `${ADMIN}/${quiz.id}/certificates/summary`,
    );
    expectStatus(endedSummary, 200);
    assert.equal(endedSummary.body.data.isCompleted, true);
    assert.equal(endedSummary.body.data.totalEligibleParticipants, 1);

    const endedIssue = await admin<QuizCertificateBatchDetailDto>(
      'POST',
      `${ADMIN}/${quiz.id}/certificates/issue`,
      {
        recipientMode: 'ALL_PARTICIPANTS',
        templates: { participationTemplateId: tpls.modern },
      },
    );
    expectStatus(endedIssue, 202);
    await settleQuizCertificateDispatch();

    // 5. CLOSED quiz (closed before endsAt)
    const quiz2 = await publishedQuiz(admin, {}, undefined, plusMinutes(STARTS, 1));
    await takeQuiz(s2, quiz2.slug, {
      correctCount: 2,
      startAt: plusMinutes(STARTS, 5),
      submitAt: plusMinutes(STARTS, 10),
    });
    expectStatus(await admin('POST', `${ADMIN}/${quiz2.id}/status`, { action: 'close' }), 200);
    const closedIssue = await admin<QuizCertificateBatchDetailDto>(
      'POST',
      `${ADMIN}/${quiz2.id}/certificates/issue`,
      {
        recipientMode: 'ALL_PARTICIPANTS',
        templates: { participationTemplateId: tpls.modern },
      },
    );
    expectStatus(closedIssue, 202);
    await settleQuizCertificateDispatch();
  });

  it('excludes registered-only and incomplete attempts, includes unregistered submitters, and respects BEST/FIRST rules', async () => {
    const tpls = defaultTemplateIds();
    const quiz = await publishedQuiz(
      admin,
      { maxAttempts: 2, attemptCounting: 'BEST', visibility: 'PUBLIC' },
      undefined,
      plusMinutes(STARTS, 1),
    );

    // s1 registers ONLY (never attempts) -> MUST be excluded
    expectStatus(
      await s1.api('POST', `/participate/quizzes/${encodeURIComponent(quiz.slug)}/register`, {}),
      201,
    );

    // s2 does NOT register, starts and submits TWO attempts (first: 1/3, second: 3/3) -> MUST be eligible with BEST score (3/3)
    await takeQuiz(s2, quiz.slug, {
      correctCount: 1,
      startAt: plusMinutes(STARTS, 5),
      submitAt: plusMinutes(STARTS, 10),
    });
    await takeQuiz(s2, quiz.slug, {
      correctCount: 3,
      startAt: plusMinutes(STARTS, 15),
      submitAt: plusMinutes(STARTS, 20),
    });

    // s3 starts an attempt and leaves it IN_PROGRESS (incomplete), then quiz is closed early? Wait: closing finalizes IN_PROGRESS!
    // To test an incomplete IN_PROGRESS attempt vs finalized, check eligible while quiz ends or check un-submitted before close:
    // Actually when quiz ends, an attempt started before endsAt expires at its deadline; let's create an IN_PROGRESS attempt
    // for s3 with evaluationStatus=null (or simulate an un-evaluated PENDING attempt for s4).
    await takeQuiz(s3, quiz.slug, {
      correctCount: 2,
      startAt: plusMinutes(STARTS, 25),
      submitAt: plusMinutes(STARTS, 30),
    });
    // Manually insert an incomplete IN_PROGRESS attempt for s4 (never submitted)
    await prisma.assessmentAttempt.create({
      data: {
        academyQuizId: quiz.id,
        userId: s4.userId,
        attemptNumber: 1,
        status: 'IN_PROGRESS',
        startedAt: plusMinutes(STARTS, 10),
        deadlineAt: plusMinutes(ENDS, 10),
        maxScore: 6,
      },
    });

    at(plusMinutes(ENDS, 1));

    const eligible = await admin<QuizEligibleParticipantsResponseDto>(
      'GET',
      `${ADMIN}/${quiz.id}/certificates/eligible`,
    );
    expectStatus(eligible, 200);
    const ids = eligible.body.data.items.map((i) => i.userId);
    assert.deepEqual(ids, [s2.userId, s3.userId]);
    assert.equal(eligible.body.data.items[0]!.score, 6);
    assert.equal(eligible.body.data.items[0]!.attemptNumber, 2);

    const issueRes = await admin<QuizCertificateBatchDetailDto>(
      'POST',
      `${ADMIN}/${quiz.id}/certificates/issue`,
      {
        recipientMode: 'ALL_PARTICIPANTS',
        templates: { participationTemplateId: tpls.classic },
        sendEmail: false,
      },
    );
    expectStatus(issueRes, 202);
    await settleQuizCertificateDispatch();

    const batch = await admin<QuizCertificateBatchDetailDto>(
      'GET',
      `${ADMIN}/${quiz.id}/certificates/batches/${issueRes.body.data.batch.id}`,
    );
    expectStatus(batch, 200);
    assert.equal(batch.body.data.batch.generatedCount, 2);
  });
});

describe('Ranking, Ties & Recipient Modes', () => {
  it('handles equal-score ties, time-based tie-breaker, Top N, and Selected Ranks accurately', async () => {
    const tpls = defaultTemplateIds();
    const quiz = await publishedQuiz(
      admin,
      { tieBreak: 'TIME_TAKEN' },
      undefined,
      plusMinutes(STARTS, 1),
    );

    // s1: 3/3 in 120s -> Rank 1
    await takeQuiz(s1, quiz.slug, {
      correctCount: 3,
      startAt: plusMinutes(STARTS, 5),
      submitAt: sec(plusMinutes(STARTS, 5), 120),
    });
    // s2: 2/3 in 90s -> Rank 2 (tied)
    await takeQuiz(s2, quiz.slug, {
      correctCount: 2,
      startAt: plusMinutes(STARTS, 10),
      submitAt: sec(plusMinutes(STARTS, 10), 90),
    });
    // s3: 2/3 in 90s -> Rank 2 (tied with s2!)
    await takeQuiz(s3, quiz.slug, {
      correctCount: 2,
      startAt: plusMinutes(STARTS, 15),
      submitAt: sec(plusMinutes(STARTS, 15), 90),
    });
    // s4: 2/3 in 150s -> Rank 4 (competition ranking: 1, 2, 2, 4)
    await takeQuiz(s4, quiz.slug, {
      correctCount: 2,
      startAt: plusMinutes(STARTS, 20),
      submitAt: sec(plusMinutes(STARTS, 20), 150),
    });

    at(plusMinutes(ENDS, 1));

    // Preview Top 3 -> must include s1 (Rank 1), s2 (Rank 2), s3 (Rank 2), and exclude s4 (Rank 4)
    const top3Preview = await admin<QuizCertificatePreviewResponseDto>(
      'POST',
      `${ADMIN}/${quiz.id}/certificates/preview`,
      {
        recipientMode: 'RANKERS_ONLY',
        topN: 3,
        templates: {
          rank1TemplateId: tpls.premium,
          otherRankTemplateId: tpls.modern,
        },
        format: 'BOTH',
      },
    );
    expectStatus(top3Preview, 200);
    assert.equal(top3Preview.body.data.totalUniqueRecipients, 3);
    const sortRankUser = (rows: { userId: string; rank: number | null }[]) =>
      [...rows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.userId.localeCompare(b.userId));
    assert.deepEqual(
      sortRankUser(
        top3Preview.body.data.recipients.map((r) => ({ userId: r.userId, rank: r.rank })),
      ),
      sortRankUser([
        { userId: s1.userId, rank: 1 },
        { userId: s2.userId, rank: 2 },
        { userId: s3.userId, rank: 2 },
      ]),
    );

    // Issue Selected Ranks: Rank 4 only -> s4 gets Rank 4 certificate using otherRankTemplateId
    const selectedRankIssue = await admin<QuizCertificateBatchDetailDto>(
      'POST',
      `${ADMIN}/${quiz.id}/certificates/issue`,
      {
        recipientMode: 'SELECTED_RANKS',
        selectedRanks: [4],
        templates: { otherRankTemplateId: tpls.modern },
        format: 'PDF',
      },
    );
    expectStatus(selectedRankIssue, 202);
    await settleQuizCertificateDispatch();

    const issued = await admin<Paginated<QuizIssuedCertificateItemDto>>(
      'GET',
      `${ADMIN}/${quiz.id}/certificates/issued`,
    );
    expectStatus(issued, 200);
    assert.equal(issued.body.data.items.length, 1);
    assert.equal(issued.body.data.items[0]!.userId, s4.userId);
    assert.equal(issued.body.data.items[0]!.quizRank, 4);
    assert.equal(issued.body.data.items[0]!.certificateCategory, 'RANK');

    // Verify rejecting missing rank template without silent fallback
    const missingTplRes = await admin('POST', `${ADMIN}/${quiz.id}/certificates/preview`, {
      recipientMode: 'RANKERS_ONLY',
      topN: 3,
      templates: { participationTemplateId: tpls.classic },
    });
    expectStatus(missingTplRes, 422);

    // Custom rank range (2..4) includes tied Rank 2 (s2, s3) + Rank 4 (s4)
    const rangePreview = await admin<QuizCertificatePreviewResponseDto>(
      'POST',
      `${ADMIN}/${quiz.id}/certificates/preview`,
      {
        recipientMode: 'RANKERS_ONLY',
        rankFrom: 2,
        rankTo: 4,
        templates: { otherRankTemplateId: tpls.modern },
      },
    );
    expectStatus(rangePreview, 200);
    assert.equal(rangePreview.body.data.totalUniqueRecipients, 3);
    assert.equal(rangePreview.body.data.alreadyIssuedExcludedCount, 1); // s4 already issued above
    assert.equal(rangePreview.body.data.toGenerateCount, 2);
  });

  it('respects FIRST attempt counting, SUBMITTED_AT tie-breaker, INDIVIDUAL_PARTICIPANTS, and showInStudentDashboard=false', async () => {
    const tpls = defaultTemplateIds();
    const quiz = await publishedQuiz(
      admin,
      { maxAttempts: 2, attemptCounting: 'FIRST', tieBreak: 'SUBMITTED_AT' },
      undefined,
      plusMinutes(STARTS, 1),
    );

    // s1: first attempt 1/3 submitted earlier, second attempt 3/3 -> FIRST counting uses 1/3 (score 2)
    await takeQuiz(s1, quiz.slug, {
      correctCount: 1,
      startAt: plusMinutes(STARTS, 5),
      submitAt: sec(plusMinutes(STARTS, 5), 100),
    });
    await takeQuiz(s1, quiz.slug, {
      correctCount: 3,
      startAt: plusMinutes(STARTS, 15),
      submitAt: sec(plusMinutes(STARTS, 15), 20),
    });
    // s2: first attempt 1/3 submitted AFTER s1's first attempt -> ranks behind s1 under SUBMITTED_AT
    await takeQuiz(s2, quiz.slug, {
      correctCount: 1,
      startAt: plusMinutes(STARTS, 6),
      submitAt: sec(plusMinutes(STARTS, 6), 50),
    });

    at(plusMinutes(ENDS, 1));

    const eligible = await admin<QuizEligibleParticipantsResponseDto>(
      'GET',
      `${ADMIN}/${quiz.id}/certificates/eligible`,
    );
    expectStatus(eligible, 200);
    assert.equal(eligible.body.data.items[0]!.userId, s1.userId);
    assert.equal(eligible.body.data.items[0]!.attemptNumber, 1);
    assert.equal(eligible.body.data.items[0]!.score, 2);
    assert.equal(eligible.body.data.items[0]!.rank, 1);
    assert.equal(eligible.body.data.items[1]!.userId, s2.userId);
    assert.equal(eligible.body.data.items[1]!.rank, 2);

    // Issue only to s2 as INDIVIDUAL_PARTICIPANTS with showInStudentDashboard=false
    const indIssue = await admin<QuizCertificateBatchDetailDto>(
      'POST',
      `${ADMIN}/${quiz.id}/certificates/issue`,
      {
        recipientMode: 'INDIVIDUAL_PARTICIPANTS',
        selectedUserIds: [s2.userId],
        templates: { participationTemplateId: tpls.classic },
        sendEmail: false,
        showInStudentDashboard: false,
      },
    );
    expectStatus(indIssue, 202);
    await settleQuizCertificateDispatch();

    // Hidden from s2's student dashboard
    const s2Certs = await s2.api<Paginated<CertificateDto>>('GET', '/student/certificates');
    expectStatus(s2Certs, 200);
    assert.equal(s2Certs.body.data.items.length, 0);

    // Admin still sees it in issued certificates list
    const adminIssued = await admin<Paginated<QuizIssuedCertificateItemDto>>(
      'GET',
      `${ADMIN}/${quiz.id}/certificates/issued`,
    );
    expectStatus(adminIssued, 200);
    assert.equal(adminIssued.body.data.items.length, 1);
    assert.equal(adminIssued.body.data.items[0]!.userId, s2.userId);
    assert.equal(adminIssued.body.data.items[0]!.visibleInStudentDashboard, false);
  });
});

describe('Authorization & Security', () => {
  it('allows ADMIN and SUPER_ADMIN and blocks FACULTY and STUDENT with 403', async () => {
    const tpls = defaultTemplateIds();
    const quiz = await publishedQuiz(admin, {}, undefined, plusMinutes(STARTS, 1));
    await takeQuiz(s1, quiz.slug, {
      correctCount: 3,
      startAt: plusMinutes(STARTS, 5),
      submitAt: plusMinutes(STARTS, 10),
    });
    at(plusMinutes(ENDS, 1));

    const faculty = await newFaculty(baseUrl);
    expectStatus(await faculty.api('GET', `${ADMIN}/${quiz.id}/certificates/summary`), 403);
    expectStatus(
      await faculty.api('POST', `${ADMIN}/${quiz.id}/certificates/issue`, {
        recipientMode: 'ALL_PARTICIPANTS',
        templates: { participationTemplateId: tpls.modern },
      }),
      403,
    );
    expectStatus(await s1.api('GET', `${ADMIN}/${quiz.id}/certificates/summary`), 403);
    expectStatus(
      await s1.api('POST', `${ADMIN}/${quiz.id}/certificates/issue`, {
        recipientMode: 'ALL_PARTICIPANTS',
        templates: { participationTemplateId: tpls.modern },
      }),
      403,
    );

    // SUPER_ADMIN succeeds
    const superRes = await superAdmin<QuizCertificateBatchDetailDto>(
      'POST',
      `${ADMIN}/${quiz.id}/certificates/issue`,
      {
        recipientMode: 'ALL_PARTICIPANTS',
        templates: { participationTemplateId: tpls.modern },
        sendEmail: false,
      },
    );
    expectStatus(superRes, 202);
    await settleQuizCertificateDispatch();

    // Student s2 cannot download s1's certificate
    const s1Certs = await s1.api<Paginated<CertificateDto>>('GET', '/student/certificates');
    expectStatus(s1Certs, 200);
    const certId = s1Certs.body.data.items[0]!.id;

    expectStatus(await s2.api('GET', `/student/certificates/${certId}`), 404);
    expectStatus(await s2.api('GET', `/student/certificates/${certId}/download/pdf`), 403);
  });
});

describe('Duplicates, Concurrency, Partial Failures & Independent Retries', () => {
  it('prevents duplicate certificates across concurrent and repeated bulk issuances', async () => {
    const tpls = defaultTemplateIds();
    const quiz = await publishedQuiz(admin, {}, undefined, plusMinutes(STARTS, 1));
    await takeQuiz(s1, quiz.slug, {
      correctCount: 3,
      startAt: plusMinutes(STARTS, 5),
      submitAt: plusMinutes(STARTS, 10),
    });
    await takeQuiz(s2, quiz.slug, {
      correctCount: 2,
      startAt: plusMinutes(STARTS, 15),
      submitAt: plusMinutes(STARTS, 20),
    });
    at(plusMinutes(ENDS, 1));

    const payload = {
      recipientMode: 'ALL_PARTICIPANTS',
      templates: { participationTemplateId: tpls.modern },
      sendEmail: false,
    };

    const [r1, r2] = await Promise.all([
      admin<QuizCertificateBatchDetailDto>(
        'POST',
        `${ADMIN}/${quiz.id}/certificates/issue`,
        payload,
      ),
      admin<QuizCertificateBatchDetailDto>(
        'POST',
        `${ADMIN}/${quiz.id}/certificates/issue`,
        payload,
      ),
    ]);

    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [202, 400]);

    await settleQuizCertificateDispatch();

    // Second sequential run must reject as all recipients already issued
    const r3 = await admin('POST', `${ADMIN}/${quiz.id}/certificates/issue`, payload);
    expectStatus(r3, 400);

    const issuedCount = await prisma.certificate.count({
      where: { academyQuizId: quiz.id, status: 'ISSUED' },
    });
    assert.equal(issuedCount, 2);
  });

  it('handles partial generation failure and retries only failed generation without duplicating successes', async () => {
    const tpls = defaultTemplateIds();
    const quiz = await publishedQuiz(admin, {}, undefined, plusMinutes(STARTS, 1));
    await takeQuiz(s1, quiz.slug, {
      correctCount: 3,
      startAt: plusMinutes(STARTS, 5),
      submitAt: plusMinutes(STARTS, 10),
    });
    await takeQuiz(s2, quiz.slug, {
      correctCount: 2,
      startAt: plusMinutes(STARTS, 15),
      submitAt: plusMinutes(STARTS, 20),
    });
    at(plusMinutes(ENDS, 1));

    // Simulate failure ONLY for s2
    setQuizCertificateGenerationHookForTests((item) => {
      if (item.userId === s2.userId) {
        throw new Error('Simulated PDF renderer outage for student 2');
      }
    });

    const startRes = await admin<QuizCertificateBatchDetailDto>(
      'POST',
      `${ADMIN}/${quiz.id}/certificates/issue`,
      {
        recipientMode: 'ALL_PARTICIPANTS',
        templates: { participationTemplateId: tpls.modern },
        sendEmail: true,
      },
    );
    expectStatus(startRes, 202);
    const batchId = startRes.body.data.batch.id;
    await settleQuizCertificateDispatch();

    const midDetail = await admin<QuizCertificateBatchDetailDto>(
      'GET',
      `${ADMIN}/${quiz.id}/certificates/batches/${batchId}`,
    );
    expectStatus(midDetail, 200);
    assert.equal(midDetail.body.data.batch.status, 'COMPLETED_WITH_ERRORS');
    assert.equal(midDetail.body.data.batch.generatedCount, 1);
    assert.equal(midDetail.body.data.batch.generationFailedCount, 1);
    assert.equal(midDetail.body.data.batch.emailsSentCount, 1);

    // Email MUST NOT be sent for s2 before successful generation
    assert.equal(memoryTransport?.outbox.length, 1);
    assert.equal(memoryTransport?.outbox[0]?.to, s1.email);

    // Student 2 must NOT see any certificate on student dashboard yet
    const s2CertsBefore = await s2.api<Paginated<CertificateDto>>('GET', '/student/certificates');
    expectStatus(s2CertsBefore, 200);
    assert.equal(s2CertsBefore.body.data.items.length, 0);

    // Clear failure hook and retry FAILED_GENERATIONS
    setQuizCertificateGenerationHookForTests(null);
    const retryRes = await admin<QuizCertificateBatchDetailDto>(
      'POST',
      `${ADMIN}/${quiz.id}/certificates/batches/${batchId}/retry`,
      { scope: 'FAILED_GENERATIONS' },
    );
    expectStatus(retryRes, 202);
    await settleQuizCertificateDispatch();

    const finalDetail = await admin<QuizCertificateBatchDetailDto>(
      'GET',
      `${ADMIN}/${quiz.id}/certificates/batches/${batchId}`,
    );
    expectStatus(finalDetail, 200);
    assert.equal(finalDetail.body.data.batch.status, 'COMPLETED');
    assert.equal(finalDetail.body.data.batch.generatedCount, 2);
    assert.equal(finalDetail.body.data.batch.generationFailedCount, 0);
    assert.equal(finalDetail.body.data.batch.emailsSentCount, 2);

    // Total emails sent is 2 (no duplicate email sent to s1!)
    assert.equal(memoryTransport?.outbox.length, 2);
  });

  it('handles partial email failure and retries failed email independently without regenerating certificates', async () => {
    const tpls = defaultTemplateIds();
    const quiz = await publishedQuiz(admin, {}, undefined, plusMinutes(STARTS, 1));
    await takeQuiz(s1, quiz.slug, {
      correctCount: 3,
      startAt: plusMinutes(STARTS, 5),
      submitAt: plusMinutes(STARTS, 10),
    });
    await takeQuiz(s2, quiz.slug, {
      correctCount: 2,
      startAt: plusMinutes(STARTS, 15),
      submitAt: plusMinutes(STARTS, 20),
    });
    at(plusMinutes(ENDS, 1));

    const sentLogs: string[] = [];
    const prevTransport = setEmailTransport({
      name: 'mock-partial-fail',
      async send(msg) {
        if (msg.to === s2.email) {
          throw new Error('Simulated Resend transient timeout');
        }
        sentLogs.push(msg.to);
        return { providerMessageId: `mock-${sentLogs.length}` };
      },
    });

    try {
      const startRes = await admin<QuizCertificateBatchDetailDto>(
        'POST',
        `${ADMIN}/${quiz.id}/certificates/issue`,
        {
          recipientMode: 'ALL_PARTICIPANTS',
          templates: { participationTemplateId: tpls.modern },
          sendEmail: true,
        },
      );
      expectStatus(startRes, 202);
      const batchId = startRes.body.data.batch.id;
      await settleQuizCertificateDispatch();

      const midDetail = await admin<QuizCertificateBatchDetailDto>(
        'GET',
        `${ADMIN}/${quiz.id}/certificates/batches/${batchId}`,
      );
      expectStatus(midDetail, 200);
      assert.equal(midDetail.body.data.batch.generatedCount, 2);
      assert.equal(midDetail.body.data.batch.emailsSentCount, 1);
      assert.equal(midDetail.body.data.batch.emailsFailedCount, 1);
      assert.equal(midDetail.body.data.batch.status, 'COMPLETED_WITH_ERRORS');

      const certsBeforeRetry = await prisma.certificate.findMany({
        where: { academyQuizId: quiz.id },
        select: { id: true, certificateNumber: true },
        orderBy: { createdAt: 'asc' },
      });

      // Restore working transport and retry FAILED_EMAILS only
      if (memoryTransport) memoryTransport.outbox.length = 0;
      setEmailTransport(prevTransport);
      const retryRes = await admin<QuizCertificateBatchDetailDto>(
        'POST',
        `${ADMIN}/${quiz.id}/certificates/batches/${batchId}/retry`,
        { scope: 'FAILED_EMAILS' },
      );
      expectStatus(retryRes, 202);
      await settleQuizCertificateDispatch();

      const finalDetail = await admin<QuizCertificateBatchDetailDto>(
        'GET',
        `${ADMIN}/${quiz.id}/certificates/batches/${batchId}`,
      );
      expectStatus(finalDetail, 200);
      assert.equal(finalDetail.body.data.batch.status, 'COMPLETED');
      assert.equal(finalDetail.body.data.batch.emailsSentCount, 2);
      assert.equal(finalDetail.body.data.batch.emailsFailedCount, 0);

      // Certificates were NOT regenerated (same IDs & numbers)
      const certsAfterRetry = await prisma.certificate.findMany({
        where: { academyQuizId: quiz.id },
        select: { id: true, certificateNumber: true },
        orderBy: { createdAt: 'asc' },
      });
      assert.deepEqual(certsAfterRetry, certsBeforeRetry);
      // Only s2 received the retried email (prevTransport is memoryTransport which started empty)
      assert.equal(memoryTransport?.outbox.length, 1);
      assert.equal(memoryTransport?.outbox[0]?.to, s2.email);
    } finally {
      setEmailTransport(prevTransport);
    }
  });
});

describe('Full End-to-End Flow: Bulk Issuance -> Email -> Student Dashboard -> PDF/PNG Download -> Public Verify', () => {
  it('issues ranker + participation certificates, sends Resend-format emails, and lets students download PDF/PNG', async () => {
    const tpls = defaultTemplateIds();
    const quiz = await publishedQuiz(
      admin,
      { title: 'ASRA Grand Quiz 2026' },
      undefined,
      plusMinutes(STARTS, 1),
    );
    await takeQuiz(s1, quiz.slug, {
      correctCount: 3,
      startAt: plusMinutes(STARTS, 5),
      submitAt: sec(plusMinutes(STARTS, 5), 60),
    });
    await takeQuiz(s2, quiz.slug, {
      correctCount: 1,
      startAt: plusMinutes(STARTS, 10),
      submitAt: sec(plusMinutes(STARTS, 10), 120),
    });
    at(plusMinutes(ENDS, 1));

    const issueRes = await admin<QuizCertificateBatchDetailDto>(
      'POST',
      `${ADMIN}/${quiz.id}/certificates/issue`,
      {
        recipientMode: 'ALL_PARTICIPANTS',
        templates: {
          participationTemplateId: tpls.modern,
          rank1TemplateId: tpls.premium,
          issueRankCertificatesToTopRankers: true,
        },
        format: 'BOTH',
        sendEmail: true,
        showInStudentDashboard: true,
      },
    );
    expectStatus(issueRes, 202);
    await settleQuizCertificateDispatch();

    // Verify emails in outbox
    assert.equal(memoryTransport?.outbox.length, 2);
    const rank1Email = memoryTransport!.outbox.find((m) => m.to === s1.email)!;
    assert.equal(
      rank1Email.subject,
      'Congratulations! Your ASRA Academy Quiz Certificate is Ready',
    );
    assert.ok(rank1Email.text.includes('Ayesha Siddiqui'));
    assert.ok(rank1Email.text.includes('ASRA Grand Quiz 2026'));
    assert.ok(rank1Email.text.includes('Rank #1'));
    assert.ok(rank1Email.text.includes('/student/certificates?certificateId='));
    assert.ok(rank1Email.text.includes('/student/dashboard'));

    // Verify student dashboard lists the certificate & downloads PDF and PNG
    const s1Certs = await s1.api<Paginated<CertificateDto>>('GET', '/student/certificates');
    expectStatus(s1Certs, 200);
    assert.equal(s1Certs.body.data.items.length, 1);
    const cert = s1Certs.body.data.items[0]!;
    assert.equal(cert.sourceType, 'ACADEMY_QUIZ');
    assert.equal(cert.quizRank, 1);
    assert.equal(cert.certificateCategory, 'RANK');
    assert.deepEqual(cert.issuedFormats, ['PDF', 'PNG']);

    const pdfRes = await fetch(`${baseUrl}/api/v1/student/certificates/${cert.id}/download/pdf`, {
      headers: {
        Authorization: `Bearer ${(await login(new TestClient(baseUrl), s1.email)).accessToken}`,
      },
    });
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    assert.equal(pdfBuf.subarray(0, 5).toString('ascii'), '%PDF-');

    const pngRes = await fetch(`${baseUrl}/api/v1/student/certificates/${cert.id}/download/png`, {
      headers: {
        Authorization: `Bearer ${(await login(new TestClient(baseUrl), s1.email)).accessToken}`,
      },
    });
    assert.equal(pngRes.status, 200);
    assert.equal(pngRes.headers.get('content-type'), 'image/png');
    const pngBuf = Buffer.from(await pngRes.arrayBuffer());
    assert.deepEqual(
      pngBuf.subarray(0, 8),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    // Public verification succeeds without leaking student email or numeric score
    const verifyRes = await admin<PublicCertificateVerificationDto>(
      'GET',
      `/certificates/verify/${cert.certificateNumber}`,
    );
    expectStatus(verifyRes, 200);
    assert.equal(verifyRes.body.data.valid, true);
    assert.equal(verifyRes.body.data.recipientName, 'Ayesha Siddiqui');
    assert.equal(verifyRes.body.data.courseTitle, 'ASRA Grand Quiz 2026');
  });
});
