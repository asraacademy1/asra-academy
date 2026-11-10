import { MEDIA_LIMITS } from '@asra/validation';
import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { assessmentRateLimit } from '../../../middleware/rate-limit.js';
import { sendError, sendSuccess } from '../../../utils/api-response.js';
import { mediaService } from './media.service.js';

/**
 * `POST …/assessment-media` — one optimized image as the raw request body
 * (`Content-Type: image/webp | image/jpeg | image/png`). The SAME handler is mounted in the
 * faculty portal (`content.manage_assigned`) and in administration (`academy_quizzes.manage`);
 * `gate` is that permission check. Uploading only stores an unused file for the caller — what it
 * may be attached to is decided when a question is saved, by the question's own authorization.
 *
 * The body limit is exactly 100 KB: body-parser stops reading as soon as it is exceeded, so an
 * oversized upload is never buffered, and it is answered with a clear 413.
 */
export function assessmentMediaRouter(gate: RequestHandler): Router {
  const router = Router();
  router.post(
    '/assessment-media',
    gate,
    assessmentRateLimit('mediaUpload'),
    express.raw({ limit: MEDIA_LIMITS.maxBytes, type: [...MEDIA_LIMITS.mimeTypes] }),
    async (req: Request, res: Response) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!Buffer.isBuffer(req.body) && req.headers['content-length'] !== '0') {
        sendError(res, 422, 'VALIDATION_ERROR', 'Only WebP, JPEG or PNG images can be uploaded.');
        return;
      }
      const data = await mediaService.upload(req.auth!, body, req.get('content-type'));
      sendSuccess(res, data, 'Image uploaded', 201);
    },
    (error: { type?: string }, _req: Request, res: Response, next: NextFunction) => {
      if (error?.type === 'entity.too.large') {
        sendError(
          res,
          413,
          'BAD_REQUEST',
          `The image is larger than ${MEDIA_LIMITS.maxBytes / 1024} KB. Compress it and try again.`,
        );
        return;
      }
      next(error);
    },
  );
  return router;
}
