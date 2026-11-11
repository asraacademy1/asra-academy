import { PERMISSIONS } from '@asra/types';
import {
  COPY_SOURCE_KINDS,
  academyQuizCreateSchema,
  academyQuizListQuerySchema,
  academyQuizPatchSchema,
  academyQuizTransitionSchema,
  adminAcademyAttemptListQuerySchema,
  adminAcademyParticipantsExportQuerySchema,
  adminAcademyParticipantsQuerySchema,
  copyQuestionsSchema,
  copySourceListQuerySchema,
  questionInputSchema,
  questionOrderSchema,
  type AcademyQuizCreateInput,
  type AcademyQuizListQuery,
  type AcademyQuizPatchInput,
  type AcademyQuizTransition,
  type AdminAcademyAttemptListQuery,
  type AdminAcademyParticipantsExportQuery,
  type AdminAcademyParticipantsQuery,
  type CopyQuestionsInput,
  type CopySourceKind,
  type CopySourceListQuery,
  type QuestionInput,
  type QuestionOrderInput,
} from '@asra/validation';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize.js';
import { validateRequest } from '../../middleware/validate-request.js';
import { sendSuccess } from '../../utils/api-response.js';
import { idParamsSchema } from '../../validators/common.validators.js';
import { academyQuizAdminService as quizzes } from './academy-quizzes.service.js';
import { academyCopyService as copies } from './copy.service.js';
import { academyParticipantsService as participants } from './participants.service.js';
import { academyResultsService as results } from './results.service.js';

/**
 * `/api/v1/admin/academy-quizzes/*` and `/api/v1/admin/academy-quiz-questions/*`, mounted in the
 * admin router (authenticated, `no-store`). EVERY route requires `academy_quizzes.manage`
 * (Admin, Super Admin). Faculty do not hold it, and the faculty portal cannot reach academy
 * questions (questions.service scopes them). Course sources for copying additionally require
 * `content.manage` (checked in copy.service).
 */
export const academyQuizzesAdminRouter = Router();
const r = academyQuizzesAdminRouter;

const manage = requirePermission(PERMISSIONS.ACADEMY_QUIZZES_MANAGE);
const id = (req: Request) => String(req.params.id);
const byId = validateRequest({ params: idParamsSchema });
const withBody = (body: z.ZodType) => validateRequest({ params: idParamsSchema, body });

r.get(
  '/academy-quizzes',
  manage,
  validateRequest({ query: academyQuizListQuerySchema }),
  async (req: Request, res: Response) => {
    sendSuccess(res, await quizzes.list(req.query as unknown as AcademyQuizListQuery));
  },
);

r.post(
  '/academy-quizzes',
  manage,
  validateRequest({ body: academyQuizCreateSchema }),
  async (req: Request, res: Response) => {
    const data = await quizzes.create(req.auth!, req.body as AcademyQuizCreateInput);
    sendSuccess(res, data, 'Academy quiz created', 201);
  },
);

r.get('/academy-quizzes/:id', manage, byId, async (req: Request, res: Response) => {
  sendSuccess(res, await quizzes.detail(id(req)));
});

r.patch(
  '/academy-quizzes/:id',
  manage,
  withBody(academyQuizPatchSchema),
  async (req: Request, res: Response) => {
    const data = await quizzes.update(req.auth!, id(req), req.body as AcademyQuizPatchInput);
    sendSuccess(res, data, 'Academy quiz saved');
  },
);

r.delete('/academy-quizzes/:id', manage, byId, async (req: Request, res: Response) => {
  await quizzes.remove(req.auth!, id(req));
  sendSuccess(res, null, 'Academy quiz deleted');
});

r.post(
  '/academy-quizzes/:id/status',
  manage,
  withBody(academyQuizTransitionSchema),
  async (req: Request, res: Response) => {
    const { action } = req.body as { action: AcademyQuizTransition };
    sendSuccess(res, await quizzes.transition(req.auth!, id(req), action), 'Quiz status updated');
  },
);

r.post(
  '/academy-quizzes/:id/publish-results',
  manage,
  byId,
  async (req: Request, res: Response) => {
    const { published, quiz } = await quizzes.publishResults(req.auth!, id(req));
    sendSuccess(res, quiz, published ? 'Results published' : 'Results were already published');
  },
);

// --- Questions (shared authoring and media) ------------------------------------------------

r.post(
  '/academy-quizzes/:id/questions',
  manage,
  withBody(questionInputSchema),
  async (req: Request, res: Response) => {
    const data = await quizzes.addQuestion(req.auth!, id(req), req.body as QuestionInput);
    sendSuccess(res, data, 'Question added', 201);
  },
);

r.put(
  '/academy-quizzes/:id/question-order',
  manage,
  withBody(questionOrderSchema),
  async (req: Request, res: Response) => {
    const data = await quizzes.reorderQuestions(id(req), req.body as QuestionOrderInput);
    sendSuccess(res, data, 'Questions reordered');
  },
);

r.patch(
  '/academy-quiz-questions/:id',
  manage,
  withBody(questionInputSchema),
  async (req: Request, res: Response) => {
    const data = await quizzes.updateQuestion(req.auth!, id(req), req.body as QuestionInput);
    sendSuccess(res, data, 'Question saved');
  },
);

r.delete('/academy-quiz-questions/:id', manage, byId, async (req: Request, res: Response) => {
  await quizzes.removeQuestion(req.auth!, id(req));
  sendSuccess(res, null, 'Question removed');
});

// --- Copying questions ---------------------------------------------------------------------

r.get(
  '/academy-quizzes/:id/copy-sources',
  manage,
  validateRequest({ params: idParamsSchema, query: copySourceListQuerySchema }),
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await copies.sources(req.auth!, id(req), req.query as unknown as CopySourceListQuery),
    );
  },
);

r.get(
  '/academy-quizzes/:id/copy-sources/:kind/:sourceId/questions',
  manage,
  validateRequest({
    params: idParamsSchema.extend({ kind: z.enum(COPY_SOURCE_KINDS), sourceId: z.uuid() }),
  }),
  async (req: Request, res: Response) => {
    const kind = String(req.params.kind) as CopySourceKind;
    sendSuccess(res, await copies.sourceQuestions(req.auth!, kind, String(req.params.sourceId)));
  },
);

r.post(
  '/academy-quizzes/:id/questions/copy',
  manage,
  withBody(copyQuestionsSchema),
  async (req: Request, res: Response) => {
    const data = await copies.copy(req.auth!, id(req), req.body as CopyQuestionsInput);
    sendSuccess(res, data, `${data.copied} question${data.copied === 1 ? '' : 's'} copied`, 201);
  },
);

// --- Attempts and leaderboard (managers) ---------------------------------------------------

r.get(
  '/academy-quizzes/:id/attempts',
  manage,
  validateRequest({ params: idParamsSchema, query: adminAcademyAttemptListQuerySchema }),
  async (req: Request, res: Response) => {
    const query = req.query as unknown as AdminAcademyAttemptListQuery;
    sendSuccess(res, await results.adminAttempts(id(req), query));
  },
);

r.get('/academy-quizzes/:id/leaderboard', manage, byId, async (req: Request, res: Response) => {
  sendSuccess(res, await results.adminLeaderboard(id(req)));
});

r.get('/academy-attempts/:id', manage, byId, async (req: Request, res: Response) => {
  sendSuccess(res, await results.adminAttempt(id(req)));
});

// --- Participants (registrations, managers) -----------------------------------------------

r.get(
  '/academy-quizzes/:id/participants',
  manage,
  validateRequest({ params: idParamsSchema, query: adminAcademyParticipantsQuerySchema }),
  async (req: Request, res: Response) => {
    const query = req.query as unknown as AdminAcademyParticipantsQuery;
    sendSuccess(res, await participants.list(id(req), query));
  },
);

r.get(
  '/academy-quizzes/:id/participants/export',
  manage,
  validateRequest({ params: idParamsSchema, query: adminAcademyParticipantsExportQuerySchema }),
  async (req: Request, res: Response) => {
    const query = req.query as unknown as AdminAcademyParticipantsExportQuery;
    const { filename, csv } = await participants.exportCsv(id(req), query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(csv);
  },
);
