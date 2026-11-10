/**
 * Question & option images shared by course quizzes, examinations and academy quizzes
 * (docs/ASSESSMENTS.md §Media), over real HTTP and the real database. Cloudinary is replaced by an
 * in-memory store. Covers: byte-level validation and the strict 100 KB limit, upload
 * authorization, attach rules, question/option limits, player + review payloads, cleanup of
 * removed/abandoned images without a scheduler, retry of failed deletions, and the guarantee that
 * media used by another question or a historical attempt is never deleted.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { QuestionDto, StudentAttemptDto } from '@asra/types';
import { createApp } from '../src/app.js';
import { disconnectPrisma, prisma } from '../src/database/prisma.js';
import { setClockForTests } from '../src/lib/clock.js';
import { disconnectRedis } from '../src/lib/redis.js';
import { readSnapshot } from '../src/modules/assessments/attempts.core.js';
import { setImageStoreForTests } from '../src/modules/assessments/media/image-store.js';
import { sniffImage } from '../src/modules/assessments/media/image-sniff.js';
import { collectGarbage, releaseMedia } from '../src/modules/assessments/media/media.service.js';
import {
  at,
  buildWorld,
  createExam,
  createQuiz,
  mcq,
  plusMinutes,
  startQuiz,
  trueFalse,
  type World,
} from './support/assessment.js';
import { expectStatus, tokenFor } from './support/catalog.js';
import { startServer, TestClient } from './support/http.js';
import {
  fakeImageStore,
  jpeg,
  png,
  uploadImage,
  webp,
  type FakeImageStore,
} from './support/media.js';

let baseUrl: string;
let close: () => Promise<void>;
let w: World;
let store: FakeImageStore;

before(async () => {
  ({ baseUrl, close } = await startServer(createApp()));
});
after(async () => {
  setClockForTests(null);
  setImageStoreForTests(null);
  await close();
  await Promise.all([disconnectPrisma(), disconnectRedis()]);
});
beforeEach(async () => {
  store = fakeImageStore();
  setImageStoreForTests(store);
  w = await buildWorld(baseUrl); // also clears questions, attempts and media
});

const T0 = '2026-11-02T04:30:00.000Z';

async function upload(token: string, bytes = webp(), contentType = 'image/webp') {
  const response = await uploadImage(baseUrl, token, bytes, { contentType });
  assert.equal(response.status, 201, response.text);
  return response.body!.data;
}

const publicIdOf = async (id: string) =>
  (await prisma.assessmentMedia.findUniqueOrThrow({ where: { id } })).publicId;

async function draftQuiz() {
  return createQuiz(w.alice, w.courseA.chapterId, { questions: [], publish: false });
}

function imageQuestion(imageIds: string[], optionImageId: string | null = null) {
  const base = mcq();
  return {
    ...base,
    imageIds,
    options: base.options.map((option, index) =>
      index === 0 ? { ...option, imageId: optionImageId } : option,
    ),
  };
}

describe('image validation (bytes, not names)', () => {
  it('reads format, size and animation from the headers', () => {
    assert.deepEqual(sniffImage(webp(1200, 800)), {
      format: 'webp',
      width: 1200,
      height: 800,
      animated: false,
    });
    assert.equal(sniffImage(webp(10, 10, { animated: true }))?.animated, true);
    assert.deepEqual(sniffImage(png(400, 300)), {
      format: 'png',
      width: 400,
      height: 300,
      animated: false,
    });
    assert.equal(sniffImage(png(4, 4, { animated: true }))?.animated, true);
    assert.deepEqual(sniffImage(jpeg(640, 480)), {
      format: 'jpg',
      width: 640,
      height: 480,
      animated: false,
    });
    assert.equal(sniffImage(Buffer.from('%PDF-1.4 not an image')), null);
    assert.equal(sniffImage(Buffer.alloc(64, 7)), null);
    assert.equal(sniffImage(webp().subarray(0, 20)), null, 'truncated');
  });

  it('accepts exactly 100 KB and refuses one byte more (before buffering it)', async () => {
    const exact = await uploadImage(baseUrl, w.alice.token, webp(800, 600, { bytes: 102_400 }));
    assert.equal(exact.status, 201, exact.text);
    assert.equal(exact.body!.data.bytes, 102_400);
    const over = await uploadImage(baseUrl, w.alice.token, webp(800, 600, { bytes: 102_401 }));
    assert.equal(over.status, 413);
    assert.match(over.text, /larger than 100 KB/);
  });

  it('rejects disguised, animated, oversized-dimension, empty and non-image uploads', async () => {
    const cases: [Buffer, string, RegExp][] = [
      [png(), 'image/webp', /does not match/],
      [Buffer.from('%PDF-1.4\n%%EOF'), 'image/png', /Only WebP, JPEG or PNG/],
      [Buffer.alloc(500, 1), 'image/jpeg', /Only WebP, JPEG or PNG/],
      [webp(100, 100, { animated: true }), 'image/webp', /Animated/],
      [png(10, 10, { animated: true }), 'image/png', /Animated/],
      [webp(3000, 100), 'image/webp', /2048/],
      [Buffer.alloc(0), 'image/webp', /Choose an image/],
      [webp(), 'image/gif', /Only WebP, JPEG or PNG/],
      [webp(), 'text/plain', /Only WebP, JPEG or PNG/],
    ];
    for (const [bytes, type, message] of cases) {
      const response = await uploadImage(baseUrl, w.alice.token, bytes, { contentType: type });
      assert.equal(response.status, 422, `${type}: ${response.text}`);
      assert.match(response.text, message);
    }
    assert.equal(await prisma.assessmentMedia.count(), 0);
    assert.equal(store.uploaded.size, 0, 'nothing invalid ever reaches storage');
  });

  it('stores under a random id in the assessments folder (never the file name)', async () => {
    const media = await upload(w.alice.token, jpeg(), 'image/jpeg');
    const row = await prisma.assessmentMedia.findUniqueOrThrow({ where: { id: media.id } });
    assert.match(row.publicId, /^asra\/assessments\/[0-9a-f-]{36}$/);
    assert.equal(row.format, 'jpg');
    assert.equal(row.uploadedById, w.alice.userId);
    assert.ok(store.uploaded.has(row.publicId));
    assert.equal(media.url, `https://images.test/${row.publicId}.jpg`);
  });
});

describe('upload authorization', () => {
  it('faculty may upload; students and anonymous callers may not', async () => {
    assert.equal((await uploadImage(baseUrl, w.sam.token, webp())).status, 403);
    assert.equal((await uploadImage(baseUrl, undefined, webp())).status, 401);
  });

  it('the admin route requires academy_quizzes.manage (faculty refused; Admin allowed)', async () => {
    const asFaculty = await uploadImage(baseUrl, w.alice.token, webp(), { portal: 'admin' });
    assert.equal(asFaculty.status, 403);
    const adminToken = await tokenFor(new TestClient(baseUrl), 'ADMIN');
    const asAdmin = await uploadImage(baseUrl, adminToken, webp(), { portal: 'admin' });
    assert.equal(asAdmin.status, 201, asAdmin.text);
    // An admin is not faculty: the faculty route stays closed to them.
    assert.equal((await uploadImage(baseUrl, adminToken, webp())).status, 403);
  });

  it('caps unused uploads per account', async () => {
    await prisma.assessmentMedia.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        publicId: `asra/assessments/pending-${i}-${w.alice.userId}`,
        uploadedById: w.alice.userId,
        format: 'webp',
        bytes: 100,
        width: 10,
        height: 10,
      })),
    });
    const response = await uploadImage(baseUrl, w.alice.token, webp());
    assert.equal(response.status, 409);
    assert.match(response.text, /not used in any question/);
  });
});

describe('attaching images to questions', () => {
  it('stores up to 3 question images and one image per option, in order', async () => {
    const quiz = await draftQuiz();
    const [a, b, c, d] = [
      await upload(w.alice.token),
      await upload(w.alice.token, png(), 'image/png'),
      await upload(w.alice.token, jpeg(), 'image/jpeg'),
      await upload(w.alice.token),
    ];
    const created = await w.alice.api<QuestionDto>(
      'POST',
      `/faculty/quizzes/${quiz.lessonId}/questions`,
      imageQuestion([c!.id, a!.id, b!.id], d!.id),
    );
    expectStatus(created, 201);
    const q = created.body.data;
    assert.deepEqual(
      q.images.map((image) => image.id),
      [c!.id, a!.id, b!.id],
    );
    assert.equal(q.images[0]!.width, 640);
    assert.equal(q.options[0]!.image?.id, d!.id);
    assert.equal(q.options[1]!.image, null);
    const listed = await w.alice.api<{ questions: QuestionDto[] }>(
      'GET',
      `/faculty/quizzes/${quiz.lessonId}`,
    );
    assert.deepEqual(listed.body.data.questions[0]!.images, q.images);
  });

  it('enforces the limits and the option rules', async () => {
    const quiz = await draftQuiz();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await upload(w.alice.token)).id);
    const path = `/faculty/quizzes/${quiz.lessonId}/questions`;
    const four = await w.alice.api('POST', path, imageQuestion(ids));
    assert.equal(four.status, 422);
    assert.match(four.text, /at most 3 images/);

    const tf = trueFalse();
    const tfWithImage = await w.alice.api('POST', path, {
      ...tf,
      options: [{ ...tf.options[0], imageId: ids[0] }, tf.options[1]],
    });
    assert.equal(tfWithImage.status, 422);
    assert.match(tfWithImage.text, /True\/False options cannot have images/);

    const blank = mcq();
    const neither = await w.alice.api('POST', path, {
      ...blank,
      options: [{ text: '', isCorrect: true }, ...blank.options.slice(1)],
    });
    assert.equal(neither.status, 422);
    assert.match(neither.text, /text or add an image/);

    const reused = await w.alice.api('POST', path, imageQuestion([ids[0]!], ids[0]!));
    assert.equal(reused.status, 422);

    // Picture-only options are fine, and two of them do not count as "duplicate text".
    const pictures = await w.alice.api<QuestionDto>('POST', path, {
      ...blank,
      options: [
        { text: '', isCorrect: true, imageId: ids[1] },
        { text: '', isCorrect: false, imageId: ids[2] },
      ],
    });
    expectStatus(pictures, 201);
    assert.equal(pictures.body.data.options[0]!.text, '');
  });

  it('refuses another user’s upload and another course’s quiz', async () => {
    const aliceImage = await upload(w.alice.token);
    const bobQuiz = await createQuiz(w.bob, w.courseB.chapterId, { questions: [], publish: false });
    const stolen = await w.bob.api(
      'POST',
      `/faculty/quizzes/${bobQuiz.lessonId}/questions`,
      imageQuestion([aliceImage.id]),
    );
    assert.equal(stolen.status, 422);
    assert.match(stolen.text, /no longer available/);

    const aliceQuiz = await draftQuiz();
    const bobImage = await upload(w.bob.token);
    const foreignQuiz = await w.bob.api(
      'POST',
      `/faculty/quizzes/${aliceQuiz.lessonId}/questions`,
      imageQuestion([bobImage.id]),
    );
    assert.equal(foreignQuiz.status, 403, 'assigned-course rule unchanged');
  });

  it('works for examinations too (same editor and service)', async () => {
    const image = await upload(w.alice.token);
    const now = at(T0);
    const exam = await createExam(
      w.alice,
      w.courseA.courseId,
      { opensAt: plusMinutes(now, 10), closesAt: plusMinutes(now, 120) },
      { questions: [], publish: false },
    );
    const created = await w.alice.api<QuestionDto>(
      'POST',
      `/faculty/exams/${exam.examId}/questions`,
      { type: 'SHORT_ANSWER', prompt: 'Describe the diagram.', marks: 5, imageIds: [image.id] },
    );
    expectStatus(created, 201);
    assert.equal(created.body.data.images[0]!.id, image.id);
  });
});

describe('cleanup (no scheduler)', () => {
  it('deletes images removed by an edit or a question deletion, once', async () => {
    const quiz = await draftQuiz();
    const [a, b, c] = [
      await upload(w.alice.token),
      await upload(w.alice.token),
      await upload(w.alice.token),
    ];
    const created = await w.alice.api<QuestionDto>(
      'POST',
      `/faculty/quizzes/${quiz.lessonId}/questions`,
      imageQuestion([a.id, b.id], c.id),
    );
    expectStatus(created, 201);
    const [pa, pb, pc] = [await publicIdOf(a.id), await publicIdOf(b.id), await publicIdOf(c.id)];

    // Keep `a`, drop `b`, keep option image `c`.
    expectStatus(
      await w.alice.api(
        'PATCH',
        `/faculty/questions/${created.body.data.id}`,
        imageQuestion([a.id], c.id),
      ),
      200,
    );
    assert.deepEqual(store.destroyed, [pb]);
    assert.equal(await prisma.assessmentMedia.count({ where: { id: b.id } }), 0);

    expectStatus(await w.alice.api('DELETE', `/faculty/questions/${created.body.data.id}`), 200);
    assert.deepEqual(store.destroyed.sort(), [pa, pb, pc].sort());
    assert.equal(await prisma.assessmentMedia.count(), 0);
  });

  it('keeps an image another question still uses', async () => {
    const quiz = await draftQuiz();
    const shared = await upload(w.alice.token);
    const sharedPublicId = await publicIdOf(shared.id);
    const path = `/faculty/quizzes/${quiz.lessonId}/questions`;
    const first = await w.alice.api<QuestionDto>('POST', path, imageQuestion([shared.id]));
    const second = await w.alice.api<QuestionDto>('POST', path, imageQuestion([shared.id]));
    expectStatus(first, 201);
    expectStatus(second, 201);
    expectStatus(await w.alice.api('DELETE', `/faculty/questions/${first.body.data.id}`), 200);
    assert.deepEqual(store.destroyed, [], 'still used by the second question');
    expectStatus(await w.alice.api('DELETE', `/faculty/questions/${second.body.data.id}`), 200);
    assert.deepEqual(store.destroyed, [sharedPublicId]);
    assert.equal(await prisma.assessmentMedia.count(), 0);
  });

  it('never deletes media frozen into a historical attempt', async () => {
    at(T0);
    const qImage = await upload(w.alice.token);
    const optImage = await upload(w.alice.token);
    const quiz = await createQuiz(w.alice, w.courseA.chapterId, {
      questions: [imageQuestion([qImage.id], optImage.id) as ReturnType<typeof mcq>],
    });
    const attempt = await startQuiz(w.sam, quiz.lessonId);
    const stored = await prisma.attemptQuestion.findFirstOrThrow({
      where: { attemptId: attempt.id },
    });
    assert.deepEqual([...stored.mediaIds].sort(), [qImage.id, optImage.id].sort());

    // Even if every live reference vanished, the attempt keeps both images alive.
    await prisma.assessmentQuestion.updateMany({
      where: { quizId: quiz.quizId },
      data: { imageIds: [] },
    });
    await prisma.assessmentQuestionOption.updateMany({
      where: { question: { quizId: quiz.quizId } },
      data: { imageId: null },
    });
    assert.equal(await releaseMedia([qImage.id, optImage.id]), 0);
    assert.equal(await collectGarbage(new Date(Date.now() + 48 * 3600_000)), 0);
    assert.deepEqual(store.destroyed, []);
    assert.equal(await prisma.assessmentMedia.count(), 2);
  });

  it('collects abandoned uploads after 24 h when anyone uploads again', async () => {
    const abandoned = await upload(w.alice.token);
    const publicId = await publicIdOf(abandoned.id);
    await prisma.assessmentMedia.update({
      where: { id: abandoned.id },
      data: { createdAt: new Date(Date.now() - 25 * 3600_000) },
    });
    const fresh = await upload(w.bob.token);
    assert.deepEqual(store.destroyed, [publicId]);
    assert.equal(await prisma.assessmentMedia.count({ where: { id: abandoned.id } }), 0);
    assert.equal(await prisma.assessmentMedia.count({ where: { id: fresh.id } }), 1, 'recent kept');
  });

  it('retries a failed deletion; a DELETING image cannot be attached again', async () => {
    const quiz = await draftQuiz();
    const image = await upload(w.alice.token);
    const created = await w.alice.api<QuestionDto>(
      'POST',
      `/faculty/quizzes/${quiz.lessonId}/questions`,
      imageQuestion([image.id]),
    );
    store.failDestroy = true;
    expectStatus(
      await w.alice.api('PATCH', `/faculty/questions/${created.body.data.id}`, imageQuestion([])),
      200,
    );
    const pending = await prisma.assessmentMedia.findUniqueOrThrow({ where: { id: image.id } });
    assert.equal(pending.status, 'DELETING');
    assert.equal(pending.deleteAttempts, 1);

    const reattach = await w.alice.api(
      'PATCH',
      `/faculty/questions/${created.body.data.id}`,
      imageQuestion([image.id]),
    );
    assert.equal(reattach.status, 422);

    store.failDestroy = false;
    await upload(w.alice.token); // any upload triggers the bounded cleanup
    assert.equal(await prisma.assessmentMedia.count({ where: { id: image.id } }), 0);
    assert.deepEqual(store.destroyed, [pending.publicId]);
  });
});

describe('player and review payloads', () => {
  it('students see question/option images while attempting and in the review, never the key', async () => {
    at(T0);
    const qImage = await upload(w.alice.token);
    const optImage = await upload(w.alice.token);
    const quiz = await createQuiz(w.alice, w.courseA.chapterId, {
      questions: [imageQuestion([qImage.id], optImage.id) as ReturnType<typeof mcq>],
    });
    const attempt = await startQuiz(w.sam, quiz.lessonId);
    const question = attempt.questions[0]!;
    assert.equal(question.images[0]!.id, qImage.id);
    assert.match(question.images[0]!.url, /^https:\/\/images\.test\/asra\/assessments\//);
    assert.equal(question.options.find((o) => o.image)?.image?.id, optImage.id);
    assert.doesNotMatch(JSON.stringify(attempt), /isCorrect/);

    const submitted = await w.sam.api<StudentAttemptDto>(
      'POST',
      `/student/attempts/${attempt.id}/submit`,
    );
    expectStatus(submitted, 200);
    const review = submitted.body.data.review!;
    assert.equal(review[0]!.images[0]!.id, qImage.id);
    assert.equal(review[0]!.options.find((o) => o.image)?.image?.id, optImage.id);
  });

  it('historical snapshots without images still read as "no images"', () => {
    const legacy = readSnapshot({
      prompt: '2+2?',
      explanation: null,
      options: [{ id: 'a', text: '4', isCorrect: true }],
    });
    assert.deepEqual(legacy.images, []);
    assert.equal(legacy.options[0]!.image, undefined);
  });
});

describe('database constraints (last line of defence)', () => {
  const rejects = async (sql: string, constraint: string) => {
    await assert.rejects(prisma.$executeRawUnsafe(sql), new RegExp(constraint));
  };

  it('enforce 100 KB, formats, dimensions, ≤ 3 question images and exactly one owner', async () => {
    const insertMedia = (bytes: number, format = 'webp', width = 10) =>
      `INSERT INTO assessment_media (public_id, format, bytes, width, height, updated_at)
       VALUES ('c-${bytes}-${format}-${width}', '${format}', ${bytes}, ${width}, 10, now())`;
    await rejects(insertMedia(102_401), 'assessment_media_bytes_range');
    await rejects(insertMedia(100, 'gif'), 'assessment_media_format');
    await rejects(insertMedia(100, 'png', 4096), 'assessment_media_dimensions_range');
    await prisma.$executeRawUnsafe(insertMedia(102_400));

    const quiz = await draftQuiz();
    const exam = await prisma.examination.create({
      data: {
        courseId: w.courseA.courseId,
        title: 'E',
        opensAt: new Date(),
        closesAt: new Date(Date.now() + 3600_000),
        durationMinutes: 30,
      },
    });
    const ids = Array.from({ length: 4 }, () => `'${crypto.randomUUID()}'`).join(',');
    await rejects(
      `INSERT INTO assessment_questions (quiz_id, type, prompt, marks, position, updated_at, image_ids)
       VALUES ('${quiz.quizId}', 'SINGLE_CHOICE', 'x', 1, 0, now(), ARRAY[${ids}]::uuid[])`,
      'assessment_questions_image_ids_range',
    );
    await rejects(
      `INSERT INTO assessment_questions (quiz_id, examination_id, type, prompt, marks, position, updated_at)
       VALUES ('${quiz.quizId}', '${exam.id}', 'SINGLE_CHOICE', 'x', 1, 0, now())`,
      'assessment_questions_one_owner',
    );
  });
});
