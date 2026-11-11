/**
 * PHASE 13 — Certificate System Acceptance & Integration Tests
 * Real HTTP endpoints, real database, real PDFKit buffer generation, real auth & RBAC.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type {
  AdminCertificateListItem,
  CertificateDto,
  CertificateEligibilityResult,
  Paginated,
  PublicCertificateVerificationDto,
} from '@asra/types';
import { createApp } from '../src/app.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { disconnectRedis } from '../src/lib/redis.js';
import { login, registerVerifiedStudent, resetAuthState } from './support/auth.js';
import { apiAs, tokenFor } from './support/catalog.js';
import { uniqueSuffix } from './support/fixtures.js';
import { startServer, TestClient } from './support/http.js';

let baseUrl: string;
let close: () => Promise<void>;

before(async () => {
  ({ baseUrl, close } = await startServer(createApp()));
});

after(async () => {
  await close();
  await Promise.all([disconnectPrisma(), disconnectRedis()]);
});

beforeEach(async () => {
  await resetAuthState();
});

async function newStudent(fullName = 'Amina Al-Mansoor') {
  const client = new TestClient(baseUrl);
  const email = await registerVerifiedStudent(client);
  if (fullName !== 'Test Student') {
    await prisma.user.update({ where: { email }, data: { fullName } });
  }
  const session = await login(client, email);
  return {
    client,
    api: apiAs(client, session.accessToken),
    token: session.accessToken,
    userId: session.user.id,
    email,
    fullName,
  };
}

/**
 * Creates a published course with one module, chapter, and published text lesson.
 */
async function createCompletedCourseForStudent(
  studentUserId: string,
  title = 'Tajweed Fundamentals',
) {
  const s = uniqueSuffix();
  const now = new Date();
  const course = await prisma.course.create({
    data: {
      title,
      slug: `course-${s}`,
      status: 'PUBLISHED',
      publishedAt: now,
      visibility: 'PUBLIC',
      modules: {
        create: {
          title: 'Module 1',
          position: 0,
          chapters: {
            create: {
              title: 'Chapter 1',
              position: 0,
              lessons: {
                create: {
                  title: 'Lesson 1',
                  contentType: 'TEXT',
                  position: 0,
                  status: 'PUBLISHED',
                  publishedAt: now,
                  body: 'Welcome to Tajweed.',
                },
              },
            },
          },
        },
      },
    },
    include: {
      modules: {
        include: {
          chapters: {
            include: {
              lessons: true,
            },
          },
        },
      },
    },
  });

  const lesson = course.modules[0]!.chapters[0]!.lessons[0]!;

  // Create enrollment
  const enrollment = await prisma.enrollment.create({
    data: {
      userId: studentUserId,
      courseId: course.id,
      status: 'ACTIVE',
      source: 'ADMIN',
    },
  });

  // Complete lesson
  await prisma.lessonProgress.create({
    data: {
      userId: studentUserId,
      lessonId: lesson.id,
      completedAt: now,
    },
  });

  // Mark enrollment completed
  await prisma.enrollment.update({
    where: { id: enrollment.id },
    data: { completedAt: now },
  });

  return { course, lesson, enrollment, completedAt: now };
}

describe('PHASE 13 — Certificate System', () => {
  describe('Eligibility Engine', () => {
    it('returns INELIGIBLE with NOT_ENROLLED when student is not enrolled', async () => {
      const student = await newStudent();
      const s = uniqueSuffix();
      const course = await prisma.course.create({
        data: {
          title: `Course ${s}`,
          slug: `course-${s}`,
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      });

      const res = await student.client.request<CertificateEligibilityResult>(
        'GET',
        `/student/courses/${course.id}/certificate/eligibility`,
        { token: student.token },
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.data.eligible, false);
      assert.equal(res.body.data.state, 'INELIGIBLE');
      assert.equal(res.body.data.reasons[0]?.code, 'NOT_ENROLLED');
    });

    it('returns INELIGIBLE with PROGRESS_INCOMPLETE when lessons are not done', async () => {
      const student = await newStudent();
      const s = uniqueSuffix();
      const now = new Date();
      const course = await prisma.course.create({
        data: {
          title: `Course ${s}`,
          slug: `course-${s}`,
          status: 'PUBLISHED',
          publishedAt: now,
          modules: {
            create: {
              title: 'Module 1',
              position: 0,
              chapters: {
                create: {
                  title: 'Chapter 1',
                  position: 0,
                  lessons: {
                    create: {
                      title: 'Lesson 1',
                      contentType: 'TEXT',
                      position: 0,
                      status: 'PUBLISHED',
                      publishedAt: now,
                      body: 'Test',
                    },
                  },
                },
              },
            },
          },
        },
      });

      await prisma.enrollment.create({
        data: {
          userId: student.userId,
          courseId: course.id,
          status: 'ACTIVE',
          source: 'FREE',
        },
      });

      const res = await student.client.request<CertificateEligibilityResult>(
        'GET',
        `/student/courses/${course.id}/certificate/eligibility`,
        { token: student.token },
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.data.eligible, false);
      assert.equal(res.body.data.state, 'INELIGIBLE');
      assert.equal(res.body.data.reasons[0]?.code, 'PROGRESS_INCOMPLETE');
    });

    it('returns INELIGIBLE when published examination is not passed', async () => {
      const student = await newStudent();
      const { course } = await createCompletedCourseForStudent(student.userId);

      // Add a published examination to the course
      await prisma.examination.create({
        data: {
          courseId: course.id,
          title: 'Final Certification Exam',
          status: 'PUBLISHED',
          publishedAt: new Date(),
          opensAt: new Date(Date.now() - 3600000),
          closesAt: new Date(Date.now() + 3600000),
          durationMinutes: 60,
          passPercent: 70,
        },
      });

      const res = await student.client.request<CertificateEligibilityResult>(
        'GET',
        `/student/courses/${course.id}/certificate/eligibility`,
        { token: student.token },
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.data.eligible, false);
      assert.equal(res.body.data.state, 'INELIGIBLE');
      assert.equal(res.body.data.reasons[0]?.code, 'EXAM_NOT_PASSED');
    });

    it('returns ELIGIBLE when lessons and examinations are complete and passed', async () => {
      const student = await newStudent();
      const { course } = await createCompletedCourseForStudent(student.userId);

      // Add a published examination and record a passed attempt
      const exam = await prisma.examination.create({
        data: {
          courseId: course.id,
          title: 'Final Exam',
          status: 'PUBLISHED',
          publishedAt: new Date(),
          opensAt: new Date(Date.now() - 3600000),
          closesAt: new Date(Date.now() + 3600000),
          durationMinutes: 60,
          passPercent: 60,
        },
      });

      await prisma.assessmentAttempt.create({
        data: {
          examinationId: exam.id,
          userId: student.userId,
          attemptNumber: 1,
          status: 'SUBMITTED',
          evaluationStatus: 'EVALUATED',
          startedAt: new Date(Date.now() - 1800000),
          submittedAt: new Date(Date.now() - 1200000),
          finalizedAt: new Date(Date.now() - 1200000),
          maxScore: 100,
          rawScore: 85,
          score: 85,
          percent: 85,
          passed: true,
          evaluatedAt: new Date(),
        },
      });

      const res = await student.client.request<CertificateEligibilityResult>(
        'GET',
        `/student/courses/${course.id}/certificate/eligibility`,
        { token: student.token },
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.data.eligible, true);
      assert.equal(res.body.data.state, 'ELIGIBLE');
      assert.equal(res.body.data.reasons.length, 0);
    });
  });

  describe('Certificate Issuance & Idempotency', () => {
    it('issues certificate successfully with formatted ID, snapshots, and notification', async () => {
      const student = await newStudent('Fatima Zahra');
      const { course, completedAt } = await createCompletedCourseForStudent(
        student.userId,
        'Intermediate Arabic Grammar',
      );

      const res = await student.client.request<CertificateDto>(
        'POST',
        `/student/courses/${course.id}/certificate`,
        { token: student.token },
      );

      assert.equal(res.status, 201);
      const cert = res.body.data;
      assert.ok(cert.id);
      assert.match(cert.certificateNumber, /^ASRA-\d{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.equal(cert.recipientName, 'Fatima Zahra');
      assert.equal(cert.courseTitle, 'Intermediate Arabic Grammar');
      assert.equal(cert.status, 'ISSUED');
      assert.equal(new Date(cert.completedAt).toISOString(), completedAt.toISOString());

      // Verify in database
      const dbCert = await prisma.certificate.findUnique({
        where: { id: cert.id },
      });
      assert.ok(dbCert);
      assert.equal(dbCert.certificateNumber, cert.certificateNumber);

      // Verify in-app notification was generated
      const notification = await prisma.notification.findFirst({
        where: { userId: student.userId, type: 'CERTIFICATE' },
      });
      assert.ok(notification);
      assert.equal(notification.event, 'certificate.issued');
    });

    it('returns the existing certificate idempotently on duplicate issuance requests', async () => {
      const student = await newStudent('Zayd ibn Thabit');
      const { course } = await createCompletedCourseForStudent(student.userId, 'Hadith Sciences');

      const firstRes = await student.client.request<CertificateDto>(
        'POST',
        `/student/courses/${course.id}/certificate`,
        { token: student.token },
      );
      assert.equal(firstRes.status, 201);
      const firstCert = firstRes.body.data;

      // Second issuance request
      const secondRes = await student.client.request<CertificateDto>(
        'POST',
        `/student/courses/${course.id}/certificate`,
        { token: student.token },
      );
      assert.equal(secondRes.status, 201);
      const secondCert = secondRes.body.data;

      assert.equal(secondCert.id, firstCert.id);
      assert.equal(secondCert.certificateNumber, firstCert.certificateNumber);

      // Verify only 1 row exists in database
      const count = await prisma.certificate.count({
        where: { userId: student.userId, courseId: course.id },
      });
      assert.equal(count, 1);

      // Check eligibility endpoint now reports ALREADY_ISSUED
      const eligRes = await student.client.request<CertificateEligibilityResult>(
        'GET',
        `/student/courses/${course.id}/certificate/eligibility`,
        { token: student.token },
      );
      assert.equal(eligRes.body.data.state, 'ALREADY_ISSUED');
      assert.equal(eligRes.body.data.certificate?.id, firstCert.id);
    });

    // PHASE 14: a double click / two tabs must never surface a 500. Inside an interactive
    // PostgreSQL transaction a unique violation aborts the transaction, so issuance is serialised
    // on the enrolment row instead of recovering from P2002.
    it('concurrent issuance requests all succeed with the same single certificate', async () => {
      const student = await newStudent('Concurrent Claimant');
      const { course } = await createCompletedCourseForStudent(student.userId, 'Race Course');

      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          student.client.request<CertificateDto>(
            'POST',
            `/student/courses/${course.id}/certificate`,
            { token: student.token },
          ),
        ),
      );

      assert.deepEqual(
        responses.map((r) => r.status),
        responses.map(() => 201),
      );
      const ids = new Set(responses.map((r) => r.body.data.id));
      assert.equal(ids.size, 1);
      assert.equal(
        await prisma.certificate.count({ where: { userId: student.userId, courseId: course.id } }),
        1,
      );
      assert.equal(
        await prisma.notification.count({ where: { userId: student.userId, type: 'CERTIFICATE' } }),
        1,
      );
    });

    it('rejects issuance when student is not eligible', async () => {
      const student = await newStudent();
      const s = uniqueSuffix();
      const course = await prisma.course.create({
        data: {
          title: `Course ${s}`,
          slug: `course-${s}`,
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      });

      const res = await student.client.request(
        'POST',
        `/student/courses/${course.id}/certificate`,
        { token: student.token },
      );

      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
    });
  });

  describe('Student Listing & PDF Download', () => {
    it('lists certificates for the authenticated student', async () => {
      const student1 = await newStudent('Student One');
      const student2 = await newStudent('Student Two');

      const { course: c1 } = await createCompletedCourseForStudent(student1.userId, 'Course 1');
      const { course: c2 } = await createCompletedCourseForStudent(student2.userId, 'Course 2');

      // Issue certificate for student 1
      await student1.client.request('POST', `/student/courses/${c1.id}/certificate`, {
        token: student1.token,
      });

      // Issue certificate for student 2
      await student2.client.request('POST', `/student/courses/${c2.id}/certificate`, {
        token: student2.token,
      });

      // Student 1 lists certificates
      const res = await student1.client.request<Paginated<CertificateDto>>(
        'GET',
        '/student/certificates',
        { token: student1.token },
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.data.pagination.total, 1);
      assert.equal(res.body.data.items[0]?.courseTitle, 'Course 1');
      assert.equal(res.body.data.items[0]?.recipientName, 'Student One');
    });

    it('downloads publication-grade PDF with proper headers and magic bytes', async () => {
      const student = await newStudent('Maryam Al-Hassan');
      const { course } = await createCompletedCourseForStudent(
        student.userId,
        'Seerah of the Prophet',
      );

      const issueRes = await student.client.request<CertificateDto>(
        'POST',
        `/student/courses/${course.id}/certificate`,
        { token: student.token },
      );
      const cert = issueRes.body.data;

      const rawRes = await fetch(`${baseUrl}/api/v1/student/certificates/${cert.id}/download`, {
        headers: { Authorization: `Bearer ${student.token}` },
      });

      assert.equal(rawRes.status, 200);
      assert.equal(rawRes.headers.get('content-type'), 'application/pdf');
      assert.match(
        rawRes.headers.get('content-disposition') ?? '',
        new RegExp(`attachment; filename="ASRA-Certificate-${cert.certificateNumber}.pdf"`),
      );

      // PHASE 15 (QA-DEF-01): personal document, never stored by any cache (browser included).
      assert.equal(rawRes.headers.get('cache-control'), 'no-store');

      const buffer = Buffer.from(await rawRes.arrayBuffer());
      assert.ok(buffer.length > 1000);
      // PDF Magic bytes: %PDF-
      assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-');

      const adminToken = await tokenFor(student.client, 'ADMIN');
      const adminRes = await fetch(`${baseUrl}/api/v1/admin/certificates/${cert.id}/download`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(adminRes.status, 200);
      assert.equal(adminRes.headers.get('content-type'), 'application/pdf');
      assert.equal(adminRes.headers.get('cache-control'), 'no-store');
    });

    it('forbids another student from downloading a certificate they do not own', async () => {
      const student1 = await newStudent('Owner Student');
      const student2 = await newStudent('Intruder Student');

      const { course } = await createCompletedCourseForStudent(student1.userId, 'Private Course');
      const issueRes = await student1.client.request<CertificateDto>(
        'POST',
        `/student/courses/${course.id}/certificate`,
        { token: student1.token },
      );
      const cert = issueRes.body.data;

      // Student 2 tries to download student 1's certificate
      const rawRes = await fetch(`${baseUrl}/api/v1/student/certificates/${cert.id}/download`, {
        headers: { Authorization: `Bearer ${student2.token}` },
      });

      assert.equal(rawRes.status, 403);
    });
  });

  describe('Public Verification Endpoint', () => {
    it('verifies valid issued certificate publicly and preserves privacy', async () => {
      const student = await newStudent('Ali ibn Abi Talib');
      const { course } = await createCompletedCourseForStudent(
        student.userId,
        'Islamic Jurisprudence',
      );

      const issueRes = await student.client.request<CertificateDto>(
        'POST',
        `/student/courses/${course.id}/certificate`,
        { token: student.token },
      );
      const cert = issueRes.body.data;

      // Public verification request (NO AUTH TOKEN)
      const client = new TestClient(baseUrl);
      const res = await client.request<PublicCertificateVerificationDto>(
        'GET',
        `/certificates/verify/${cert.certificateNumber}`,
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      const verifyData = res.body.data;
      assert.equal(verifyData.valid, true);
      assert.equal(verifyData.certificateNumber, cert.certificateNumber);
      assert.equal(verifyData.recipientName, 'Ali ibn Abi Talib');
      assert.equal(verifyData.courseTitle, 'Islamic Jurisprudence');
      assert.equal(verifyData.academyName, 'ASRA Academy');
      assert.equal(verifyData.status, 'ISSUED');

      // Privacy checks: must not contain sensitive internal fields
      const jsonStr = JSON.stringify(verifyData);
      assert.equal(jsonStr.includes(student.email), false);
      assert.equal(jsonStr.includes(student.userId), false);
      assert.ok(cert.enrollmentId);
      assert.equal(jsonStr.includes(cert.enrollmentId), false);
    });

    it('returns 404 for unknown certificate identifier', async () => {
      const client = new TestClient(baseUrl);
      const res = await client.request('GET', '/certificates/verify/ASRA-2026-XXXX-YYYY');

      assert.equal(res.status, 404);
      assert.equal(res.body.success, false);
    });
  });

  describe('Admin Portal Management & Revocation', () => {
    it('allows admin to list and search certificates', async () => {
      const student = await newStudent('Bilal ibn Rabah');
      const { course } = await createCompletedCourseForStudent(student.userId, 'History of Islam');

      const issueRes = await student.client.request<CertificateDto>(
        'POST',
        `/student/courses/${course.id}/certificate`,
        { token: student.token },
      );
      const cert = issueRes.body.data;

      const adminClient = new TestClient(baseUrl);
      const adminToken = await tokenFor(adminClient, 'ADMIN');

      const res = await adminClient.request<Paginated<AdminCertificateListItem>>(
        'GET',
        `/admin/certificates?search=${encodeURIComponent(cert.certificateNumber)}`,
        { token: adminToken },
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.data.pagination.total, 1);
      assert.equal(res.body.data.items[0]?.certificateNumber, cert.certificateNumber);
      assert.equal(res.body.data.items[0]?.recipientName, 'Bilal ibn Rabah');
    });

    it('allows admin to revoke certificate with audit logging and updates public verification', async () => {
      const student = await newStudent('Tariq ibn Ziyad');
      const { course } = await createCompletedCourseForStudent(
        student.userId,
        'Islamic Governance',
      );

      const issueRes = await student.client.request<CertificateDto>(
        'POST',
        `/student/courses/${course.id}/certificate`,
        { token: student.token },
      );
      const cert = issueRes.body.data;

      const adminClient = new TestClient(baseUrl);
      const adminToken = await tokenFor(adminClient, 'ADMIN');

      // Revoke certificate
      const revokeRes = await adminClient.request<CertificateDto>(
        'POST',
        `/admin/certificates/${cert.id}/revoke`,
        {
          token: adminToken,
          body: { reason: 'Academic integrity violation identified post-completion.' },
        },
      );

      assert.equal(revokeRes.status, 200);
      assert.equal(revokeRes.body.data.status, 'REVOKED');
      assert.equal(
        revokeRes.body.data.revokedReason,
        'Academic integrity violation identified post-completion.',
      );
      assert.ok(revokeRes.body.data.revokedAt);

      // Verify audit log entry
      const auditLog = await prisma.adminAuditLog.findFirst({
        where: {
          action: 'certificate.revoked_by_admin',
          entityId: cert.id,
        },
      });
      assert.ok(auditLog);

      // Verify public verification now reflects revocation
      const publicRes = await adminClient.request<PublicCertificateVerificationDto>(
        'GET',
        `/certificates/verify/${cert.certificateNumber}`,
      );

      assert.equal(publicRes.status, 200);
      assert.equal(publicRes.body.data.valid, false);
      assert.equal(publicRes.body.data.status, 'REVOKED');
      assert.equal(
        publicRes.body.data.revokedReason,
        'Academic integrity violation identified post-completion.',
      );
    });

    it('forbids non-admin from accessing admin certificate endpoints', async () => {
      const student = await newStudent();
      const res = await student.client.request('GET', '/admin/certificates', {
        token: student.token,
      });

      assert.equal(res.status, 403);
    });
  });
});
