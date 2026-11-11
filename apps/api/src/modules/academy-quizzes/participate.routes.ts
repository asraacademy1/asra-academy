import {
  academyQuizRegisterSchema,
  academySlugParamsSchema,
  paginationQuerySchema,
  publicParticipateQuizzesQuerySchema,
  type PaginationQuery,
  type PublicParticipateQuizzesQuery,
} from '@asra/validation';
import { Router, type Request, type Response } from 'express';
import { SITEMAP_FEED_CACHE_CONTROL } from '../../config/constants.js';
import { authenticate } from '../../middleware/authenticate.js';
import { assessmentRateLimit } from '../../middleware/rate-limit.js';
import { validateRequest } from '../../middleware/validate-request.js';
import { sendSuccess } from '../../utils/api-response.js';
import { publicParticipateService } from './participate.service.js';

/**
 * `/api/v1/participate/*` — public discovery & verified registration for Academy activities.
 * Read endpoints return only publicly visible published records and keep `no-store` so
 * live/closed/private changes appear immediately. Registration routes require `authenticate`.
 */
export const publicParticipateRouter = Router();
const r = publicParticipateRouter;

const bySlug = validateRequest({ params: academySlugParamsSchema });
const slug = (req: Request) => String(req.params.slug);
const registerLimit = assessmentRateLimit('attemptStart');

r.get('/summary', async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  sendSuccess(res, await publicParticipateService.summary());
});

r.get('/activities', async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  sendSuccess(res, await publicParticipateService.activities());
});

r.get(
  '/quizzes',
  validateRequest({ query: publicParticipateQuizzesQuerySchema }),
  async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const query = req.query as unknown as PublicParticipateQuizzesQuery;
    sendSuccess(res, await publicParticipateService.listQuizzes(query));
  },
);

r.get('/quizzes/:slug', bySlug, async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  sendSuccess(res, await publicParticipateService.quizDetail(slug(req)));
});

r.get(
  '/competitions',
  validateRequest({ query: paginationQuerySchema }),
  async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const query = req.query as unknown as PaginationQuery;
    sendSuccess(res, await publicParticipateService.listCompetitions(query));
  },
);

r.get(
  '/assessments',
  validateRequest({ query: paginationQuerySchema }),
  async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const query = req.query as unknown as PaginationQuery;
    sendSuccess(res, await publicParticipateService.listAssessments(query));
  },
);

r.get(
  '/quizzes/:slug/registration',
  authenticate,
  (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  },
  bySlug,
  async (req: Request, res: Response) => {
    sendSuccess(res, await publicParticipateService.registrationStatus(req.auth!, slug(req)));
  },
);

r.post(
  '/quizzes/:slug/register',
  authenticate,
  (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  },
  registerLimit,
  validateRequest({ params: academySlugParamsSchema, body: academyQuizRegisterSchema }),
  async (req: Request, res: Response) => {
    const result = await publicParticipateService.register(req.auth!, slug(req));
    sendSuccess(res, result, 'Registered for quiz', 201);
  },
);

export const publicQuizzesSitemapHandler = async (_req: Request, res: Response) => {
  const entries = await publicParticipateService.sitemapQuizzes();
  res.setHeader('Cache-Control', SITEMAP_FEED_CACHE_CONTROL);
  sendSuccess(res, entries);
};
