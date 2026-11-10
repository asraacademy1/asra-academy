import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/database/prisma.js';

/** Short unique suffix so tests never collide with each other or with leftovers. */
export function uniqueSuffix(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Deletes every row created by the tests, children first. Reference data (roles/permissions)
 * is kept so the seed tests can assert on it.
 */
export async function cleanDomainTables(): Promise<void> {
  await prisma.$transaction([
    prisma.adminAuditLog.deleteMany(),
    prisma.certificate.deleteMany(),
    prisma.notificationDelivery.deleteMany(),
    prisma.notification.deleteMany(),
    // Recruitment rows (PHASE 16) reference User and Job
    prisma.jobApplicationCommunication.deleteMany(),
    prisma.jobInterview.deleteMany(),
    prisma.jobApplicationNote.deleteMany(),
    prisma.jobApplicationStatusHistory.deleteMany(),
    prisma.jobApplicationAnswer.deleteMany(),
    prisma.jobApplication.deleteMany(),
    prisma.jobApplicationQuestion.deleteMany(),
    prisma.job.deleteMany(),
    prisma.jobSequence.deleteMany(),
    prisma.applicationSequence.deleteMany(),
    // Financial rows are RESTRICT-protected in the application; tests remove them first.
    prisma.paymentAuditLog.deleteMany(),
    prisma.paymentWebhookEvent.deleteMany(),
    prisma.refund.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.enrollment.updateMany({ data: { orderId: null } }),
    prisma.order.deleteMany(),
    prisma.assessmentAuditLog.deleteMany(),
    prisma.attemptQuestion.deleteMany(),
    prisma.assessmentAttempt.deleteMany(),
    prisma.assessmentQuestionOption.deleteMany(),
    prisma.assessmentQuestion.deleteMany(),
    prisma.quiz.deleteMany(),
    prisma.examination.deleteMany(),
    // Academy quizzes and the shared media ledger (options/banners reference media: RESTRICT).
    prisma.academyQuiz.deleteMany(),
    prisma.assessmentMedia.deleteMany(),
    prisma.assignmentSubmissionRevision.deleteMany(),
    prisma.assignmentSubmission.deleteMany(),
    prisma.assignment.deleteMany(),
    prisma.liveClassSession.deleteMany(),
    prisma.lessonProgress.deleteMany(),
    prisma.enrollment.deleteMany(),
    prisma.resource.deleteMany(),
    prisma.lesson.deleteMany(),
    prisma.chapter.deleteMany(),
    prisma.module.deleteMany(),
    prisma.courseInstructor.deleteMany(),
    prisma.course.deleteMany(),
    prisma.courseCategory.deleteMany(),
    prisma.studentProfile.deleteMany(),
    prisma.facultyProfile.deleteMany(),
    prisma.userRole.deleteMany(),
    prisma.user.deleteMany(),
    prisma.subject.deleteMany(),
    prisma.stream.deleteMany(),
    prisma.class.deleteMany(),
    prisma.academicLevel.deleteMany(),
  ]);
}

/** Course → Module → Chapter → Lesson, the minimum chain for curriculum tests. */
export async function createCourseTree() {
  const s = uniqueSuffix();
  const course = await prisma.course.create({
    data: { title: `Course ${s}`, slug: `course-${s}` },
  });
  const module = await prisma.module.create({
    data: { courseId: course.id, title: 'Module 1', position: 0 },
  });
  const chapter = await prisma.chapter.create({
    data: { moduleId: module.id, title: 'Chapter 1', position: 0 },
  });
  const lesson = await prisma.lesson.create({
    data: { chapterId: chapter.id, title: 'Lesson 1', contentType: 'VIDEO', position: 0 },
  });
  return { course, module, chapter, lesson };
}
