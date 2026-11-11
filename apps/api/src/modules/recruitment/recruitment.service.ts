import path from 'node:path';
import type {
  AdminCreateJobInput,
  AdminUpdateJobInput,
  AdminJobQuery,
  PublicJobQuery,
  PublicSubmitApplicationInput,
  AdminApplicationQuery,
  AdminChangeApplicationStatusInput,
  AdminScheduleInterviewInput,
  AdminRescheduleInterviewInput,
  AdminCancelInterviewInput,
  AdminSendEmailInput,
} from '@asra/validation';
import type {
  PublicCareerCategoryDto,
  PublicJobListItemDto,
  PublicJobDetailDto,
  AdminJobListItemDto,
  AdminJobDetailDto,
  AdminJobApplicationListItemDto,
  AdminJobApplicationDetailDto,
  RecruitmentStatsDto,
  JobQuestionDto,
  Paginated,
} from '@asra/types';
import { prisma } from '../../database/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../utils/app-error.js';
import { pageArgs, paginated } from '../../utils/pagination.js';
import { adminAudit } from '../admin/audit.js';
import { generateJobId, generateApplicationReferenceId } from './job-id-generator.js';
import { recruitmentEmailService } from './recruitment-email.service.js';
import { resumeStorageService } from './resume-storage.service.js';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatCategoryLabel(category: string): string {
  if (!category) return '';
  if (category.includes('_') || category === category.toUpperCase()) {
    return category
      .toLowerCase()
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return category;
}

export class RecruitmentService {
  // ===========================================================================
  // PUBLIC CAREERS METHODS
  // ===========================================================================

  public async getPublicCategories(): Promise<PublicCareerCategoryDto[]> {
    const now = new Date();
    const where: Prisma.JobWhereInput = {
      status: 'PUBLISHED',
      allowApplications: true,
      OR: [{ openingDate: null }, { openingDate: { lte: now } }],
      AND: [{ OR: [{ closingDate: null }, { closingDate: { gt: now } }] }],
    };

    const groups = await prisma.job.groupBy({
      by: ['category'],
      where,
      _count: {
        id: true,
      },
      orderBy: {
        category: 'asc',
      },
    });

    return groups
      .filter((g) => g._count.id > 0 && g.category?.trim().length > 0)
      .map((g) => ({
        category: g.category,
        label: formatCategoryLabel(g.category),
        count: g._count.id,
      }));
  }

  public async listPublicJobs(query: PublicJobQuery): Promise<Paginated<PublicJobListItemDto>> {
    const now = new Date();
    const where: Prisma.JobWhereInput = {
      status: 'PUBLISHED',
      allowApplications: true,
      OR: [{ openingDate: null }, { openingDate: { lte: now } }],
      AND: [{ OR: [{ closingDate: null }, { closingDate: { gt: now } }] }],
    };

    if (query.department) {
      where.department = { equals: query.department, mode: 'insensitive' };
    }
    if (query.category) {
      where.category = { equals: query.category, mode: 'insensitive' };
    }
    if (query.employmentType) {
      where.employmentType = { equals: query.employmentType, mode: 'insensitive' };
    }
    if (query.workArrangement) {
      where.workArrangement = { equals: query.workArrangement, mode: 'insensitive' };
    }
    if (query.location) {
      where.workLocation = { contains: query.location, mode: 'insensitive' };
    }
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { department: { contains: query.search, mode: 'insensitive' } },
        { category: { contains: query.search, mode: 'insensitive' } },
        { shortDescription: { contains: query.search, mode: 'insensitive' } },
        { requiredSkills: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.job.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }],
      }),
      prisma.job.count({ where }),
    ]);

    const items: PublicJobListItemDto[] = rows.map((job) => ({
      id: job.id,
      jobId: job.jobId,
      title: job.title,
      slug: job.slug,
      department: job.department,
      category: job.category,
      employmentType: job.employmentType,
      workLocation: job.workLocation,
      workArrangement: job.workArrangement,
      vacancies: job.vacancies,
      experienceRequired: job.experienceRequired,
      minQualification: job.minQualification,
      maxQualification: job.maxQualification,
      salaryMin: job.isSalaryPublic ? job.salaryMin : null,
      salaryMax: job.isSalaryPublic ? job.salaryMax : null,
      currency: job.currency,
      isSalaryPublic: job.isSalaryPublic,
      shortDescription: job.shortDescription,
      openingDate: job.openingDate?.toISOString() ?? null,
      closingDate: job.closingDate?.toISOString() ?? null,
      allowApplications: job.allowApplications,
      isExpired: Boolean(job.closingDate && job.closingDate <= now),
      createdAt: job.createdAt.toISOString(),
    }));

    return paginated(items, total, query);
  }

  public async getPublicJobByIdOrSlug(idOrSlug: string): Promise<PublicJobDetailDto> {
    const now = new Date();
    const job = await prisma.job.findFirst({
      where: {
        OR: [
          { id: idOrSlug.includes('-') && idOrSlug.length === 36 ? idOrSlug : undefined },
          { jobId: idOrSlug },
          { slug: idOrSlug },
        ].filter(Boolean) as Prisma.JobWhereInput[],
      },
      include: {
        questions: {
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    if (!job) {
      throw new AppError('NOT_FOUND', 'Job opening not found');
    }

    if (job.status !== 'PUBLISHED') {
      throw new AppError('NOT_FOUND', 'This job posting is not currently available');
    }

    if (job.openingDate && job.openingDate > now) {
      throw new AppError('NOT_FOUND', 'This job posting is not currently open');
    }

    const isExpired = Boolean(job.closingDate && job.closingDate <= now);
    if (isExpired) {
      throw new AppError('NOT_FOUND', 'This job posting has expired');
    }

    return {
      id: job.id,
      jobId: job.jobId,
      title: job.title,
      slug: job.slug,
      department: job.department,
      category: job.category,
      employmentType: job.employmentType,
      workLocation: job.workLocation,
      workArrangement: job.workArrangement,
      vacancies: job.vacancies,
      experienceRequired: job.experienceRequired,
      minQualification: job.minQualification,
      maxQualification: job.maxQualification,
      salaryMin: job.isSalaryPublic ? job.salaryMin : null,
      salaryMax: job.isSalaryPublic ? job.salaryMax : null,
      currency: job.currency,
      isSalaryPublic: job.isSalaryPublic,
      shortDescription: job.shortDescription,
      description: job.description,
      responsibilities: job.responsibilities,
      requiredSkills: job.requiredSkills,
      preferredSkills: job.preferredSkills,
      requiredQualifications: job.requiredQualifications,
      additionalRequirements: job.additionalRequirements,
      benefits: job.benefits,
      openingDate: job.openingDate?.toISOString() ?? null,
      closingDate: job.closingDate?.toISOString() ?? null,
      allowApplications: job.allowApplications && !isExpired,
      isExpired,
      createdAt: job.createdAt.toISOString(),
      questions: job.questions.map((q) => ({
        id: q.id,
        jobId: q.jobId,
        label: q.label,
        helpText: q.helpText,
        fieldType: q.fieldType,
        required: q.required,
        options: (q.options as string[]) ?? null,
        displayOrder: q.displayOrder,
        validation: q.validation as JobQuestionDto['validation'],
      })),
    };
  }

  public async submitPublicApplication(
    jobIdentifier: string,
    input: PublicSubmitApplicationInput,
  ): Promise<{
    id: string;
    referenceId: string;
    jobId: string;
    jobTitle: string;
    fullName: string;
    email: string;
    status: string;
    createdAt: string;
  }> {
    const now = new Date();
    const job = await prisma.job.findFirst({
      where: {
        OR: [
          { id: jobIdentifier.length === 36 ? jobIdentifier : undefined },
          { jobId: jobIdentifier },
          { slug: jobIdentifier },
        ].filter(Boolean) as Prisma.JobWhereInput[],
      },
      include: {
        questions: true,
      },
    });

    if (!job) {
      throw new AppError('NOT_FOUND', 'Job opening not found');
    }

    if (job.status !== 'PUBLISHED') {
      throw new AppError('BAD_REQUEST', 'This job posting is not accepting applications');
    }

    if (!job.allowApplications) {
      throw new AppError('BAD_REQUEST', 'Applications for this position are currently closed');
    }

    if (job.closingDate && job.closingDate <= now) {
      throw new AppError('BAD_REQUEST', 'The application deadline for this position has passed');
    }

    if (job.openingDate && job.openingDate > now) {
      throw new AppError('BAD_REQUEST', 'This position is not yet open for applications');
    }

    // Check duplicate application constraint: (jobId, normalizedEmail)
    const normalizedEmail = input.email.trim().toLowerCase();
    const existing = await prisma.jobApplication.findUnique({
      where: {
        job_application_job_normalized_email: {
          jobId: job.id,
          normalizedEmail,
        },
      },
    });

    if (existing) {
      throw new AppError('CONFLICT', 'You have already applied for this position');
    }

    // Validate dynamic question answers against questions defined for this job in database
    const questionsMap = new Map(job.questions.map((q) => [q.id, q]));
    const submittedAnswersMap = new Map(input.answers.map((a) => [a.questionId, a.value]));

    // Check unknown question IDs
    for (const ans of input.answers) {
      if (!questionsMap.has(ans.questionId)) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Unknown question identifier submitted: ${ans.questionId}`,
        );
      }
    }

    // Check all required questions are answered
    for (const q of job.questions) {
      if (q.required) {
        const val = submittedAnswersMap.get(q.id);
        if (
          val === undefined ||
          val === null ||
          val === '' ||
          (Array.isArray(val) && val.length === 0)
        ) {
          throw new AppError(
            'VALIDATION_ERROR',
            `Question "${q.label}" is required and must be answered`,
          );
        }
      }
    }

    // Validate types and constraints
    for (const ans of input.answers) {
      const q = questionsMap.get(ans.questionId)!;
      const val = ans.value;
      if (val === undefined || val === null || val === '') continue;

      switch (q.fieldType) {
        case 'SHORT_TEXT':
          if (typeof val !== 'string' || val.length > 255) {
            throw new AppError(
              'VALIDATION_ERROR',
              `Answer for "${q.label}" must be text under 255 characters`,
            );
          }
          break;
        case 'LONG_TEXT':
          if (typeof val !== 'string' || val.length > 5000) {
            throw new AppError(
              'VALIDATION_ERROR',
              `Answer for "${q.label}" must be text under 5000 characters`,
            );
          }
          break;
        case 'SINGLE_SELECT': {
          const opts = (q.options as string[]) ?? [];
          if (typeof val !== 'string' || !opts.includes(val)) {
            throw new AppError(
              'VALIDATION_ERROR',
              `Answer for "${q.label}" must be one of the provided options`,
            );
          }
          break;
        }
        case 'MULTI_SELECT': {
          const opts = (q.options as string[]) ?? [];
          if (!Array.isArray(val) || !val.every((item) => opts.includes(item))) {
            throw new AppError(
              'VALIDATION_ERROR',
              `Answer for "${q.label}" contains invalid options`,
            );
          }
          break;
        }
        case 'YES_NO':
          if (typeof val !== 'boolean' && val !== 'Yes' && val !== 'No') {
            throw new AppError('VALIDATION_ERROR', `Answer for "${q.label}" must be Yes or No`);
          }
          break;
        case 'NUMBER':
          if (typeof val !== 'number' && isNaN(Number(val))) {
            throw new AppError(
              'VALIDATION_ERROR',
              `Answer for "${q.label}" must be a valid number`,
            );
          }
          break;
        case 'DATE':
          if (typeof val !== 'string' || isNaN(Date.parse(val))) {
            throw new AppError('VALIDATION_ERROR', `Answer for "${q.label}" must be a valid date`);
          }
          break;
        case 'URL':
          if (typeof val !== 'string' || !/^https?:\/\//i.test(val)) {
            throw new AppError(
              'VALIDATION_ERROR',
              `Answer for "${q.label}" must be a valid URL starting with http:// or https://`,
            );
          }
          break;
      }

      if (q.validation && typeof q.validation === 'object') {
        const v = q.validation as {
          min?: number;
          max?: number;
          minLength?: number;
          maxLength?: number;
        };
        if (typeof val === 'number') {
          if (v.min !== undefined && v.min !== null && val < v.min) {
            throw new AppError(
              'VALIDATION_ERROR',
              `Value for "${q.label}" cannot be less than ${v.min}`,
            );
          }
          if (v.max !== undefined && v.max !== null && val > v.max) {
            throw new AppError('VALIDATION_ERROR', `Value for "${q.label}" cannot exceed ${v.max}`);
          }
        }
        if (typeof val === 'string') {
          if (v.minLength !== undefined && v.minLength !== null && val.length < v.minLength) {
            throw new AppError(
              'VALIDATION_ERROR',
              `Answer for "${q.label}" must be at least ${v.minLength} characters`,
            );
          }
          if (v.maxLength !== undefined && v.maxLength !== null && val.length > v.maxLength) {
            throw new AppError(
              'VALIDATION_ERROR',
              `Answer for "${q.label}" cannot exceed ${v.maxLength} characters`,
            );
          }
        }
      }
    }

    // Transactionally create application and answers with frozen snapshots
    const result = await prisma.$transaction(async (tx) => {
      const referenceId = await generateApplicationReferenceId(tx);

      const application = await tx.jobApplication.create({
        data: {
          referenceId,
          jobId: job.id,
          fullName: input.fullName,
          email: input.email,
          normalizedEmail,
          phone: input.phone,
          currentLocation: input.currentLocation,
          resumeAssetId: input.resumeAssetId,
          resumeOriginalName: input.resumeOriginalName,
          resumeMimeType: input.resumeMimeType,
          resumeFileSize: input.resumeFileSize,
          status: 'RECEIVED',
          consentGiven: input.consentGiven,
        },
      });

      // Insert answers with snapshots of question label & type
      if (input.answers.length > 0) {
        await tx.jobApplicationAnswer.createMany({
          data: input.answers.map((ans) => {
            const q = questionsMap.get(ans.questionId)!;
            const isJson = typeof ans.value === 'object';
            return {
              applicationId: application.id,
              questionId: q.id,
              questionLabel: q.label,
              fieldType: q.fieldType,
              answerText: isJson ? null : String(ans.value),
              answerJson: isJson ? (ans.value as Prisma.InputJsonValue) : undefined,
            };
          }),
        });
      }

      // Record initial status history
      await tx.jobApplicationStatusHistory.create({
        data: {
          applicationId: application.id,
          fromStatus: null,
          toStatus: 'RECEIVED',
          reason: 'Application submitted by applicant',
        },
      });

      return application;
    });

    // Send confirmation email asynchronously (after transaction commits)
    void recruitmentEmailService.sendApplicationReceived(prisma, result.id, {
      applicantName: input.fullName,
      applicantEmail: input.email,
      jobTitle: job.title,
      jobId: job.jobId,
      applicationReferenceId: result.referenceId,
    });

    return {
      id: result.id,
      referenceId: result.referenceId,
      jobId: job.jobId,
      jobTitle: job.title,
      fullName: input.fullName,
      email: input.email,
      status: 'RECEIVED',
      createdAt: result.createdAt.toISOString(),
    };
  }

  // ===========================================================================
  // ADMIN DASHBOARD & RECRUITMENT STATS
  // ===========================================================================

  public async getRecruitmentStats(): Promise<RecruitmentStatsDto> {
    const now = new Date();
    const [
      totalJobs,
      publishedJobs,
      draftJobs,
      expiredJobs,
      totalApplications,
      receivedApplications,
      underReviewApplications,
      shortlistedApplications,
      onHoldApplications,
      interviewScheduledApplications,
      acceptedApplications,
      rejectedApplications,
      recentApplicationsRows,
      recentJobsRows,
      departmentStats,
      categoryStats,
    ] = await Promise.all([
      prisma.job.count(),
      prisma.job.count({ where: { status: 'PUBLISHED' } }),
      prisma.job.count({ where: { status: 'DRAFT' } }),
      prisma.job.count({
        where: {
          status: 'PUBLISHED',
          closingDate: { lte: now },
        },
      }),
      prisma.jobApplication.count(),
      prisma.jobApplication.count({ where: { status: 'RECEIVED' } }),
      prisma.jobApplication.count({ where: { status: 'UNDER_REVIEW' } }),
      prisma.jobApplication.count({ where: { status: 'SHORTLISTED' } }),
      prisma.jobApplication.count({ where: { status: 'ON_HOLD' } }),
      prisma.jobApplication.count({ where: { status: 'INTERVIEW_SCHEDULED' } }),
      prisma.jobApplication.count({ where: { status: 'ACCEPTED' } }),
      prisma.jobApplication.count({ where: { status: 'REJECTED' } }),
      prisma.jobApplication.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { job: true, interviews: true },
      }),
      prisma.job.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { applications: true } } },
      }),
      prisma.jobApplication.groupBy({
        by: ['jobId'],
        _count: { _all: true },
      }),
      prisma.job.findMany({
        select: { id: true, department: true, category: true },
      }),
    ]);

    // Aggregate by department & category from actual database rows
    const jobInfoMap = new Map(categoryStats.map((j) => [j.id, j]));
    const deptMap = new Map<string, number>();
    const catMap = new Map<string, number>();

    for (const group of departmentStats) {
      const j = jobInfoMap.get(group.jobId);
      if (j) {
        deptMap.set(j.department, (deptMap.get(j.department) ?? 0) + group._count._all);
        catMap.set(j.category, (catMap.get(j.category) ?? 0) + group._count._all);
      }
    }

    const applicationsByDepartment = Array.from(deptMap.entries()).map(([department, count]) => ({
      department,
      count,
    }));
    const applicationsByCategory = Array.from(catMap.entries()).map(([category, count]) => ({
      category,
      count,
    }));

    const applicationsByStatus: Record<string, number> = {
      RECEIVED: receivedApplications,
      UNDER_REVIEW: underReviewApplications,
      SHORTLISTED: shortlistedApplications,
      ON_HOLD: onHoldApplications,
      INTERVIEW_SCHEDULED: interviewScheduledApplications,
      ACCEPTED: acceptedApplications,
      REJECTED: rejectedApplications,
    };

    return {
      totalJobs,
      publishedJobs,
      draftJobs,
      expiredJobs,
      totalApplications,
      receivedApplications,
      underReviewApplications,
      shortlistedApplications,
      onHoldApplications,
      interviewScheduledApplications,
      acceptedApplications,
      rejectedApplications,
      recentApplications: recentApplicationsRows.map((app) => ({
        id: app.id,
        referenceId: app.referenceId,
        jobId: app.jobId,
        jobPublicId: app.job.jobId,
        jobTitle: app.job.title,
        department: app.job.department,
        category: app.job.category,
        fullName: app.fullName,
        email: app.email,
        phone: app.phone,
        currentLocation: app.currentLocation,
        status: app.status,
        createdAt: app.createdAt.toISOString(),
        updatedAt: app.updatedAt.toISOString(),
        interviewsCount: app.interviews.length,
        hasResume: Boolean(app.resumeAssetId),
      })),
      recentJobs: recentJobsRows.map((j) => ({
        id: j.id,
        jobId: j.jobId,
        title: j.title,
        slug: j.slug,
        department: j.department,
        category: j.category,
        employmentType: j.employmentType,
        workLocation: j.workLocation,
        workArrangement: j.workArrangement,
        vacancies: j.vacancies,
        status: j.status,
        isSalaryPublic: j.isSalaryPublic,
        salaryMin: j.salaryMin,
        salaryMax: j.salaryMax,
        currency: j.currency,
        openingDate: j.openingDate?.toISOString() ?? null,
        closingDate: j.closingDate?.toISOString() ?? null,
        allowApplications: j.allowApplications,
        isExpired: Boolean(j.closingDate && j.closingDate <= now),
        applicationsCount: j._count.applications,
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
        publishedAt: j.publishedAt?.toISOString() ?? null,
        archivedAt: j.archivedAt?.toISOString() ?? null,
      })),
      applicationsByDepartment,
      applicationsByCategory,
      applicationsByStatus,
    };
  }

  // ===========================================================================
  // ADMIN JOB MANAGEMENT
  // ===========================================================================

  public async listAdminJobs(query: AdminJobQuery): Promise<Paginated<AdminJobListItemDto>> {
    const now = new Date();
    const where: Prisma.JobWhereInput = {};

    if (query.status) where.status = query.status;
    if (query.department) where.department = { equals: query.department, mode: 'insensitive' };
    if (query.category) where.category = { equals: query.category, mode: 'insensitive' };
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { jobId: { contains: query.search, mode: 'insensitive' } },
        { department: { contains: query.search, mode: 'insensitive' } },
        { category: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.job.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }],
        include: { _count: { select: { applications: true } } },
      }),
      prisma.job.count({ where }),
    ]);

    const items: AdminJobListItemDto[] = rows.map((j) => ({
      id: j.id,
      jobId: j.jobId,
      title: j.title,
      slug: j.slug,
      department: j.department,
      category: j.category,
      employmentType: j.employmentType,
      workLocation: j.workLocation,
      workArrangement: j.workArrangement,
      vacancies: j.vacancies,
      status: j.status,
      isSalaryPublic: j.isSalaryPublic,
      salaryMin: j.salaryMin,
      salaryMax: j.salaryMax,
      currency: j.currency,
      openingDate: j.openingDate?.toISOString() ?? null,
      closingDate: j.closingDate?.toISOString() ?? null,
      allowApplications: j.allowApplications,
      isExpired: Boolean(j.closingDate && j.closingDate <= now),
      applicationsCount: j._count.applications,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
      publishedAt: j.publishedAt?.toISOString() ?? null,
      archivedAt: j.archivedAt?.toISOString() ?? null,
    }));

    return paginated(items, total, query);
  }

  public async getAdminJobById(id: string): Promise<AdminJobDetailDto> {
    const now = new Date();
    const job = await prisma.job.findUnique({
      where: { id },
      include: {
        questions: { orderBy: { displayOrder: 'asc' } },
        _count: { select: { applications: true } },
      },
    });

    if (!job) throw new AppError('NOT_FOUND', 'Job not found');

    return {
      id: job.id,
      jobId: job.jobId,
      title: job.title,
      slug: job.slug,
      department: job.department,
      category: job.category,
      employmentType: job.employmentType,
      workLocation: job.workLocation,
      workArrangement: job.workArrangement,
      vacancies: job.vacancies,
      experienceRequired: job.experienceRequired,
      minQualification: job.minQualification,
      maxQualification: job.maxQualification,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      currency: job.currency,
      isSalaryPublic: job.isSalaryPublic,
      shortDescription: job.shortDescription,
      description: job.description,
      responsibilities: job.responsibilities,
      requiredSkills: job.requiredSkills,
      preferredSkills: job.preferredSkills,
      requiredQualifications: job.requiredQualifications,
      additionalRequirements: job.additionalRequirements,
      benefits: job.benefits,
      status: job.status,
      openingDate: job.openingDate?.toISOString() ?? null,
      closingDate: job.closingDate?.toISOString() ?? null,
      allowApplications: job.allowApplications,
      isExpired: Boolean(job.closingDate && job.closingDate <= now),
      applicationsCount: job._count.applications,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      publishedAt: job.publishedAt?.toISOString() ?? null,
      archivedAt: job.archivedAt?.toISOString() ?? null,
      createdById: job.createdById,
      updatedById: job.updatedById,
      questions: job.questions.map((q) => ({
        id: q.id,
        jobId: q.jobId,
        label: q.label,
        helpText: q.helpText,
        fieldType: q.fieldType,
        required: q.required,
        options: (q.options as string[]) ?? null,
        displayOrder: q.displayOrder,
        validation: q.validation as JobQuestionDto['validation'],
      })),
    };
  }

  public async createJob(adminId: string, input: AdminCreateJobInput): Promise<AdminJobDetailDto> {
    const baseSlug = slugify(input.title);
    const uniqueSuffix = Math.random().toString(36).substring(2, 6);
    const slug = `${baseSlug}-${uniqueSuffix}`;

    const createdJob = await prisma.$transaction(async (tx) => {
      const jobId = await generateJobId(tx);

      const job = await tx.job.create({
        data: {
          jobId,
          title: input.title,
          slug,
          department: input.department,
          category: input.category,
          employmentType: input.employmentType,
          workLocation: input.workLocation,
          workArrangement: input.workArrangement,
          vacancies: input.vacancies,
          experienceRequired: input.experienceRequired,
          minQualification: input.minQualification,
          maxQualification: input.maxQualification,
          salaryMin: input.salaryMin,
          salaryMax: input.salaryMax,
          currency: input.currency,
          isSalaryPublic: input.isSalaryPublic,
          shortDescription: input.shortDescription,
          description: input.description,
          responsibilities: input.responsibilities,
          requiredSkills: input.requiredSkills,
          preferredSkills: input.preferredSkills,
          requiredQualifications: input.requiredQualifications,
          additionalRequirements: input.additionalRequirements,
          benefits: input.benefits,
          status: input.status,
          openingDate: input.openingDate ? new Date(input.openingDate) : null,
          closingDate: input.closingDate ? new Date(input.closingDate) : null,
          allowApplications: input.allowApplications,
          publishedAt: input.status === 'PUBLISHED' ? new Date() : null,
          createdById: adminId,
          updatedById: adminId,
        },
      });

      if (input.questions && input.questions.length > 0) {
        await tx.jobApplicationQuestion.createMany({
          data: input.questions.map((q, idx) => ({
            jobId: job.id,
            label: q.label,
            helpText: q.helpText ?? null,
            fieldType: q.fieldType,
            required: q.required ?? false,
            options: q.options ? (q.options as Prisma.InputJsonValue) : undefined,
            displayOrder: q.displayOrder ?? idx,
            validation: q.validation ? (q.validation as Prisma.InputJsonValue) : undefined,
          })),
        });
      }

      await adminAudit(tx, {
        action: 'job.created',
        actorId: adminId,
        entityType: 'job',
        entityId: job.id,
        data: { jobId, title: job.title, status: job.status },
      });

      return job;
    });

    return this.getAdminJobById(createdJob.id);
  }

  public async updateJob(
    adminId: string,
    id: string,
    input: AdminUpdateJobInput,
  ): Promise<AdminJobDetailDto> {
    const existing = await prisma.job.findUnique({ where: { id } });
    if (!existing) throw new AppError('NOT_FOUND', 'Job not found');

    await prisma.$transaction(async (tx) => {
      const updateData: Prisma.JobUpdateInput = {
        updatedBy: { connect: { id: adminId } },
      };

      if (input.title !== undefined) updateData.title = input.title;
      if (input.department !== undefined) updateData.department = input.department;
      if (input.category !== undefined) updateData.category = input.category;
      if (input.employmentType !== undefined) updateData.employmentType = input.employmentType;
      if (input.workLocation !== undefined) updateData.workLocation = input.workLocation;
      if (input.workArrangement !== undefined) updateData.workArrangement = input.workArrangement;
      if (input.vacancies !== undefined) updateData.vacancies = input.vacancies;
      if (input.experienceRequired !== undefined)
        updateData.experienceRequired = input.experienceRequired;
      if (input.minQualification !== undefined)
        updateData.minQualification = input.minQualification;
      if (input.maxQualification !== undefined)
        updateData.maxQualification = input.maxQualification;
      if (input.salaryMin !== undefined) updateData.salaryMin = input.salaryMin;
      if (input.salaryMax !== undefined) updateData.salaryMax = input.salaryMax;
      if (input.currency !== undefined) updateData.currency = input.currency;
      if (input.isSalaryPublic !== undefined) updateData.isSalaryPublic = input.isSalaryPublic;
      if (input.shortDescription !== undefined)
        updateData.shortDescription = input.shortDescription;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.responsibilities !== undefined)
        updateData.responsibilities = input.responsibilities;
      if (input.requiredSkills !== undefined) updateData.requiredSkills = input.requiredSkills;
      if (input.preferredSkills !== undefined) updateData.preferredSkills = input.preferredSkills;
      if (input.requiredQualifications !== undefined)
        updateData.requiredQualifications = input.requiredQualifications;
      if (input.additionalRequirements !== undefined)
        updateData.additionalRequirements = input.additionalRequirements;
      if (input.benefits !== undefined) updateData.benefits = input.benefits;
      if (input.allowApplications !== undefined)
        updateData.allowApplications = input.allowApplications;
      if (input.openingDate !== undefined)
        updateData.openingDate = input.openingDate ? new Date(input.openingDate) : null;
      if (input.closingDate !== undefined)
        updateData.closingDate = input.closingDate ? new Date(input.closingDate) : null;
      if (input.status !== undefined) {
        updateData.status = input.status;
        if (input.status === 'PUBLISHED' && existing.status !== 'PUBLISHED') {
          updateData.publishedAt = new Date();
        } else if (input.status === 'ARCHIVED' && existing.status !== 'ARCHIVED') {
          updateData.archivedAt = new Date();
        }
      }

      await tx.job.update({
        where: { id },
        data: updateData,
      });

      // Questions update if provided
      if (input.questions) {
        // Delete old questions not in submitted list
        const submittedIds = input.questions.map((q) => q.id).filter(Boolean) as string[];
        await tx.jobApplicationQuestion.deleteMany({
          where: {
            jobId: id,
            id: { notIn: submittedIds },
          },
        });

        for (let i = 0; i < input.questions.length; i++) {
          const q = input.questions[i]!;
          if (q.id) {
            // Update existing question
            await tx.jobApplicationQuestion.update({
              where: { id: q.id },
              data: {
                label: q.label,
                helpText: q.helpText ?? null,
                fieldType: q.fieldType,
                required: q.required ?? false,
                options: q.options ? (q.options as Prisma.InputJsonValue) : undefined,
                displayOrder: q.displayOrder ?? i,
                validation: q.validation ? (q.validation as Prisma.InputJsonValue) : undefined,
              },
            });
          } else {
            // Create new question
            await tx.jobApplicationQuestion.create({
              data: {
                jobId: id,
                label: q.label,
                helpText: q.helpText ?? null,
                fieldType: q.fieldType,
                required: q.required ?? false,
                options: q.options ? (q.options as Prisma.InputJsonValue) : undefined,
                displayOrder: q.displayOrder ?? i,
                validation: q.validation ? (q.validation as Prisma.InputJsonValue) : undefined,
              },
            });
          }
        }
      }

      await adminAudit(tx, {
        action: 'job.updated',
        actorId: adminId,
        entityType: 'job',
        entityId: id,
        data: { jobId: existing.jobId, title: input.title ?? existing.title },
      });
    });

    return this.getAdminJobById(id);
  }

  public async publishJob(adminId: string, id: string): Promise<AdminJobDetailDto> {
    const existing = await prisma.job.findUnique({ where: { id } });
    if (!existing) throw new AppError('NOT_FOUND', 'Job not found');

    await prisma.$transaction(async (tx) => {
      await tx.job.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          updatedBy: { connect: { id: adminId } },
        },
      });

      await adminAudit(tx, {
        action: 'job.published',
        actorId: adminId,
        entityType: 'job',
        entityId: id,
        data: { jobId: existing.jobId, title: existing.title },
      });
    });

    return this.getAdminJobById(id);
  }

  public async unpublishJob(adminId: string, id: string): Promise<AdminJobDetailDto> {
    const existing = await prisma.job.findUnique({ where: { id } });
    if (!existing) throw new AppError('NOT_FOUND', 'Job not found');

    await prisma.$transaction(async (tx) => {
      await tx.job.update({
        where: { id },
        data: {
          status: 'DRAFT',
          updatedBy: { connect: { id: adminId } },
        },
      });

      await adminAudit(tx, {
        action: 'job.unpublished',
        actorId: adminId,
        entityType: 'job',
        entityId: id,
        data: { jobId: existing.jobId, title: existing.title },
      });
    });

    return this.getAdminJobById(id);
  }

  public async archiveJob(adminId: string, id: string): Promise<AdminJobDetailDto> {
    const existing = await prisma.job.findUnique({ where: { id } });
    if (!existing) throw new AppError('NOT_FOUND', 'Job not found');

    await prisma.$transaction(async (tx) => {
      await tx.job.update({
        where: { id },
        data: {
          status: 'ARCHIVED',
          archivedAt: new Date(),
          allowApplications: false,
          updatedBy: { connect: { id: adminId } },
        },
      });

      await adminAudit(tx, {
        action: 'job.archived',
        actorId: adminId,
        entityType: 'job',
        entityId: id,
        data: { jobId: existing.jobId, title: existing.title },
      });
    });

    return this.getAdminJobById(id);
  }

  public async deleteJob(adminId: string, id: string): Promise<{ success: true }> {
    const job = await prisma.job.findUnique({
      where: { id },
      include: { _count: { select: { applications: true } } },
    });

    if (!job) throw new AppError('NOT_FOUND', 'Job not found');

    if (job._count.applications > 0) {
      throw new AppError(
        'CONFLICT',
        `Cannot delete job "${job.title}" because it already has ${job._count.applications} submitted application(s). Please archive it instead to preserve recruitment history.`,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.job.delete({ where: { id } });

      await adminAudit(tx, {
        action: 'job.deleted',
        actorId: adminId,
        entityType: 'job',
        entityId: id,
        data: { jobId: job.jobId, title: job.title },
      });
    });

    return { success: true };
  }

  // ===========================================================================
  // ADMIN APPLICATION MANAGEMENT
  // ===========================================================================

  public async listAdminApplications(
    query: AdminApplicationQuery,
  ): Promise<Paginated<AdminJobApplicationListItemDto>> {
    const where: Prisma.JobApplicationWhereInput = {};

    if (query.jobId) where.jobId = query.jobId;
    if (query.status) where.status = query.status;
    const jobWhere: Prisma.JobWhereInput = {};
    if (query.department) {
      jobWhere.department = { equals: query.department, mode: 'insensitive' };
    }
    if (query.category) {
      jobWhere.category = { equals: query.category, mode: 'insensitive' };
    }
    if (Object.keys(jobWhere).length > 0) {
      where.job = jobWhere;
    }
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {
        ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
        ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
      };
    }
    if (query.search) {
      where.OR = [
        { fullName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
        { referenceId: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const { skip, take } = pageArgs(query);
    const [rows, total] = await Promise.all([
      prisma.jobApplication.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }],
        include: {
          job: { select: { id: true, jobId: true, title: true, department: true, category: true } },
          interviews: { select: { id: true } },
        },
      }),
      prisma.jobApplication.count({ where }),
    ]);

    const items: AdminJobApplicationListItemDto[] = rows.map((app) => ({
      id: app.id,
      referenceId: app.referenceId,
      jobId: app.jobId,
      jobPublicId: app.job.jobId,
      jobTitle: app.job.title,
      department: app.job.department,
      category: app.job.category,
      fullName: app.fullName,
      email: app.email,
      phone: app.phone,
      currentLocation: app.currentLocation,
      status: app.status,
      createdAt: app.createdAt.toISOString(),
      updatedAt: app.updatedAt.toISOString(),
      interviewsCount: app.interviews.length,
      hasResume: Boolean(app.resumeAssetId),
    }));

    return paginated(items, total, query);
  }

  public async getAdminApplicationById(id: string): Promise<AdminJobApplicationDetailDto> {
    const app = await prisma.jobApplication.findUnique({
      where: { id },
      include: {
        job: true,
        answers: { orderBy: { createdAt: 'asc' } },
        statusHistory: {
          orderBy: { createdAt: 'desc' },
          include: { changedBy: { select: { id: true, fullName: true, email: true } } },
        },
        notes: {
          orderBy: { createdAt: 'desc' },
          include: { admin: { select: { id: true, fullName: true, email: true } } },
        },
        interviews: {
          orderBy: { scheduledAt: 'desc' },
          include: { createdBy: { select: { id: true, fullName: true } } },
        },
        communications: {
          orderBy: { sentAt: 'desc' },
          include: { sentBy: { select: { id: true, fullName: true } } },
        },
      },
    });

    if (!app) throw new AppError('NOT_FOUND', 'Application not found');

    return {
      id: app.id,
      referenceId: app.referenceId,
      jobId: app.jobId,
      jobPublicId: app.job.jobId,
      jobTitle: app.job.title,
      department: app.job.department,
      category: app.job.category,
      fullName: app.fullName,
      email: app.email,
      phone: app.phone,
      currentLocation: app.currentLocation,
      status: app.status,
      createdAt: app.createdAt.toISOString(),
      updatedAt: app.updatedAt.toISOString(),
      interviewsCount: app.interviews.length,
      hasResume: Boolean(app.resumeAssetId),
      resumeAssetId: app.resumeAssetId,
      resumeOriginalName: app.resumeOriginalName,
      resumeMimeType: app.resumeMimeType,
      resumeFileSize: app.resumeFileSize,
      consentGiven: app.consentGiven,
      consentGivenAt: app.consentGivenAt.toISOString(),
      answers: app.answers.map((a) => ({
        id: a.id,
        questionId: a.questionId,
        questionLabel: a.questionLabel,
        fieldType: a.fieldType,
        answerText: a.answerText,
        answerJson: a.answerJson,
      })),
      statusHistory: app.statusHistory.map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        reason: h.reason,
        changedById: h.changedById,
        changedBy: h.changedBy,
        createdAt: h.createdAt.toISOString(),
      })),
      notes: app.notes.map((n) => ({
        id: n.id,
        note: n.note,
        adminId: n.adminId,
        admin: n.admin,
        createdAt: n.createdAt.toISOString(),
        updatedAt: n.updatedAt.toISOString(),
      })),
      interviews: app.interviews.map((i) => ({
        id: i.id,
        scheduledAt: i.scheduledAt.toISOString(),
        durationMinutes: i.durationMinutes,
        timezone: i.timezone,
        interviewType: i.interviewType,
        meetingUrl: i.meetingUrl,
        instructions: i.instructions,
        notes: i.notes,
        status: i.status,
        cancelledAt: i.cancelledAt?.toISOString() ?? null,
        cancellationReason: i.cancellationReason,
        createdById: i.createdById,
        createdBy: i.createdBy,
        createdAt: i.createdAt.toISOString(),
        updatedAt: i.updatedAt.toISOString(),
      })),
      communications: app.communications.map((c) => ({
        id: c.id,
        recipientEmail: c.recipientEmail,
        template: c.template,
        subject: c.subject,
        messageText: c.messageText,
        providerMessageId: c.providerMessageId,
        status: c.status,
        error: c.error,
        sentById: c.sentById,
        sentBy: c.sentBy,
        sentAt: c.sentAt.toISOString(),
      })),
    };
  }

  public async updateApplicationStatus(
    adminId: string,
    id: string,
    input: AdminChangeApplicationStatusInput,
  ): Promise<AdminJobApplicationDetailDto> {
    const app = await prisma.jobApplication.findUnique({
      where: { id },
      include: { job: true },
    });

    if (!app) throw new AppError('NOT_FOUND', 'Application not found');

    const previousStatus = app.status;
    const newStatus = input.status;

    await prisma.$transaction(async (tx) => {
      await tx.jobApplication.update({
        where: { id },
        data: { status: newStatus },
      });

      await tx.jobApplicationStatusHistory.create({
        data: {
          applicationId: id,
          fromStatus: previousStatus,
          toStatus: newStatus,
          reason: input.reason ?? null,
          changedById: adminId,
        },
      });

      await adminAudit(tx, {
        action: 'application.status_changed',
        actorId: adminId,
        entityType: 'job_application',
        entityId: id,
        data: {
          fromStatus: previousStatus,
          toStatus: newStatus,
          reason: input.reason,
        },
      });
    });

    // Send notifications if enabled
    if (input.sendEmail) {
      const emailContext = {
        applicantName: app.fullName,
        applicantEmail: app.email,
        jobTitle: app.job.title,
        jobId: app.job.jobId,
        applicationReferenceId: app.referenceId,
        adminMessage: input.customMessage,
        reason: input.reason,
        followUpDate: input.followUpDate,
      };

      if (newStatus === 'SHORTLISTED') {
        void recruitmentEmailService.sendApplicationShortlisted(prisma, id, emailContext, adminId);
      } else if (newStatus === 'ON_HOLD') {
        void recruitmentEmailService.sendApplicationOnHold(prisma, id, emailContext, adminId);
      } else if (newStatus === 'ACCEPTED') {
        void recruitmentEmailService.sendApplicationAccepted(prisma, id, emailContext, adminId);
      } else if (newStatus === 'REJECTED') {
        void recruitmentEmailService.sendApplicationRejected(prisma, id, emailContext, adminId);
      }
    }

    return this.getAdminApplicationById(id);
  }

  public async scheduleInterview(
    adminId: string,
    applicationId: string,
    input: AdminScheduleInterviewInput,
  ): Promise<AdminJobApplicationDetailDto> {
    const app = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: { job: true },
    });

    if (!app) throw new AppError('NOT_FOUND', 'Application not found');

    const scheduledDate = new Date(input.scheduledAt);

    await prisma.$transaction(async (tx) => {
      await tx.jobInterview.create({
        data: {
          applicationId,
          scheduledAt: scheduledDate,
          durationMinutes: input.durationMinutes,
          timezone: input.timezone,
          interviewType: input.interviewType,
          meetingUrl: input.meetingUrl,
          instructions: input.instructions ?? null,
          notes: input.notes ?? null,
          status: 'SCHEDULED',
          createdById: adminId,
        },
      });

      const prevStatus = app.status;
      await tx.jobApplication.update({
        where: { id: applicationId },
        data: { status: 'INTERVIEW_SCHEDULED' },
      });

      await tx.jobApplicationStatusHistory.create({
        data: {
          applicationId,
          fromStatus: prevStatus,
          toStatus: 'INTERVIEW_SCHEDULED',
          reason: `Interview scheduled (${input.interviewType})`,
          changedById: adminId,
        },
      });

      await adminAudit(tx, {
        action: 'interview.scheduled',
        actorId: adminId,
        entityType: 'job_application',
        entityId: applicationId,
        data: {
          scheduledAt: input.scheduledAt,
          interviewType: input.interviewType,
          meetingUrl: input.meetingUrl,
        },
      });
    });

    if (input.sendEmail) {
      const dateFormatted = scheduledDate.toLocaleDateString('en-IN', {
        timeZone: input.timezone,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const timeFormatted = scheduledDate.toLocaleTimeString('en-IN', {
        timeZone: input.timezone,
        hour: '2-digit',
        minute: '2-digit',
      });

      void recruitmentEmailService.sendInterviewScheduled(
        prisma,
        applicationId,
        {
          applicantName: app.fullName,
          applicantEmail: app.email,
          jobTitle: app.job.title,
          jobId: app.job.jobId,
          applicationReferenceId: app.referenceId,
          interviewDate: dateFormatted,
          interviewTime: timeFormatted,
          timezone: input.timezone,
          durationMinutes: input.durationMinutes,
          meetingUrl: input.meetingUrl,
          interviewType: input.interviewType,
          instructions: input.instructions,
          adminMessage: input.customMessage,
        },
        adminId,
      );
    }

    return this.getAdminApplicationById(applicationId);
  }

  public async rescheduleInterview(
    adminId: string,
    interviewId: string,
    input: AdminRescheduleInterviewInput,
  ): Promise<AdminJobApplicationDetailDto> {
    const interview = await prisma.jobInterview.findUnique({
      where: { id: interviewId },
      include: { application: { include: { job: true } } },
    });

    if (!interview) throw new AppError('NOT_FOUND', 'Interview not found');

    const scheduledDate = new Date(input.scheduledAt);

    await prisma.$transaction(async (tx) => {
      await tx.jobInterview.update({
        where: { id: interviewId },
        data: {
          scheduledAt: scheduledDate,
          status: 'RESCHEDULED',
          durationMinutes: input.durationMinutes ?? interview.durationMinutes,
          meetingUrl: input.meetingUrl ?? interview.meetingUrl,
          instructions:
            input.instructions !== undefined ? input.instructions : interview.instructions,
        },
      });

      await tx.jobApplicationStatusHistory.create({
        data: {
          applicationId: interview.applicationId,
          fromStatus: interview.application.status,
          toStatus: 'INTERVIEW_SCHEDULED',
          reason: `Interview rescheduled to ${scheduledDate.toISOString()}`,
          changedById: adminId,
        },
      });

      await adminAudit(tx, {
        action: 'interview.rescheduled',
        actorId: adminId,
        entityType: 'job_application',
        entityId: interview.applicationId,
        data: {
          interviewId,
          newDate: input.scheduledAt,
        },
      });
    });

    if (input.sendEmail) {
      const dateFormatted = scheduledDate.toLocaleDateString('en-IN', {
        timeZone: interview.timezone,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const timeFormatted = scheduledDate.toLocaleTimeString('en-IN', {
        timeZone: interview.timezone,
        hour: '2-digit',
        minute: '2-digit',
      });

      void recruitmentEmailService.sendInterviewRescheduled(
        prisma,
        interview.applicationId,
        {
          applicantName: interview.application.fullName,
          applicantEmail: interview.application.email,
          jobTitle: interview.application.job.title,
          jobId: interview.application.job.jobId,
          applicationReferenceId: interview.application.referenceId,
          interviewDate: dateFormatted,
          interviewTime: timeFormatted,
          timezone: interview.timezone,
          durationMinutes: input.durationMinutes ?? interview.durationMinutes,
          meetingUrl: input.meetingUrl ?? interview.meetingUrl,
          interviewType: interview.interviewType,
          instructions: input.instructions ?? interview.instructions,
          adminMessage: input.customMessage,
        },
        adminId,
      );
    }

    return this.getAdminApplicationById(interview.applicationId);
  }

  public async cancelInterview(
    adminId: string,
    interviewId: string,
    input: AdminCancelInterviewInput,
  ): Promise<AdminJobApplicationDetailDto> {
    const interview = await prisma.jobInterview.findUnique({
      where: { id: interviewId },
      include: { application: { include: { job: true } } },
    });

    if (!interview) throw new AppError('NOT_FOUND', 'Interview not found');

    await prisma.$transaction(async (tx) => {
      await tx.jobInterview.update({
        where: { id: interviewId },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: input.reason,
        },
      });

      await tx.jobApplicationStatusHistory.create({
        data: {
          applicationId: interview.applicationId,
          fromStatus: interview.application.status,
          toStatus: interview.application.status,
          reason: `Interview cancelled: ${input.reason}`,
          changedById: adminId,
        },
      });

      await adminAudit(tx, {
        action: 'interview.cancelled',
        actorId: adminId,
        entityType: 'job_application',
        entityId: interview.applicationId,
        data: {
          interviewId,
          reason: input.reason,
        },
      });
    });

    if (input.sendEmail) {
      void recruitmentEmailService.sendInterviewCancelled(
        prisma,
        interview.applicationId,
        {
          applicantName: interview.application.fullName,
          applicantEmail: interview.application.email,
          jobTitle: interview.application.job.title,
          jobId: interview.application.job.jobId,
          applicationReferenceId: interview.application.referenceId,
          reason: input.reason,
          adminMessage: input.customMessage,
        },
        adminId,
      );
    }

    return this.getAdminApplicationById(interview.applicationId);
  }

  public async addApplicationNote(
    adminId: string,
    applicationId: string,
    noteText: string,
  ): Promise<AdminJobApplicationDetailDto> {
    const app = await prisma.jobApplication.findUnique({ where: { id: applicationId } });
    if (!app) throw new AppError('NOT_FOUND', 'Application not found');

    await prisma.jobApplicationNote.create({
      data: {
        applicationId,
        adminId,
        note: noteText,
      },
    });

    return this.getAdminApplicationById(applicationId);
  }

  public async sendApplicationEmail(
    adminId: string,
    applicationId: string,
    input: AdminSendEmailInput,
  ): Promise<AdminJobApplicationDetailDto> {
    const app = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: { job: true },
    });

    if (!app) throw new AppError('NOT_FOUND', 'Application not found');

    // Interpolate variables
    const vars: Record<string, string> = {
      applicant_name: app.fullName,
      job_title: app.job.title,
      job_id: app.job.jobId,
      application_id: app.referenceId,
      admin_message: input.adminMessage,
    };

    const interpolatedMessage = recruitmentEmailService.interpolate(input.adminMessage, vars);
    const interpolatedSubject = recruitmentEmailService.interpolate(input.subject, vars);

    await recruitmentEmailService.sendCustomEmail(
      prisma,
      applicationId,
      app.email,
      app.fullName,
      interpolatedSubject,
      interpolatedMessage,
      adminId,
    );

    await adminAudit(prisma, {
      action: 'recruitment.email_sent',
      actorId: adminId,
      entityType: 'job_application',
      entityId: applicationId,
      data: {
        subject: interpolatedSubject,
        template: input.template,
      },
    });

    return this.getAdminApplicationById(applicationId);
  }

  public async getResumeStream(_adminId: string, applicationId: string) {
    const app = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      select: { resumeAssetId: true, resumeOriginalName: true, resumeMimeType: true },
    });

    if (!app || !app.resumeAssetId) {
      throw new AppError('NOT_FOUND', 'Resume not found for this application');
    }

    const result = await resumeStorageService.getResumeStream(app.resumeAssetId);
    const safeOriginalName = app.resumeOriginalName
      ? path.basename(app.resumeOriginalName).replace(/["\r\n\\]/g, '_')
      : result.originalName;

    return {
      ...result,
      originalName: safeOriginalName || result.originalName,
    };
  }
}

export const recruitmentService = new RecruitmentService();
