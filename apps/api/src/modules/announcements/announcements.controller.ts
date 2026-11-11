import type {
  AdminAnnouncementListQuery,
  AnnouncementCreateInput,
  AnnouncementPriorityInput,
  AnnouncementPublishInput,
  AnnouncementScheduleInput,
  AnnouncementUpdateInput,
  PublicActiveAnnouncementsQuery,
} from '@asra/validation';
import type { Request, Response } from 'express';
import { PUBLIC_ANNOUNCEMENT_CACHE_CONTROL } from '../../config/constants.js';
import { sendSuccess } from '../../utils/api-response.js';
import { computeAnnouncementEtag } from './announcements.cache.js';
import { announcementsService } from './announcements.service.js';

const id = (req: Request) => String(req.params.id);

export const announcementsAdminController = {
  async list(req: Request, res: Response): Promise<void> {
    sendSuccess(
      res,
      await announcementsService.list(req.query as unknown as AdminAnnouncementListQuery),
    );
  },

  async get(req: Request, res: Response): Promise<void> {
    sendSuccess(res, await announcementsService.get(id(req)));
  },

  async create(req: Request, res: Response): Promise<void> {
    const data = await announcementsService.create(req.auth!, req.body as AnnouncementCreateInput);
    sendSuccess(res, data, 'Announcement created', 201);
  },

  async update(req: Request, res: Response): Promise<void> {
    const data = await announcementsService.update(
      req.auth!,
      id(req),
      req.body as AnnouncementUpdateInput,
    );
    sendSuccess(res, data, 'Announcement updated');
  },

  async updatePriority(req: Request, res: Response): Promise<void> {
    const data = await announcementsService.updatePriority(
      req.auth!,
      id(req),
      req.body as AnnouncementPriorityInput,
    );
    sendSuccess(res, data, 'Announcement priority updated');
  },

  async publish(req: Request, res: Response): Promise<void> {
    const data = await announcementsService.publish(
      req.auth!,
      id(req),
      (req.body as AnnouncementPublishInput | undefined) ?? {},
    );
    sendSuccess(
      res,
      data,
      data.status === 'SCHEDULED' ? 'Announcement scheduled' : 'Announcement published',
    );
  },

  async schedule(req: Request, res: Response): Promise<void> {
    const data = await announcementsService.schedule(
      req.auth!,
      id(req),
      (req.body as AnnouncementScheduleInput | undefined) ?? {},
    );
    sendSuccess(res, data, 'Announcement scheduled');
  },

  async pause(req: Request, res: Response): Promise<void> {
    const data = await announcementsService.pause(req.auth!, id(req));
    sendSuccess(res, data, 'Announcement paused');
  },

  async resume(req: Request, res: Response): Promise<void> {
    const data = await announcementsService.resume(req.auth!, id(req));
    sendSuccess(res, data, 'Announcement resumed');
  },

  async archive(req: Request, res: Response): Promise<void> {
    const data = await announcementsService.archive(req.auth!, id(req));
    sendSuccess(res, data, 'Announcement archived');
  },

  async restore(req: Request, res: Response): Promise<void> {
    const data = await announcementsService.restore(req.auth!, id(req));
    sendSuccess(res, data, 'Announcement restored to draft');
  },

  async remove(req: Request, res: Response): Promise<void> {
    await announcementsService.remove(req.auth!, id(req));
    sendSuccess(res, null, 'Announcement deleted');
  },
};

export const publicAnnouncementsController = {
  async listActive(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as PublicActiveAnnouncementsQuery;
    const items = await announcementsService.listActive(query);
    const etag = computeAnnouncementEtag(items);
    res.setHeader('Cache-Control', PUBLIC_ANNOUNCEMENT_CACHE_CONTROL);
    res.setHeader('ETag', etag);

    const ifNoneMatch = req.headers['if-none-match'];
    if (
      ifNoneMatch &&
      ifNoneMatch
        .split(',')
        .map((v) => v.trim())
        .includes(etag)
    ) {
      res.status(304).end();
      return;
    }

    sendSuccess(res, items);
  },
};
