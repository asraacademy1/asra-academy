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
  quizCertificateBatchItemsQuerySchema,
  quizCertificateEligibleQuerySchema,
  quizCertificateIssuanceRequestSchema,
  quizCertificateRetrySchema,
  quizCertificateSamplePreviewSchema,
  quizIssuedCertificatesQuerySchema,
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
  type QuizCertificateBatchItemsQuery,
  type QuizCertificateEligibleQuery,
  type QuizCertificateIssuanceRequestInput,
  type QuizCertificateRetryInput,
  type QuizCertificateSamplePreviewInput,
  type QuizIssuedCertificatesQuery,
} from '@asra/validation';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  requireAnyPermission,
  requirePermission,
  requireRole,
} from '../../middleware/authorize.js';
import { validateRequest } from '../../middleware/validate-request.js';
import { sendSuccess } from '../../utils/api-response.js';
import { idParamsSchema } from '../../validators/common.validators.js';
import { academyQuizAdminService as quizzes } from './academy-quizzes.service.js';
import { academyCopyService as copies } from './copy.service.js';
import { academyParticipantsService as participants } from './participants.service.js';
import { quizCertificatesService as quizCertificates } from './quiz-certificates.service.js';
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

// --- Quiz Certificate Generation & Bulk Issuance (ADMIN / SUPER_ADMIN only) -----------------

const adminOnly = requireRole('ADMIN', 'SUPER_ADMIN');
const canViewQuizCertificates = requireAnyPermission(
  PERMISSIONS.CERTIFICATES_VIEW,
  PERMISSIONS.CERTIFICATES_ISSUE,
  PERMISSIONS.CERTIFICATES_MANAGE,
);
const canIssueQuizCertificates = requireAnyPermission(
  PERMISSIONS.CERTIFICATES_ISSUE,
  PERMISSIONS.CERTIFICATES_MANAGE,
);
const batchParamsSchema = idParamsSchema.extend({ batchId: z.uuid() });

r.get(
  '/academy-quizzes/:id/certificates/summary',
  adminOnly,
  manage,
  canViewQuizCertificates,
  byId,
  async (req: Request, res: Response) => {
    sendSuccess(res, await quizCertificates.getSummary(id(req)));
  },
);

r.get(
  '/academy-quizzes/:id/certificates/eligible',
  adminOnly,
  manage,
  canViewQuizCertificates,
  validateRequest({ params: idParamsSchema, query: quizCertificateEligibleQuerySchema }),
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await quizCertificates.listEligible(
        id(req),
        req.query as unknown as QuizCertificateEligibleQuery,
      ),
    );
  },
);

r.post(
  '/academy-quizzes/:id/certificates/preview',
  adminOnly,
  manage,
  canIssueQuizCertificates,
  withBody(quizCertificateIssuanceRequestSchema),
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await quizCertificates.previewIssuance(
        id(req),
        req.body as QuizCertificateIssuanceRequestInput,
      ),
    );
  },
);

const samplePreviewQuerySchema = z.object({
  templateId: z.uuid(),
  rank: z.coerce.number().int().min(1).max(1000).optional(),
  category: z.enum(['PARTICIPATION', 'RANK']).default('PARTICIPATION'),
  format: z.enum(['pdf', 'png']).default('pdf'),
});

r.get(
  '/academy-quizzes/:id/certificates/sample-preview',
  adminOnly,
  manage,
  canViewQuizCertificates,
  validateRequest({ params: idParamsSchema, query: samplePreviewQuerySchema }),
  async (req: Request, res: Response) => {
    const q = req.query as unknown as z.infer<typeof samplePreviewQuerySchema>;
    const doc = await quizCertificates.generateSamplePreview(id(req), {
      templateId: q.templateId,
      rank: q.rank ?? null,
      category: q.category,
      format: q.format,
    });
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
    res.setHeader('Content-Length', doc.buffer.length);
    res.setHeader('Cache-Control', 'no-store');
    res.send(doc.buffer);
  },
);

r.post(
  '/academy-quizzes/:id/certificates/sample-preview',
  adminOnly,
  manage,
  canViewQuizCertificates,
  withBody(quizCertificateSamplePreviewSchema),
  async (req: Request, res: Response) => {
    const doc = await quizCertificates.generateSamplePreview(
      id(req),
      req.body as QuizCertificateSamplePreviewInput,
    );
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
    res.setHeader('Content-Length', doc.buffer.length);
    res.setHeader('Cache-Control', 'no-store');
    res.send(doc.buffer);
  },
);

r.post(
  '/academy-quizzes/:id/certificates/issue',
  adminOnly,
  manage,
  canIssueQuizCertificates,
  withBody(quizCertificateIssuanceRequestSchema),
  async (req: Request, res: Response) => {
    const detail = await quizCertificates.startBulkIssuance(
      req.auth!,
      id(req),
      req.body as QuizCertificateIssuanceRequestInput,
    );
    sendSuccess(res, detail, 'Bulk certificate issuance started', 202);
  },
);

r.get(
  '/academy-quizzes/:id/certificates/batches',
  adminOnly,
  manage,
  canViewQuizCertificates,
  byId,
  async (req: Request, res: Response) => {
    sendSuccess(res, await quizCertificates.listBatches(id(req)));
  },
);

r.get(
  '/academy-quizzes/:id/certificates/batches/:batchId',
  adminOnly,
  manage,
  canViewQuizCertificates,
  validateRequest({ params: batchParamsSchema, query: quizCertificateBatchItemsQuerySchema }),
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await quizCertificates.getBatchDetail(
        id(req),
        String(req.params.batchId),
        req.query as unknown as QuizCertificateBatchItemsQuery,
      ),
    );
  },
);

r.post(
  '/academy-quizzes/:id/certificates/batches/:batchId/retry',
  adminOnly,
  manage,
  canIssueQuizCertificates,
  validateRequest({ params: batchParamsSchema, body: quizCertificateRetrySchema }),
  async (req: Request, res: Response) => {
    const detail = await quizCertificates.retryBatch(
      req.auth!,
      id(req),
      String(req.params.batchId),
      req.body as QuizCertificateRetryInput,
    );
    sendSuccess(res, detail, 'Retry queued', 202);
  },
);

r.get(
  '/academy-quizzes/:id/certificates/issued',
  adminOnly,
  manage,
  canViewQuizCertificates,
  validateRequest({ params: idParamsSchema, query: quizIssuedCertificatesQuerySchema }),
  async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await quizCertificates.listIssuedCertificates(
        id(req),
        req.query as unknown as QuizIssuedCertificatesQuery,
      ),
    );
  },
);
