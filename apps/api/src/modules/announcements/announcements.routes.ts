import { PERMISSIONS } from '@asra/types';
import {
  adminAnnouncementListQuerySchema,
  announcementCreateSchema,
  announcementPrioritySchema,
  announcementPublishSchema,
  announcementScheduleSchema,
  announcementUpdateSchema,
  publicActiveAnnouncementsQuerySchema,
} from '@asra/validation';
import { Router } from 'express';
import { requirePermission } from '../../middleware/authorize.js';
import { validateRequest } from '../../middleware/validate-request.js';
import { idParamsSchema } from '../../validators/common.validators.js';
import {
  announcementsAdminController as admin,
  publicAnnouncementsController as pub,
} from './announcements.controller.js';

/**
 * `/api/v1/announcements/*` — public active campaigns only (never exposes unpublished rows).
 */
export const publicAnnouncementsRouter = Router();

publicAnnouncementsRouter.get(
  '/active',
  validateRequest({ query: publicActiveAnnouncementsQuerySchema }),
  pub.listActive,
);

/**
 * `/api/v1/admin/announcements/*` — mounted inside the authenticated `adminRouter`
 * (`Cache-Control: no-store`). Every route requires `announcements.manage`.
 */
export const announcementsAdminRouter = Router();

const manage = requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE);
const byId = validateRequest({ params: idParamsSchema });

announcementsAdminRouter.get(
  '/announcements',
  manage,
  validateRequest({ query: adminAnnouncementListQuerySchema }),
  admin.list,
);
announcementsAdminRouter.post(
  '/announcements',
  manage,
  validateRequest({ body: announcementCreateSchema }),
  admin.create,
);
announcementsAdminRouter.get('/announcements/:id', manage, byId, admin.get);
announcementsAdminRouter.patch(
  '/announcements/:id',
  manage,
  validateRequest({ params: idParamsSchema, body: announcementUpdateSchema }),
  admin.update,
);
announcementsAdminRouter.patch(
  '/announcements/:id/priority',
  manage,
  validateRequest({ params: idParamsSchema, body: announcementPrioritySchema }),
  admin.updatePriority,
);
announcementsAdminRouter.post(
  '/announcements/:id/publish',
  manage,
  validateRequest({ params: idParamsSchema, body: announcementPublishSchema.optional() }),
  admin.publish,
);
announcementsAdminRouter.post(
  '/announcements/:id/schedule',
  manage,
  validateRequest({ params: idParamsSchema, body: announcementScheduleSchema.optional() }),
  admin.schedule,
);
announcementsAdminRouter.post('/announcements/:id/pause', manage, byId, admin.pause);
announcementsAdminRouter.post('/announcements/:id/resume', manage, byId, admin.resume);
announcementsAdminRouter.post('/announcements/:id/archive', manage, byId, admin.archive);
announcementsAdminRouter.post('/announcements/:id/restore', manage, byId, admin.restore);
announcementsAdminRouter.delete('/announcements/:id', manage, byId, admin.remove);
