/**
 * PHASE 16 — Public Careers & Recruitment Management UI Unit Tests
 * Tests navigation links, Indian phone validation, Careers Directory,
 * Dynamic Question components, and Job Detail view.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JobQuestionDto, PublicJobDetailDto, PublicJobListItemDto } from '@asra/types';
import { indianPhoneSchema } from '@asra/validation';

import { CareersDirectory } from '@/components/public/careers/careers-directory';
import { CareersWhyUs } from '@/components/public/careers/careers-why-us';
import { DynamicQuestionInput } from '@/components/public/careers/dynamic-question-input';
import { JobDetailView } from '@/components/public/careers/job-detail-view';
import {
  ApplicantResumeCard,
  ensurePdfBlob,
  ResumePreviewBody,
} from '@/components/admin/recruitment/resume-actions';
import { buildFooterColumns } from '@/components/layout/footer';
import { footerNavigation, publicNavigation } from '@/config/navigation';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('PHASE 16: Public Careers UI & Validation', () => {
  describe('1. Navigation Integrity & Dedicated Careers Footer Section', () => {
    it('includes Careers in public main navigation', () => {
      const careersItem = publicNavigation.find((item) => item.href === '/careers');
      assert.ok(careersItem, 'Careers link must be present in publicNavigation');
      assert.equal(careersItem.label, 'Careers');
    });

    it('includes dedicated Careers section in footer navigation alongside Learn and Academy', () => {
      const learnSection = footerNavigation.find(
        (section) => section.title.toLowerCase() === 'learn',
      );
      assert.ok(learnSection, 'Learn section must exist in footerNavigation');

      const academySection = footerNavigation.find(
        (section) => section.title.toLowerCase() === 'academy',
      );
      assert.ok(academySection, 'Academy section must exist in footerNavigation');

      const careersSection = footerNavigation.find(
        (section) => section.title.toLowerCase() === 'careers',
      );
      assert.ok(careersSection, 'Careers section must exist in footerNavigation');
      const careersLink = careersSection.links.find((link) => link.href === '/careers');
      assert.ok(careersLink, 'Careers link must be present in Careers footer section');
    });

    it('builds Footer columns initially with only base Careers link when no categories exist', () => {
      const cols = buildFooterColumns(footerNavigation, []);
      const careersCol = cols.find((c) => c.title.toLowerCase() === 'careers');
      assert.ok(careersCol, 'Careers column must exist');
      assert.equal(careersCol.links.length, 1);
      assert.equal(careersCol.links[0]?.label, 'Careers');
      assert.equal(careersCol.links[0]?.href, '/careers');
      assert.equal(careersCol.href, '/careers');
    });

    it('builds Footer columns dynamically expanded with active job categories', () => {
      const mockCategories = [
        { category: 'Administration', label: 'Administration', count: 1 },
        { category: 'TEACHING_FACULTY', label: 'Teaching Faculty', count: 3 },
      ];
      const cols = buildFooterColumns(footerNavigation, mockCategories);
      const careersCol = cols.find((c) => c.title.toLowerCase() === 'careers');
      assert.ok(careersCol, 'Careers column must exist');
      assert.equal(careersCol.links.length, 3);
      assert.equal(careersCol.links[0]?.label, 'All openings');
      assert.equal(careersCol.links[0]?.href, '/careers');
      assert.equal(careersCol.links[1]?.label, 'Administration');
      assert.equal(careersCol.links[1]?.href, '/careers?category=administration');
      assert.equal(careersCol.links[2]?.label, 'Teaching Faculty');
      assert.equal(careersCol.links[2]?.href, '/careers?category=teaching_faculty');
    });

    it('renders CareersWhyUs benefit pillars', () => {
      const rendered = html(<CareersWhyUs />);
      assert.ok(rendered.includes('Mission-Driven Impact'));
      assert.ok(rendered.includes('Collaborative Excellence'));
    });
  });

  describe('2. Indian Phone Normalization & Validation', () => {
    it('accepts and normalizes valid 10-digit Indian numbers with prefixes', () => {
      assert.equal(indianPhoneSchema.parse('9876543210'), '9876543210');
      assert.equal(indianPhoneSchema.parse('+91 98765 43210'), '9876543210');
      assert.equal(indianPhoneSchema.parse('+91-98765-43210'), '9876543210');
      assert.equal(indianPhoneSchema.parse('09876543210'), '9876543210');
      assert.equal(indianPhoneSchema.parse('7123456789'), '7123456789');
      assert.equal(indianPhoneSchema.parse('8123456789'), '8123456789');
      assert.equal(indianPhoneSchema.parse('6123456789'), '6123456789');
    });

    it('rejects numbers that do not match 10-digit Indian format or start with < 6', () => {
      assert.throws(() => indianPhoneSchema.parse('5123456789')); // Starts with 5
      assert.throws(() => indianPhoneSchema.parse('12345')); // Too short
      assert.throws(() => indianPhoneSchema.parse('9876543210123456')); // Too long
      assert.throws(() => indianPhoneSchema.parse('abcdefghij')); // Non-numeric
    });
  });

  describe('3. Careers Directory Component', () => {
    const mockJobs: PublicJobListItemDto[] = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        jobId: 'ASRA-JOB-2026-00001',
        title: 'Senior Faculty — Physics (CBSE 11-12)',
        slug: 'senior-faculty-physics',
        department: 'Science',
        category: 'Teaching',
        employmentType: 'Full-time',
        workLocation: 'Hyderabad Campus',
        workArrangement: 'On-site',
        vacancies: 2,
        experienceRequired: '3-5 years',
        minQualification: 'Master of Science (Physics)',
        currency: 'INR',
        isSalaryPublic: true,
        salaryMin: 600000,
        salaryMax: 900000,
        shortDescription: 'Lead physics teacher for senior secondary students.',
        allowApplications: true,
        isExpired: false,
        createdAt: new Date().toISOString(),
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        jobId: 'ASRA-JOB-2026-00002',
        title: 'Academic Counselor',
        slug: 'academic-counselor',
        department: 'Student Affairs',
        category: 'Counseling',
        employmentType: 'Full-time',
        workLocation: 'Bengaluru Campus',
        workArrangement: 'Hybrid',
        vacancies: 1,
        experienceRequired: '2+ years',
        minQualification: 'MA Psychology or Counseling',
        currency: 'INR',
        isSalaryPublic: false,
        salaryMin: 450000,
        salaryMax: 600000,
        shortDescription: 'Guide students through academic pathway decisions.',
        allowApplications: true,
        isExpired: false,
        createdAt: new Date().toISOString(),
      },
    ];

    it('renders job cards with titles, job IDs, badges, and metadata', () => {
      const rendered = html(<CareersDirectory initialJobs={mockJobs} />);
      assert.ok(rendered.includes('ASRA-JOB-2026-00001'));
      assert.ok(rendered.includes('Senior Faculty — Physics (CBSE 11-12)'));
      assert.ok(rendered.includes('Hyderabad Campus'));
      assert.ok(rendered.includes('ASRA-JOB-2026-00002'));
      assert.ok(rendered.includes('Academic Counselor'));
      assert.ok(rendered.includes('Bengaluru Campus'));
      // Public salary rendered for Job 1
      assert.ok(rendered.includes('6,00,000'));
      // Job 2 salary is private, must not appear in markup
      assert.ok(!rendered.includes('4,50,000'));
    });

    it('renders clean empty state when no jobs are available', () => {
      const rendered = html(<CareersDirectory initialJobs={[]} />);
      assert.ok(rendered.includes('No open positions found'));
      assert.ok(rendered.includes('There are currently no active job vacancies available'));
    });

    it('pre-selects category and filters jobs when initialCategory is supplied', () => {
      // Teaching category should match Job 1 and filter out Job 2 (Counseling)
      const rendered = html(<CareersDirectory initialJobs={mockJobs} initialCategory="teaching" />);
      assert.ok(rendered.includes('Senior Faculty — Physics (CBSE 11-12)'));
      assert.ok(!rendered.includes('Academic Counselor'));
    });
  });

  describe('4. Dynamic Question Input Component', () => {
    it('renders SHORT_TEXT question correctly with label and required marker', () => {
      const q: JobQuestionDto = {
        id: 'q1',
        jobId: 'job1',
        label: 'Current School Affiliation',
        fieldType: 'SHORT_TEXT',
        required: true,
        displayOrder: 1,
        validation: { maxLength: 100 },
      };

      const rendered = html(
        <DynamicQuestionInput question={q} value="Delhi Public School" onChange={() => {}} />,
      );
      assert.ok(rendered.includes('Current School Affiliation'));
      assert.ok(rendered.includes('Delhi Public School'));
      assert.ok(rendered.includes('19/100')); // Character counter
    });

    it('renders SINGLE_SELECT question with options', () => {
      const q: JobQuestionDto = {
        id: 'q2',
        jobId: 'job1',
        label: 'Curriculum Board Experience',
        fieldType: 'SINGLE_SELECT',
        required: false,
        options: ['CBSE', 'ICSE', 'Cambridge', 'IB'],
        displayOrder: 2,
      };

      const rendered = html(<DynamicQuestionInput question={q} value="CBSE" onChange={() => {}} />);
      assert.ok(rendered.includes('Curriculum Board Experience'));
      assert.ok(rendered.includes('CBSE'));
      assert.ok(rendered.includes('Cambridge'));
    });

    it('renders YES_NO question with radio controls', () => {
      const q: JobQuestionDto = {
        id: 'q3',
        jobId: 'job1',
        label: 'Willing to relocate to Hyderabad?',
        fieldType: 'YES_NO',
        required: true,
        displayOrder: 3,
      };

      const rendered = html(<DynamicQuestionInput question={q} value={true} onChange={() => {}} />);
      assert.ok(rendered.includes('Willing to relocate to Hyderabad?'));
      assert.ok(rendered.includes('Yes'));
      assert.ok(rendered.includes('No'));
    });
  });

  describe('5. Job Detail View Component', () => {
    const mockDetail: PublicJobDetailDto = {
      id: '00000000-0000-0000-0000-000000000001',
      jobId: 'ASRA-JOB-2026-00001',
      title: 'Senior Faculty — Mathematics',
      slug: 'senior-faculty-mathematics',
      department: 'Academics',
      category: 'Teaching',
      employmentType: 'Full-time',
      workLocation: 'Main Campus',
      workArrangement: 'On-site',
      vacancies: 3,
      experienceRequired: '5+ years',
      minQualification: 'M.Sc. Mathematics with B.Ed',
      currency: 'INR',
      isSalaryPublic: true,
      salaryMin: 700000,
      salaryMax: 1000000,
      shortDescription: 'Teaching advanced calculus and algebra to CBSE high school students.',
      description:
        'Comprehensive Mathematics faculty role responsible for academic delivery, exam preparation, and curriculum design.',
      responsibilities:
        '• Deliver engaging classroom lectures\n• Conduct periodic assessment tests\n• Mentor students for Olympiads and competitive entrance exams',
      requiredSkills: 'Advanced Calculus, Linear Algebra, Pedagogy, CBSE Board Curriculum',
      preferredSkills: 'IIT-JEE Coaching Experience, Digital Smart Board proficiency',
      benefits: 'Health insurance, annual professional development fund, provident fund',
      allowApplications: true,
      isExpired: false,
      createdAt: new Date().toISOString(),
      questions: [
        {
          id: 'q1',
          jobId: '00000000-0000-0000-0000-000000000001',
          label: 'Years of CBSE teaching experience',
          fieldType: 'NUMBER',
          required: true,
          displayOrder: 1,
        },
      ],
    };

    it('renders full job details, responsibilities, skills, and apply link', () => {
      const rendered = html(<JobDetailView job={mockDetail} />);
      assert.ok(rendered.includes('Senior Faculty — Mathematics'));
      assert.ok(rendered.includes('ASRA-JOB-2026-00001'));
      assert.ok(rendered.includes('Deliver engaging classroom lectures'));
      assert.ok(rendered.includes('Advanced Calculus'));
      assert.ok(rendered.includes('Health insurance'));
      assert.ok(rendered.includes('/careers/ASRA-JOB-2026-00001/apply'));
    });

    it('renders applications closed alert when allowApplications is false', () => {
      const closedJob = { ...mockDetail, allowApplications: false };
      const rendered = html(<JobDetailView job={closedJob} />);
      assert.ok(rendered.includes('Applications Closed'));
      assert.ok(rendered.includes('This position is currently not accepting new applications.'));
    });
  });

  describe('6. Admin Applicant Resume Preview & Download UI', () => {
    it('renders independent Preview Resume and Download Resume buttons with metadata', () => {
      const rendered = html(
        <ApplicantResumeCard
          resumeOriginalName="Mohd_Arif_Ansari_Resume.pdf"
          resumeFileSize={104858}
          isPreviewLoading={false}
          isDownloading={false}
          onPreview={() => undefined}
          onDownload={() => undefined}
        />,
      );
      assert.ok(rendered.includes('Mohd_Arif_Ansari_Resume.pdf'));
      assert.ok(rendered.includes('0.10 MB · application/pdf'));
      assert.ok(rendered.includes('Preview Resume'));
      assert.ok(rendered.includes('Download Resume'));
      assert.equal(rendered.includes('Download / Preview Resume'), false);
      assert.equal(rendered.includes('cloudinary'), false);
    });

    it('renders loading indicator independently for Download vs Preview', () => {
      const downloadingHtml = html(
        <ApplicantResumeCard
          resumeOriginalName="Mohd_Arif_Ansari_Resume.pdf"
          resumeFileSize={104858}
          isPreviewLoading={false}
          isDownloading={true}
          onPreview={() => undefined}
          onDownload={() => undefined}
        />,
      );
      assert.ok(downloadingHtml.includes('Downloading…'));
      assert.ok(downloadingHtml.includes('Preview Resume'));

      const loadingBody = html(
        <ResumePreviewBody
          fileName="Mohd_Arif_Ansari_Resume.pdf"
          loading={true}
          error={null}
          previewUrl={null}
          onRetry={() => undefined}
        />,
      );
      assert.ok(loadingBody.includes('role="status"'));
      assert.ok(loadingBody.includes('Loading resume preview…'));
    });

    it('renders meaningful error state and retry action when preview fails', () => {
      const errorBody = html(
        <ResumePreviewBody
          fileName="Mohd_Arif_Ansari_Resume.pdf"
          loading={false}
          error="Resume delivery was blocked by cloud storage permissions."
          previewUrl={null}
          onRetry={() => undefined}
        />,
      );
      assert.ok(errorBody.includes('role="alert"'));
      assert.ok(errorBody.includes('Unable to load resume preview'));
      assert.ok(errorBody.includes('Resume delivery was blocked by cloud storage permissions.'));
      assert.ok(errorBody.includes('Retry Preview'));
    });

    it('renders embedded PDF iframe viewer once preview blob URL loads', () => {
      const viewerBody = html(
        <ResumePreviewBody
          fileName="Mohd_Arif_Ansari_Resume.pdf"
          loading={false}
          error={null}
          previewUrl="blob:https://asraacademy.in/test-resume-uuid"
          onRetry={() => undefined}
        />,
      );
      assert.ok(viewerBody.includes('<iframe'));
      assert.ok(viewerBody.includes('src="blob:https://asraacademy.in/test-resume-uuid"'));
      assert.ok(viewerBody.includes('title="Resume preview: Mohd_Arif_Ansari_Resume.pdf"'));
    });

    it('normalizes PDF blobs and rejects empty blobs', () => {
      assert.throws(() => ensurePdfBlob(new Blob([])), /empty/i);
      const normalized = ensurePdfBlob(
        new Blob(['%PDF-1.4'], { type: 'application/octet-stream' }),
      );
      assert.equal(normalized.type, 'application/pdf');
    });
  });
});
