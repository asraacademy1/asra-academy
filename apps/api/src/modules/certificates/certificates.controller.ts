import {
  CERTIFICATE_SIGNATURE_LIMITS,
  createCertificateSignatureSchema,
  updateCertificateSignatureSchema,
  type AdminCertificateQuery,
  type AdminRevokeCertificateInput,
  type CertificateAuditQuery,
  type CertificateDownloadFormat,
  type CertificateDownloadQuery,
  type CertificateSignatureQuery,
  type CertificateStudentSearchQuery,
  type CertificateVerifyParams,
  type GenericCertificateIssueInput,
  type ManualCertificateIssueInput,
  type ReissueCertificateInput,
  type StudentCertificateQuery,
  type UpdateCertificateSettingsInput,
  type UpdateCertificateTemplateInput,
} from '@asra/validation';
import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/api-response.js';
import { AppError } from '../../utils/app-error.js';
import { certificatesService } from './certificates.service.js';
import { signaturesService } from './signatures.service.js';
import { templatesService } from './templates.service.js';

const auth = (req: Request) => req.auth!;
const idParam = (req: Request) => String(req.params.id);
const courseIdParam = (req: Request) => String(req.params.courseId ?? req.params.id);
const query = <T>(req: Request) => req.query as unknown as T;
const body = <T>(req: Request) => req.body as T;

function resolveFormat(
  req: Request,
  forced?: CertificateDownloadFormat,
): CertificateDownloadFormat {
  if (forced) return forced;
  const q = req.query as unknown as Partial<CertificateDownloadQuery> | undefined;
  return q?.format === 'png' ? 'png' : 'pdf';
}

function sendGeneratedDocument(
  res: Response,
  doc: { buffer: Buffer; filename: string; mimeType: 'application/pdf' | 'image/png' },
  disposition: 'attachment' | 'inline' = 'attachment',
): void {
  let bufferRef: Buffer | null = doc.buffer;
  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('Content-Disposition', `${disposition}; filename="${doc.filename}"`);
  res.setHeader('Content-Length', bufferRef.length);
  res.setHeader('Cache-Control', 'no-store');
  const release = () => {
    bufferRef = null;
  };
  res.once('finish', release);
  res.once('close', release);
  res.send(bufferRef);
}

const MAX_MULTIPART_BYTES = CERTIFICATE_SIGNATURE_LIMITS.maxFileBytes + 256 * 1024;

async function readMultipartForm(req: Request): Promise<FormData> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > MAX_MULTIPART_BYTES) {
      throw new AppError(
        'BAD_REQUEST',
        `Upload exceeds maximum allowed size (${CERTIFICATE_SIGNATURE_LIMITS.maxFileBytes / 1024} KB PNG).`,
      );
    }
    chunks.push(buf);
  }
  const fullBody = Buffer.concat(chunks);
  const nodeReq = new globalThis.Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'content-type': req.headers['content-type'] || '' },
    body: fullBody,
  });
  return nodeReq.formData();
}

async function parseSignaturePayload(
  req: Request,
  requireFile: boolean,
): Promise<{
  fields: Record<string, unknown>;
  pngBuffer?: Buffer;
  contentType?: string;
}> {
  if (req.is('multipart/form-data')) {
    const formData = await readMultipartForm(req);
    const fields: Record<string, unknown> = {};
    for (const key of ['fullName', 'designation', 'department']) {
      const value = formData.get(key);
      if (typeof value === 'string') fields[key] = value;
    }
    const isActiveVal = formData.get('isActive');
    if (typeof isActiveVal === 'string') {
      fields.isActive = isActiveVal === 'true' || isActiveVal === '1';
    }
    const fileEntry = formData.get('file') ?? formData.get('signature');
    if (!fileEntry || typeof fileEntry === 'string') {
      if (requireFile) {
        throw new AppError('VALIDATION_ERROR', 'Upload a PNG signature image under field "file".');
      }
      return { fields };
    }
    const file = fileEntry as File;
    const buffer = Buffer.from(await file.arrayBuffer());
    return { fields, pngBuffer: buffer, contentType: file.type || undefined };
  }

  const jsonBody = (req.body ?? {}) as Record<string, unknown>;
  const { imageBase64, contentType, ...rest } = jsonBody;
  let pngBuffer: Buffer | undefined;
  if (typeof imageBase64 === 'string' && imageBase64.trim()) {
    const stripped = imageBase64.replace(/^data:image\/png;base64,/i, '').trim();
    pngBuffer = Buffer.from(stripped, 'base64');
  } else if (requireFile) {
    throw new AppError('VALIDATION_ERROR', 'Upload a PNG signature image.');
  }

  return {
    fields: rest,
    pngBuffer,
    contentType: typeof contentType === 'string' ? contentType : 'image/png',
  };
}

export const certificatesController = {
  // --- Student Endpoints ---

  async getStudentCertificates(req: Request, res: Response): Promise<void> {
    const result = await certificatesService.getStudentCertificates(
      auth(req),
      query<StudentCertificateQuery>(req),
    );
    sendSuccess(res, result);
  },

  async getStudentCertificate(req: Request, res: Response): Promise<void> {
    const result = await certificatesService.getStudentCertificateById(auth(req), idParam(req));
    sendSuccess(res, result);
  },

  async checkCourseEligibility(req: Request, res: Response): Promise<void> {
    const result = await certificatesService.checkEligibility(auth(req), courseIdParam(req));
    sendSuccess(res, result);
  },

  async claimCertificate(req: Request, res: Response): Promise<void> {
    const result = await certificatesService.issueCertificate(auth(req), courseIdParam(req));
    sendSuccess(res, result, 'Certificate issued', 201);
  },

  async claimAcademyQuizCertificate(req: Request, res: Response): Promise<void> {
    const result = await certificatesService.issueAcademyQuizCertificate(auth(req), idParam(req));
    sendSuccess(res, result, 'Certificate issued', 201);
  },

  async downloadStudentCertificate(req: Request, res: Response): Promise<void> {
    const format = resolveFormat(req);
    const doc = await certificatesService.getCertificateDocument(idParam(req), format, auth(req));
    sendGeneratedDocument(res, doc, 'attachment');
  },

  async downloadStudentCertificatePdf(req: Request, res: Response): Promise<void> {
    const doc = await certificatesService.getCertificateDocument(idParam(req), 'pdf', auth(req));
    sendGeneratedDocument(res, doc, 'attachment');
  },

  async downloadStudentCertificatePng(req: Request, res: Response): Promise<void> {
    const doc = await certificatesService.getCertificateDocument(idParam(req), 'png', auth(req));
    sendGeneratedDocument(res, doc, 'attachment');
  },

  // --- Public Verification ---

  async verifyCertificate(req: Request, res: Response): Promise<void> {
    const params = req.params as unknown as CertificateVerifyParams;
    const result = await certificatesService.verifyPublicCertificate(params.certificateNumber);
    sendSuccess(res, result);
  },

  // --- Admin Overview & Settings ---

  async getOverview(_req: Request, res: Response): Promise<void> {
    const result = await certificatesService.getOverviewStats();
    sendSuccess(res, result);
  },

  async getSettings(_req: Request, res: Response): Promise<void> {
    const result = await certificatesService.getSettings();
    sendSuccess(res, result);
  },

  async updateSettings(req: Request, res: Response): Promise<void> {
    const result = await certificatesService.updateSettings(
      auth(req),
      body<UpdateCertificateSettingsInput>(req),
    );
    sendSuccess(res, result, 'Certificate settings saved');
  },

  async listAuditLogs(req: Request, res: Response): Promise<void> {
    const result = await certificatesService.listAuditLogs(query<CertificateAuditQuery>(req));
    sendSuccess(res, result);
  },

  async searchStudents(req: Request, res: Response): Promise<void> {
    const result = await certificatesService.searchStudents(
      query<CertificateStudentSearchQuery>(req),
    );
    sendSuccess(res, result);
  },

  async listSourceOptions(_req: Request, res: Response): Promise<void> {
    const result = await certificatesService.listSourceOptions();
    sendSuccess(res, result);
  },

  // --- Admin Templates ---

  async listTemplates(_req: Request, res: Response): Promise<void> {
    const result = await templatesService.list();
    sendSuccess(res, result);
  },

  async getTemplate(req: Request, res: Response): Promise<void> {
    const result = await templatesService.getById(idParam(req));
    sendSuccess(res, result);
  },

  async updateTemplate(req: Request, res: Response): Promise<void> {
    const result = await templatesService.update(
      auth(req),
      idParam(req),
      body<UpdateCertificateTemplateInput>(req),
    );
    sendSuccess(res, result, 'Template configuration saved');
  },

  async previewTemplatePdf(req: Request, res: Response): Promise<void> {
    const format = resolveFormat(req);
    const doc = await templatesService.generateSampleDocument(idParam(req), format);
    sendGeneratedDocument(res, doc, 'inline');
  },

  async previewTemplatePng(req: Request, res: Response): Promise<void> {
    const doc = await templatesService.generateSampleDocument(idParam(req), 'png');
    sendGeneratedDocument(res, doc, 'inline');
  },

  // --- Admin Digital Signatures ---

  async listSignatures(req: Request, res: Response): Promise<void> {
    const result = await signaturesService.list(query<CertificateSignatureQuery>(req));
    sendSuccess(res, result);
  },

  async listActiveSignatures(_req: Request, res: Response): Promise<void> {
    const result = await signaturesService.listActive();
    sendSuccess(res, result);
  },

  async getSignature(req: Request, res: Response): Promise<void> {
    const result = await signaturesService.getById(idParam(req));
    sendSuccess(res, result);
  },

  async createSignature(req: Request, res: Response): Promise<void> {
    const payload = await parseSignaturePayload(req, true);
    const parsed = createCertificateSignatureSchema.safeParse(payload.fields);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid signature input',
        parsed.error.issues,
      );
    }
    const result = await signaturesService.create(
      auth(req),
      parsed.data,
      payload.pngBuffer!,
      payload.contentType,
    );
    sendSuccess(res, result, 'Digital signature uploaded', 201);
  },

  async updateSignature(req: Request, res: Response): Promise<void> {
    const payload = await parseSignaturePayload(req, false);
    const parsed = updateCertificateSignatureSchema.safeParse(payload.fields);
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid signature input',
        parsed.error.issues,
      );
    }
    const result = await signaturesService.update(
      auth(req),
      idParam(req),
      parsed.data,
      payload.pngBuffer,
      payload.contentType,
    );
    sendSuccess(res, result, 'Digital signature updated');
  },

  // --- Admin Issued Certificates & Manual Issuance ---

  async listAdminCertificates(req: Request, res: Response): Promise<void> {
    const result = await certificatesService.listAdminCertificates(
      query<AdminCertificateQuery>(req),
    );
    sendSuccess(res, result);
  },

  async getAdminCertificate(req: Request, res: Response): Promise<void> {
    const result = await certificatesService.getAdminCertificateById(idParam(req));
    sendSuccess(res, result);
  },

  async issueManualCertificate(req: Request, res: Response): Promise<void> {
    const result = await certificatesService.issueManualCertificate(
      auth(req),
      body<ManualCertificateIssueInput>(req),
    );
    sendSuccess(res, result, 'Manual certificate issued', 201);
  },

  async issueGenericCertificate(req: Request, res: Response): Promise<void> {
    const result = await certificatesService.issueAdminGenericCertificate(
      auth(req),
      body<GenericCertificateIssueInput>(req),
    );
    sendSuccess(res, result, 'Certificate issued', 201);
  },

  async reissueCertificate(req: Request, res: Response): Promise<void> {
    const result = await certificatesService.reissueCertificate(
      auth(req),
      idParam(req),
      body<ReissueCertificateInput>(req),
    );
    sendSuccess(res, result, 'Certificate reissued', 201);
  },

  async revokeCertificate(req: Request, res: Response): Promise<void> {
    const { reason } = body<AdminRevokeCertificateInput>(req);
    const result = await certificatesService.revokeCertificate(auth(req), idParam(req), reason);
    sendSuccess(res, result);
  },

  async downloadAdminCertificate(req: Request, res: Response): Promise<void> {
    const format = resolveFormat(req);
    const doc = await certificatesService.getCertificateDocument(idParam(req), format, auth(req));
    sendGeneratedDocument(res, doc, 'attachment');
  },

  async downloadAdminCertificatePdf(req: Request, res: Response): Promise<void> {
    const doc = await certificatesService.getCertificateDocument(idParam(req), 'pdf', auth(req));
    sendGeneratedDocument(res, doc, 'attachment');
  },

  async downloadAdminCertificatePng(req: Request, res: Response): Promise<void> {
    const doc = await certificatesService.getCertificateDocument(idParam(req), 'png', auth(req));
    sendGeneratedDocument(res, doc, 'attachment');
  },
};
