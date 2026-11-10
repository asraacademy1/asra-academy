import { PERMISSIONS } from '@asra/types';
import {
  academyAttemptAdvanceSchema,
  academyAttemptStartSchema,
  academySlugParamsSchema,
  answerSaveSchema,
  attemptSubmitSchema,
  leaderboardQuerySchema,
  paginationQuerySchema,
  studentAcademyQuizListQuerySchema,
  type AcademyAttemptAdvanceInput,
  type AnswerSaveInput,
  type LeaderboardQuery,
  type PaginationQuery,
  type StudentAcademyQuizListQuery,
} from '@asra/validation';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { assessmentRateLimit } from '../../middleware/rate-limit.js';
import { validateRequest } from '../../middleware/validate-request.js';
import { sendSuccess } from '../../utils/api-response.js';
import { idParamsSchema } from '../../validators/common.validators.js';
import { academyResultsService as results } from './results.service.js';
import {
  studentAcademyAttemptService as attempts,
  studentAcademyQuizService as quizzes,
} from './student.service.js';

/**
 * `/api/v1/student/academy-quizzes/*` and `/api/v1/student/academy-attempts/*`, mounted in the
 * student router (authenticated, STUDENT role, `no-store`). Every route also requires
 * `academy_quizzes.participate`. No course enrolment is involved. Bodies are strict: no time,
 * score, correctness or fullscreen state can be posted.
 */
export const studentAcademyQuizzesRouter = Router();
const r = studentAcademyQuizzesRouter;

const participate = requirePermission(PERMISSIONS.ACADEMY_QUIZZES_PARTICIPATE);
const startLimit = assessmentRateLimit('attemptStart');
const answerLimit = assessmentRateLimit('answerSave');
const submitLimit = assessmentRateLimit('attemptSubmit');
const bySlug = validateRequest({ params: academySlugParamsSchema });
const byId = validateRequest({ params: idParamsSchema });
const slug = (req: Request) => String(req.params.slug);
const id = (req: Request) => String(req.params.id);

r.get(
  '/academy-quizzes',
  participate,
  validateRequest({ query: studentAcademyQuizListQuerySchema }),
  async (req: Request, res: Response) => {
    const query = req.query as unknown as StudentAcademyQuizListQuery;
    sendSuccess(res, await quizzes.list(req.auth!, query));
  },
);

r.get('/academy-quizzes/:slug', participate, bySlug, async (req: Request, res: Response) => {
  sendSuccess(res, await quizzes.detail(req.auth!, slug(req)));
});

r.post(
  '/academy-quizzes/:slug/attempts',
  participate,
  startLimit,
  validateRequest({ params: academySlugParamsSchema, body: academyAttemptStartSchema }),
  async (req: Request, res: Response) => {
    const started = await quizzes.start(req.auth!, slug(req));
    sendSuccess(
      res,
      started,
      started.resumed ? 'Attempt resumed' : 'Attempt started',
      started.resumed ? 200 : 201,
    );
  },
);

r.get('/academy-attempts/:id', participate, byId, async (req: Request, res: Response) => {
  sendSuccess(res, await attempts.get(req.auth!, id(req)));
});

r.put(
  '/academy-attempts/:id/answers/:questionId',
  participate,
  answerLimit,
  validateRequest({
    params: z.object({ id: z.uuid(), questionId: z.uuid() }),
    body: answerSaveSchema,
  }),
  async (req: Request, res: Response) => {
    const data = await attempts.saveAnswer(
      req.auth!,
      id(req),
      String(req.params.questionId),
      req.body as AnswerSaveInput,
    );
    sendSuccess(res, data, data.applied ? 'Answer saved' : 'A newer answer was already saved');
  },
);

r.post(
  '/academy-attempts/:id/advance',
  participate,
  answerLimit,
  validateRequest({ params: idParamsSchema, body: academyAttemptAdvanceSchema }),
  async (req: Request, res: Response) => {
    const data = await attempts.advance(req.auth!, id(req), req.body as AcademyAttemptAdvanceInput);
    sendSuccess(res, data);
  },
);

r.post(
  '/academy-attempts/:id/submit',
  participate,
  submitLimit,
  validateRequest({ params: idParamsSchema, body: attemptSubmitSchema.optional() }),
  async (req: Request, res: Response) => {
    const { outcome, attempt } = await attempts.submit(req.auth!, id(req));
    const message =
      outcome === 'expired'
        ? 'Time was up; your saved answers were submitted'
        : outcome === 'already_final'
          ? 'This attempt was already submitted'
          : 'Attempt submitted';
    sendSuccess(res, attempt, message);
  },
);

r.get(
  '/academy-quizzes/:slug/leaderboard',
  participate,
  validateRequest({ params: academySlugParamsSchema, query: leaderboardQuerySchema }),
  async (req: Request, res: Response) => {
    const query = req.query as unknown as LeaderboardQuery;
    sendSuccess(res, await results.studentLeaderboard(req.auth!, slug(req), query));
  },
);

r.get(
  '/academy-results',
  participate,
  validateRequest({ query: paginationQuerySchema }),
  async (req: Request, res: Response) => {
    const query = req.query as unknown as PaginationQuery;
    sendSuccess(res, await results.studentResults(req.auth!, query));
  },
);
