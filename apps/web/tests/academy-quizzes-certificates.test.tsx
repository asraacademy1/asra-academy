/**
 * Quiz Certificate Generation & Bulk Issuance — Web Component Rendering Tests
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CertificateDto } from '@asra/types';
import {
  CertificatePreview,
  DEFAULT_CERTIFICATE_PREVIEW_CONFIG,
  certificateToPreviewProps,
} from '@/components/certificates/certificate-preview';

describe('Quiz Certificate Admin & Student UI integration', () => {
  it('places Issue Certificates immediately below Leaderboard and above Rules in quiz-detail.tsx', () => {
    const detailSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/admin/academy-quizzes/quiz-detail.tsx'),
      'utf8',
    );
    const leaderboardPos = detailSource.indexOf('<AdminLeaderboardSection');
    const issueCertsPos = detailSource.indexOf('<QuizCertificatesSection');
    const rulesPos = detailSource.indexOf('<SettingsSummary');

    assert.ok(leaderboardPos !== -1, 'AdminLeaderboardSection must exist');
    assert.ok(issueCertsPos !== -1, 'QuizCertificatesSection must exist');
    assert.ok(rulesPos !== -1, 'SettingsSummary (Rules) must exist');
    assert.ok(
      leaderboardPos < issueCertsPos && issueCertsPos < rulesPos,
      'QuizCertificatesSection must appear immediately below Leaderboard and above Rules',
    );
  });

  it('includes required copy, summary metrics, disabled guard, and 4-step wizard labels', () => {
    const sectionSource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'src/components/admin/academy-quizzes/quiz-certificates-section.tsx',
      ),
      'utf8',
    );
    const wizardSource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'src/components/admin/academy-quizzes/quiz-certificates-wizard.tsx',
      ),
      'utf8',
    );

    const normalizedSection = sectionSource.replace(/\s+/g, ' ');
    assert.ok(normalizedSection.includes('Issue Certificates'));
    assert.ok(
      normalizedSection.includes(
        'Generate and issue certificates to students who participated in this quiz. You can also issue special certificates to leaderboard rankers.',
      ),
    );
    assert.ok(sectionSource.includes('Eligible participants'));
    assert.ok(sectionSource.includes('Eligible rankers'));
    assert.ok(sectionSource.includes('Already issued'));
    assert.ok(sectionSource.includes('Pending issuance'));
    assert.ok(sectionSource.includes('disabled={buttonDisabled}'));

    assert.ok(wizardSource.includes('Select Recipients'));
    assert.ok(wizardSource.includes('Assign Templates'));
    assert.ok(wizardSource.includes('Configure Delivery'));
    assert.ok(
      wizardSource.includes('Review &amp; Confirm') || wizardSource.includes('Review & Confirm'),
    );
    assert.ok(wizardSource.includes('Confirm & Issue Certificates'));
    assert.ok(wizardSource.includes('Send congratulations email'));
    assert.ok(wizardSource.includes('Make certificates available in student dashboard'));
  });

  it('renders quiz rank achievement details cleanly in CertificatePreview', () => {
    const mockCert: CertificateDto = {
      id: 'c1',
      certificateNumber: 'ASRA-2026-QUIZ-1001',
      enrollmentId: null,
      userId: 'u1',
      courseId: null,
      academyQuizId: 'q1',
      examinationId: null,
      sourceType: 'ACADEMY_QUIZ',
      sourceReferenceId: 'q1',
      sourceLabel: 'Academy Quiz',
      templateId: 't1',
      recipientName: 'Ayesha Siddiqui',
      recipientEmail: 'ayesha@example.com',
      recipientStudentCode: 'STU-001',
      certificateTitle: 'CERTIFICATE OF EXCELLENCE',
      courseTitle: 'National Science Quiz 2026',
      description: 'in recognition of securing Rank #1 in the Academy Quiz',
      achievementDetails: 'Rank #1 · Score: 98%',
      completedAt: '2026-11-10T10:00:00.000Z',
      issuedAt: '2026-11-11T10:00:00.000Z',
      status: 'ISSUED',
      lifecycleStatus: 'ISSUED',
      certificateCategory: 'RANK',
      quizRank: 1,
      issuedFormats: ['PDF', 'PNG'],
      visibleInStudentDashboard: true,
      templateSnapshot: {
        templateId: 't1',
        key: 'premium-achievement',
        name: 'Premium / Achievement',
        style: 'PREMIUM_ACHIEVEMENT',
        version: 1,
        certificateTitle: 'CERTIFICATE OF EXCELLENCE',
        subtitle: 'HONOURS & SPECIAL DISTINCTION · ASRA ACADEMY',
        bodyText: 'in recognition of securing Rank #1 in the Academy Quiz',
        issuingAuthority: 'ASRA Academy',
        config: DEFAULT_CERTIFICATE_PREVIEW_CONFIG,
      },
      signatureSnapshots: [],
      verificationUrl: 'https://asraacademy.in/verify/ASRA-2026-QUIZ-1001',
      downloadUrl: '/api/v1/student/certificates/c1/download',
      pngDownloadUrl: '/api/v1/student/certificates/c1/download/png',
    };

    const html = renderToStaticMarkup(
      <CertificatePreview {...certificateToPreviewProps(mockCert)} />,
    );
    assert.ok(html.includes('Ayesha Siddiqui'));
    assert.ok(html.includes('National Science Quiz 2026'));
    assert.ok(html.includes('Rank #1 · Score: 98%'));
    assert.ok(html.includes('ASRA-2026-QUIZ-1001'));
  });
});
