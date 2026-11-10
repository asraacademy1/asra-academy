/**
 * Question/option images in the web app: the browser-side compression policy (driven by a fake
 * encoder — canvas encoding itself needs a real browser), the editor's add/replace/remove slot
 * logic and request body, and how images render in the editor list, the student player/review
 * and the faculty review. Upload validation, attach rules and cleanup are covered against the
 * real API in apps/api/tests/assessment-media.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

import type { MediaDto, ReviewQuestionDto, StudentAttemptDto } from '@asra/types';
import { MEDIA_LIMITS, questionInputSchema } from '@asra/validation';

import { ImageSlots, placeImage, removeImage } from '@/components/assessments/image-slots';
import { OptionImage, QuestionImages, optionLetter } from '@/components/assessments/question-media';
import { draftKey, draftToInput } from '@/components/faculty/assessment-builder';
import { AttemptOutcome, ReviewList } from '@/components/student/attempt-player';
import {
  QUALITY_STEPS,
  TOO_DETAILED_MESSAGE,
  UNSUPPORTED_MESSAGE,
  fitWithinLimit,
  scaledSize,
  type Encoder,
} from '@/lib/media/compress-image';

const media = (id: string, width = 800, height = 600): MediaDto => ({
  id,
  url: `https://res.cloudinary.com/demo/image/upload/asra/assessments/${id}.webp`,
  width,
  height,
});

const router = {
  push: () => undefined,
  replace: () => undefined,
  refresh: () => undefined,
  back: () => undefined,
  forward: () => undefined,
  prefetch: () => undefined,
};
const html = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>,
  );

/** A fake encoder whose output size is proportional to pixels × quality. */
function fakeEncoder(bytesPerPixelAtFullQuality: number, options: { webp?: boolean } = {}) {
  const calls: { width: number; height: number; type: string; quality: number }[] = [];
  const encode: Encoder = async (width, height, type, quality) => {
    calls.push({ width, height, type, quality });
    const produced = type === 'image/webp' && options.webp === false ? 'image/png' : type;
    const size = Math.round(width * height * bytesPerPixelAtFullQuality * quality);
    return new Blob([new Uint8Array(size)], { type: produced });
  };
  return { encode, calls };
}

describe('image compression policy', () => {
  it('scales the longest side to 1600 px and never upscales', () => {
    assert.deepEqual(scaledSize(4000, 3000, 1600), { width: 1600, height: 1200 });
    assert.deepEqual(scaledSize(3000, 4000, 1600), { width: 1200, height: 1600 });
    assert.deepEqual(scaledSize(300, 200, 1600), { width: 300, height: 200 });
  });

  it('uploads the first WebP that fits within 100 KB', async () => {
    const { encode, calls } = fakeEncoder(0.04);
    const result = await fitWithinLimit({ width: 4000, height: 3000 }, encode);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.type, 'image/webp');
    assert.ok(result.blob.size <= MEDIA_LIMITS.maxBytes);
    assert.deepEqual([result.width, result.height], [1600, 1200]);
    assert.equal(calls.length, 1, 'no needless re-encoding');
  });

  it('lowers quality, then shrinks, until the image fits', async () => {
    // At 1600×1200 even q=0.5 is too big (≈ 144 KB); shrinking makes it fit.
    const { encode, calls } = fakeEncoder(0.15);
    const result = await fitWithinLimit({ width: 4000, height: 3000 }, encode);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.blob.size <= MEDIA_LIMITS.maxBytes);
    assert.ok(result.width < 1600);
    assert.deepEqual(
      calls.slice(0, QUALITY_STEPS.length).map((c) => c.quality),
      [...QUALITY_STEPS],
      'every quality step is tried at full size first',
    );
  });

  it('refuses (never uploads) an image that cannot fit even at 640 px', async () => {
    const { encode, calls } = fakeEncoder(2);
    const result = await fitWithinLimit({ width: 4000, height: 3000 }, encode);
    assert.deepEqual(result, { ok: false, message: TOO_DETAILED_MESSAGE });
    assert.equal(Math.max(...calls.map((c) => Math.max(c.width, c.height))), 1600);
    assert.equal(Math.min(...calls.map((c) => Math.max(c.width, c.height))), 640);
  });

  it('a small image is never enlarged to the 640 px floor', async () => {
    // 200×100 at ≥ 10 bytes/pixel never fits; it must not be scaled UP to try.
    const { encode, calls } = fakeEncoder(20);
    const result = await fitWithinLimit({ width: 200, height: 100 }, encode);
    assert.equal(result.ok, false);
    assert.ok(calls.every((c) => c.width <= 200 && c.height <= 100));
  });

  it('falls back to JPEG when the browser cannot encode WebP', async () => {
    const { encode, calls } = fakeEncoder(0.04, { webp: false });
    const result = await fitWithinLimit({ width: 1000, height: 800 }, encode);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.type, 'image/jpeg');
    assert.equal(result.blob.type, 'image/jpeg');
    assert.equal(calls.filter((c) => c.type === 'image/webp').length, 1, 'probed once');
  });

  it('reports an unreadable result instead of uploading the wrong format', async () => {
    const encode: Encoder = async () => new Blob([new Uint8Array(10)], { type: 'image/png' });
    const result = await fitWithinLimit({ width: 100, height: 100 }, encode);
    assert.deepEqual(result, { ok: false, message: UNSUPPORTED_MESSAGE });
  });
});

describe('editor image slots', () => {
  const [a, b, c, d] = [media('a'), media('b'), media('c'), media('d')];

  it('adds, replaces in place and removes', () => {
    assert.deepEqual(placeImage([], 0, a, 3), [a]);
    assert.deepEqual(placeImage([a, b], 2, c, 3), [a, b, c]);
    assert.deepEqual(placeImage([a, b, c], 1, d, 3), [a, d, c], 'replace keeps the order');
    assert.deepEqual(placeImage([a, b, c], 3, d, 3), [a, b, c], 'never more than the limit');
    assert.deepEqual(placeImage([a], 0, b, 1), [b], 'option image replaced');
    assert.deepEqual(removeImage([a, b, c], 1), [a, c]);
  });

  it('shows previews with replace/remove and hides "add" at the limit', () => {
    const upload = async () => {
      throw new Error('not called');
    };
    const two = html(
      <ImageSlots
        label="Question image"
        images={[a, b]}
        max={3}
        onChange={() => {}}
        upload={upload}
      />,
    );
    assert.match(two, /Add image \(2\/3\)/);
    assert.match(two, new RegExp(a.url.replaceAll('/', '\\/')));
    assert.match(two, /aria-label="Replace question image 1"/);
    assert.match(two, /aria-label="Remove question image 2"/);
    assert.match(two, /accept="image\/\*"/);

    const full = html(
      <ImageSlots
        label="Question image"
        images={[a, b, c]}
        max={3}
        onChange={() => {}}
        upload={upload}
      />,
    );
    assert.doesNotMatch(full, /Add image/);

    const option = html(
      <ImageSlots
        compact
        label="Image for option B"
        images={[]}
        max={1}
        onChange={() => {}}
        upload={upload}
      />,
    );
    assert.match(option, /aria-label="Add image for option b"/);
  });

  it('sends image ids, keeps True/False options image-free, and validates with the shared schema', () => {
    const body = draftToInput({
      type: 'SINGLE_CHOICE',
      prompt: 'Which graph is linear?',
      explanation: '',
      marks: 2,
      negativeMarks: 0,
      images: [a, b],
      options: [
        { text: '', isCorrect: true, image: c },
        { text: 'None of these', isCorrect: false, image: null },
      ],
    });
    assert.deepEqual(body.imageIds, ['a', 'b']);
    assert.deepEqual(
      body.options.map((o) => o.imageId),
      ['c', null],
    );
    const ids = {
      a: '0b8f6a54-6a0e-4f5e-9d0c-1a2b3c4d5e6f',
      c: '1c9e7b65-7b1f-4a6f-8e1d-2b3c4d5e6f70',
    };
    const valid = questionInputSchema.safeParse({
      ...body,
      imageIds: [ids.a],
      options: [
        { ...body.options[0], imageId: ids.c },
        { ...body.options[1], imageId: null },
      ],
    });
    assert.equal(valid.success, true, JSON.stringify(valid.error?.issues));

    const tf = draftToInput({
      type: 'TRUE_FALSE',
      prompt: 'x',
      explanation: '',
      marks: 1,
      negativeMarks: 0,
      images: [],
      options: [
        { text: 'True', isCorrect: true, image: c },
        { text: 'False', isCorrect: false, image: null },
      ],
    });
    assert.deepEqual(
      tf.options.map((o) => o.imageId),
      [null, null],
    );
    const written = draftToInput({
      type: 'SHORT_ANSWER',
      prompt: 'Describe the diagram',
      explanation: '',
      marks: 5,
      negativeMarks: 0,
      images: [a],
      options: [],
    });
    assert.deepEqual(written.options, []);
    assert.deepEqual(written.imageIds, ['a']);
  });
});

describe('editor option identity and difficulty', () => {
  it('gives every draft option its own key and never sends it', () => {
    const keys = new Set(Array.from({ length: 50 }, () => draftKey()));
    assert.equal(keys.size, 50);
    const body = draftToInput({
      type: 'SINGLE_CHOICE',
      prompt: 'p',
      explanation: '',
      marks: 1,
      negativeMarks: 0,
      images: [],
      options: [
        { key: draftKey(), text: 'a', isCorrect: true, image: null },
        { key: draftKey(), text: 'b', isCorrect: false, image: null },
      ] as never,
    });
    assert.ok(body.options.every((option) => !('key' in option)));
    assert.equal(body.difficulty, null, 'course editors send no difficulty');
    assert.equal(
      draftToInput({ ...body, explanation: '', images: [], options: [], difficulty: 'HARD' })
        .difficulty,
      'HARD',
    );
  });
});

describe('image display', () => {
  it('renders question images with stored dimensions and accessible names; nothing when empty', () => {
    const out = html(<QuestionImages images={[media('q1', 1200, 900), media('q2')]} />);
    assert.match(out, /alt="Question image 1"/);
    assert.match(out, /alt="Question image 2"/);
    assert.match(out, /width="1200"/);
    assert.match(out, /height="900"/);
    assert.match(out, /open larger/);
    assert.doesNotMatch(out, /_next\/image/, 'served directly, not through image optimization');
    assert.match(out, /loading="lazy"/);
    assert.match(
      html(<QuestionImages images={[media('now')]} priority />),
      /loading="eager"/,
      'the question on screen loads first',
    );
    assert.equal(html(<QuestionImages images={[]} />), '');
    assert.equal(html(<OptionImage image={null} index={0} />), '');
    assert.match(html(<OptionImage image={media('o')} index={2} />), /Image for option C/);
    assert.equal(optionLetter(0), 'A');
  });

  const reviewQuestion: ReviewQuestionDto = {
    id: 'q1',
    position: 0,
    type: 'SINGLE_CHOICE',
    prompt: 'Which shape is a square?',
    explanation: null,
    marks: 2,
    negativeMarks: 0,
    images: [media('prompt')],
    options: [
      { id: 'o1', text: '', isCorrect: true, selected: true, image: media('square') },
      { id: 'o2', text: 'A circle', isCorrect: false, selected: false, image: null },
    ],
    textAnswer: null,
    answered: true,
    awardedMarks: 2,
    penalty: 0,
    isCorrect: true,
    feedback: null,
    gradedAt: null,
  };

  it('shows question and picture-only option images in the review', () => {
    const out = html(<ReviewList questions={[reviewQuestion]} />);
    assert.match(out, /prompt\.webp/);
    assert.match(out, /square\.webp/);
    assert.match(out, /Option A \(correct answer\)/, 'picture-only options get a text label');
  });

  it('shows images in the student’s own answers before the key is released', () => {
    const attempt: StudentAttemptDto = {
      id: 'att',
      kind: 'QUIZ',
      assessment: {
        id: 'quiz',
        title: 'Shapes',
        lessonId: 'l1',
        course: { id: 'c1', title: 'Geometry' },
      },
      attemptNumber: 1,
      status: 'SUBMITTED',
      startedAt: '2026-11-02T04:30:00.000Z',
      deadlineAt: null,
      submittedAt: '2026-11-02T04:40:00.000Z',
      serverNow: '2026-11-02T04:41:00.000Z',
      negativeMarking: false,
      maxScore: 2,
      questions: [
        {
          id: 'q1',
          position: 0,
          type: 'SINGLE_CHOICE',
          prompt: 'Which shape is a square?',
          marks: 2,
          negativeMarks: 0,
          images: [media('prompt')],
          options: [
            { id: 'o1', text: '', image: media('square') },
            { id: 'o2', text: 'A circle', image: null },
          ],
          selectedOptionIds: ['o1'],
          textAnswer: null,
          answerSequence: 1,
        },
      ],
      resultState: 'AWAITING_RELEASE',
      result: null,
      review: null,
    };
    const out = html(<AttemptOutcome attempt={attempt} />);
    assert.match(out, /prompt\.webp/);
    assert.match(out, /square\.webp/);
    assert.doesNotMatch(out, /correct answer/);
  });
});
