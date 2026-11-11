import type { Request, Response } from 'express';
import type { AdminApplicationQuery, AdminJobQuery, PublicJobQuery } from '@asra/validation';
import { logger } from '../../lib/logger.js';
import { sendSuccess } from '../../utils/api-response.js';
import { AppError } from '../../utils/app-error.js';
import { recruitmentService } from './recruitment.service.js';
import { resumeStorageService } from './resume-storage.service.js';

export const recruitmentController = {
  // ===========================================================================
  // PUBLIC CONTROLLER ACTIONS
  // ===========================================================================

  async getPublicCategories(_req: Request, res: Response) {
    const data = await recruitmentService.getPublicCategories();
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=120');
    return sendSuccess(res, data, 'Career categories retrieved successfully');
  },

  async listPublicJobs(req: Request, res: Response) {
    const data = await recruitmentService.listPublicJobs(req.query as unknown as PublicJobQuery);
    return sendSuccess(res, data);
  },

  async getPublicJob(req: Request, res: Response) {
    const jobId = req.params.jobId as string;
    const data = await recruitmentService.getPublicJobByIdOrSlug(jobId);
    return sendSuccess(res, data);
  },

  async submitApplication(req: Request, res: Response) {
    const jobId = req.params.jobId as string;
    const data = await recruitmentService.submitPublicApplication(jobId, req.body);
    return sendSuccess(res, data, 'Your application has been successfully submitted', 201);
  },

  async uploadResume(req: Request, res: Response) {
    let fileBuffer: Buffer | null = null;
    let fileName = 'resume.pdf';

    // Support multipart/form-data
    if (req.is('multipart/form-data')) {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const fullBody = Buffer.concat(chunks);

        const nodeReq = new globalThis.Request('http://localhost/upload', {
          method: 'POST',
          headers: {
            'content-type': req.headers['content-type'] || '',
          },
          body: fullBody,
        });

        const formData = await nodeReq.formData();
        const fileEntry = formData.get('file') || formData.get('resume');

        if (!fileEntry || typeof fileEntry === 'string') {
          throw new AppError(
            'VALIDATION_ERROR',
            'No file uploaded in form data under field "file" or "resume"',
          );
        }

        const fileObj = fileEntry as File;
        fileName = fileObj.name || 'resume.pdf';
        const arrayBuf = await fileObj.arrayBuffer();
        fileBuffer = Buffer.from(arrayBuf);
      } catch (err: unknown) {
        if (err instanceof AppError) throw err;
        throw new AppError('VALIDATION_ERROR', 'Failed to process multipart upload');
      }
    }
    // Support JSON with fileBase64
    else if (req.body && req.body.fileBase64) {
      fileName = req.body.fileName || 'resume.pdf';
      try {
        // Strip data:application/pdf;base64, prefix if included
        const base64Data = req.body.fileBase64.replace(/^data:application\/pdf;base64,/, '');
        fileBuffer = Buffer.from(base64Data, 'base64');
      } catch {
        throw new AppError('VALIDATION_ERROR', 'Invalid base64 encoded resume file data');
      }
    }
    // Support raw octet-stream / application/pdf body
    else if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      fileBuffer = req.body;
      const headerName = req.headers['x-file-name'];
      if (typeof headerName === 'string') {
        fileName = decodeURIComponent(headerName);
      }
    } else {
      throw new AppError(
        'VALIDATION_ERROR',
        'No file provided. Submit a multipart form with "file" or JSON with "fileBase64" and "fileName"',
      );
    }

    const result = await resumeStorageService.storeResume(fileBuffer, fileName);
    const responseData = {
      ...result,
      resumeAssetId: result.assetId,
      resumeFileName: result.originalName,
      resumeFileSize: result.fileSize,
    };
    return sendSuccess(res, responseData, 'Resume uploaded successfully', 201);
  },

  // ===========================================================================
  // ADMIN RECRUITMENT CONTROLLER ACTIONS
  // ===========================================================================

  async getStats(_req: Request, res: Response) {
    const data = await recruitmentService.getRecruitmentStats();
    return sendSuccess(res, data);
  },

  async listAdminJobs(req: Request, res: Response) {
    const data = await recruitmentService.listAdminJobs(req.query as unknown as AdminJobQuery);
    return sendSuccess(res, data);
  },

  async getAdminJob(req: Request, res: Response) {
    const id = req.params.id as string;
    const data = await recruitmentService.getAdminJobById(id);
    return sendSuccess(res, data);
  },

  async createJob(req: Request, res: Response) {
    const adminId = req.auth!.userId;
    const data = await recruitmentService.createJob(adminId, req.body);
    return sendSuccess(res, data, 'Job created successfully', 201);
  },

  async updateJob(req: Request, res: Response) {
    const adminId = req.auth!.userId;
    const id = req.params.id as string;
    const data = await recruitmentService.updateJob(adminId, id, req.body);
    return sendSuccess(res, data, 'Job updated successfully');
  },

  async publishJob(req: Request, res: Response) {
    const adminId = req.auth!.userId;
    const id = req.params.id as string;
    const data = await recruitmentService.publishJob(adminId, id);
    return sendSuccess(res, data, 'Job published successfully');
  },

  async unpublishJob(req: Request, res: Response) {
    const adminId = req.auth!.userId;
    const id = req.params.id as string;
    const data = await recruitmentService.unpublishJob(adminId, id);
    return sendSuccess(res, data, 'Job unpublished successfully');
  },

  async archiveJob(req: Request, res: Response) {
    const adminId = req.auth!.userId;
    const id = req.params.id as string;
    const data = await recruitmentService.archiveJob(adminId, id);
    return sendSuccess(res, data, 'Job archived successfully');
  },

  async deleteJob(req: Request, res: Response) {
    const adminId = req.auth!.userId;
    const id = req.params.id as string;
    const data = await recruitmentService.deleteJob(adminId, id);
    return sendSuccess(res, data, 'Job deleted successfully');
  },

  async listAdminApplications(req: Request, res: Response) {
    const data = await recruitmentService.listAdminApplications(
      req.query as unknown as AdminApplicationQuery,
    );
    return sendSuccess(res, data);
  },

  async getAdminApplication(req: Request, res: Response) {
    const id = req.params.id as string;
    const data = await recruitmentService.getAdminApplicationById(id);
    return sendSuccess(res, data);
  },

  async updateApplicationStatus(req: Request, res: Response) {
    const adminId = req.auth!.userId;
    const id = req.params.id as string;
    const data = await recruitmentService.updateApplicationStatus(adminId, id, req.body);
    return sendSuccess(res, data, 'Application status updated successfully');
  },

  async scheduleInterview(req: Request, res: Response) {
    const adminId = req.auth!.userId;
    const id = req.params.id as string;
    const data = await recruitmentService.scheduleInterview(adminId, id, req.body);
    return sendSuccess(res, data, 'Interview scheduled successfully', 201);
  },

  async rescheduleInterview(req: Request, res: Response) {
    const adminId = req.auth!.userId;
    const interviewId = req.params.interviewId as string;
    const data = await recruitmentService.rescheduleInterview(adminId, interviewId, req.body);
    return sendSuccess(res, data, 'Interview rescheduled successfully');
  },

  async cancelInterview(req: Request, res: Response) {
    const adminId = req.auth!.userId;
    const interviewId = req.params.interviewId as string;
    const data = await recruitmentService.cancelInterview(adminId, interviewId, req.body);
    return sendSuccess(res, data, 'Interview cancelled successfully');
  },

  async addNote(req: Request, res: Response) {
    const adminId = req.auth!.userId;
    const id = req.params.id as string;
    const data = await recruitmentService.addApplicationNote(adminId, id, req.body.note);
    return sendSuccess(res, data, 'Internal note added successfully', 201);
  },

  async sendEmail(req: Request, res: Response) {
    const adminId = req.auth!.userId;
    const id = req.params.id as string;
    const data = await recruitmentService.sendApplicationEmail(adminId, id, req.body);
    return sendSuccess(res, data, 'Recruitment email sent successfully');
  },

  async downloadResume(req: Request, res: Response) {
    const adminId = req.auth!.userId;
    const id = req.params.id as string;
    const { stream, originalName, fileSize } = await recruitmentService.getResumeStream(
      adminId,
      id,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${originalName}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store');
    if (fileSize > 0) {
      res.setHeader('Content-Length', String(fileSize));
    }

    stream.on('error', (err) => {
      logger.error({ err, applicationId: id }, 'Failed while streaming resume response');
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          message: 'Failed to stream resume file',
          error: { code: 'SERVICE_UNAVAILABLE' },
        });
      } else {
        res.destroy(err);
      }
    });

    stream.pipe(res);
  },
};
