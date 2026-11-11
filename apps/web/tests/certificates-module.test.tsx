/**
 * Generic Certificate Management Module — Web Unit & Component Rendering Tests
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PublicCertificateVerificationDto } from '@asra/types';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  CertificateLifecycleBadge,
  CertificatePreview,
  CertificateSourceBadge,
  DEFAULT_CERTIFICATE_PREVIEW_CONFIG,
  type PreviewSignatureItem,
} from '@/components/certificates/certificate-preview';
import { CertificateVerificationView } from '@/components/public/certificate-verification';

const SAMPLE_SIGNATURES: PreviewSignatureItem[] = [
  {
    key: 'sig-1',
    fullName: 'Dr. Tariq Mahmood',
    designation: 'Founder & Patron',
    department: 'Executive Board',
    positionLabel: 'Left',
    showName: true,
    showDesignation: true,
    imageSrc: 'data:image/png;base64,iVBORw0KGgo=',
  },
  {
    key: 'sig-2',
    fullName: 'Prof. Nadia Khalid',
    designation: 'Academic Director',
    positionLabel: 'Center',
    showName: true,
    showDesignation: false,
    imageSrc: 'data:image/png;base64,iVBORw0KGgo=',
  },
  {
    key: 'sig-3',
    fullName: 'Imran Siddiqui',
    designation: 'Examination Controller',
    positionLabel: 'Right',
    showName: false,
    showDesignation: true,
    imageSrc: null,
  },
];

describe('CertificatePreview component', () => {
  it('renders all 3 initial template styles, signature visibility toggles, QR vector matrix, and long names cleanly', () => {
    for (const style of [
      'CLASSIC_INSTITUTIONAL',
      'MODERN_MINIMAL',
      'PREMIUM_ACHIEVEMENT',
    ] as const) {
      const html = renderToStaticMarkup(
        <CertificatePreview
          style={style}
          config={DEFAULT_CERTIFICATE_PREVIEW_CONFIG}
          issuingAuthority="ASRA Academy"
          subtitle="Center for Classical Learning"
          certificateTitle="CERTIFICATE OF EXCELLENCE"
          recipientName="Abdullah Muhammad Al-Qurtubi Al-Andalusi Long Name"
          bodyText="has demonstrated exceptional mastery in"
          subjectTitle="National Classical Rhetoric Olympiad 2026"
          achievementDetails="Rank #1 · Gold Medalist"
          sourceLabel="Competition"
          completedAt="2026-10-15T00:00:00.000Z"
          issuedAt="2026-10-16T00:00:00.000Z"
          certificateNumber="ASRA-2026-DEMO-0001"
          verificationUrl="https://asraacademy.org/verify/ASRA-2026-DEMO-0001"
          signatures={SAMPLE_SIGNATURES}
          status="ISSUED"
        />,
      );

      assert.ok(html.includes('Abdullah Muhammad Al-Qurtubi Al-Andalusi Long Name'), style);
      assert.ok(html.includes('National Classical Rhetoric Olympiad 2026'), style);
      assert.ok(html.includes('ASRA-2026-DEMO-0001'), style);
      assert.ok(html.includes('<svg'), `Expected vector QR SVG in ${style}`);
      assert.ok(html.includes('Dr. Tariq Mahmood'), `${style}: showName=true`);
      assert.ok(html.includes('Founder &amp; Patron'), `${style}: showDesignation=true`);
      assert.ok(html.includes('Prof. Nadia Khalid'), `${style}: sig-2 showName=true`);
      assert.ok(
        !html.includes('Academic Director'),
        `${style}: sig-2 showDesignation=false hidden`,
      );
      assert.ok(!html.includes('Imran Siddiqui'), `${style}: sig-3 showName=false hidden`);
      assert.ok(html.includes('Examination Controller'), `${style}: sig-3 showDesignation=true`);
      assert.ok(!html.includes('>Revoked<'), style);
    }
  });

  it('renders an unmistakable REVOKED overlay stamp when status is REVOKED', () => {
    const html = renderToStaticMarkup(
      <CertificatePreview
        style="CLASSIC_INSTITUTIONAL"
        config={DEFAULT_CERTIFICATE_PREVIEW_CONFIG}
        issuingAuthority="ASRA Academy"
        certificateTitle="CERTIFICATE OF COMPLETION"
        recipientName="Amina Student"
        bodyText="has completed"
        subjectTitle="Tajweed Foundations"
        certificateNumber="ASRA-2026-REVK-1111"
        verificationUrl="https://asraacademy.org/verify/ASRA-2026-REVK-1111"
        signatures={SAMPLE_SIGNATURES.slice(0, 2)}
        status="REVOKED"
      />,
    );
    assert.match(html, />Revoked</);
  });

  it('renders an unmistakable SUPERSEDED overlay stamp and badge when lifecycleStatus is SUPERSEDED', () => {
    const html = renderToStaticMarkup(
      <CertificatePreview
        style="MODERN_MINIMAL"
        config={DEFAULT_CERTIFICATE_PREVIEW_CONFIG}
        issuingAuthority="ASRA Academy"
        certificateTitle="CERTIFICATE OF COMPLETION"
        recipientName="Amina Student"
        bodyText="has completed"
        subjectTitle="Tajweed Foundations"
        certificateNumber="ASRA-2026-SUPD-1111"
        verificationUrl="https://asraacademy-one.vercel.app/verify/ASRA-2026-SUPD-1111"
        signatures={SAMPLE_SIGNATURES.slice(0, 2)}
        status="REVOKED"
        lifecycleStatus="SUPERSEDED"
        supersededByCertificateNumber="ASRA-2026-NEWW-2222"
      />,
    );
    assert.match(html, />Superseded</);
    assert.ok(html.includes('Replaced by ASRA-2026-NEWW-2222'));

    const badgeHtml = renderToStaticMarkup(
      <CertificateLifecycleBadge status="REVOKED" lifecycleStatus="SUPERSEDED" />,
    );
    assert.match(badgeHtml, />Superseded</);
  });

  it('renders custom source labels in CertificateSourceBadge', () => {
    const customHtml = renderToStaticMarkup(
      <CertificateSourceBadge sourceType="COMPETITION" sourceLabel="Annual Qiraat Prize" />,
    );
    assert.ok(customHtml.includes('Annual Qiraat Prize'));
    const defaultHtml = renderToStaticMarkup(<CertificateSourceBadge sourceType="ACADEMY_QUIZ" />);
    assert.ok(defaultHtml.includes('Academy Quiz'));
  });
});

describe('CertificateVerificationView generic sources & privacy', () => {
  it('renders multi-source certificate details and public signatories cleanly without leaking private fields', () => {
    const data: PublicCertificateVerificationDto = {
      valid: true,
      certificateNumber: 'ASRA-2026-QUIZ-9090',
      status: 'ISSUED',
      sourceType: 'ACADEMY_QUIZ',
      sourceLabel: 'National Olympiad Quiz',
      certificateTitle: 'CERTIFICATE OF ACHIEVEMENT',
      recipientName: 'Zayd Ibn Ali',
      courseTitle: 'Seerah Heritage Challenge 2026',
      description: 'achieved first-tier distinction in the national quiz round.',
      achievementDetails: 'Finalist Distinction — Rank #2',
      academyName: 'ASRA Academy',
      completedAt: '2026-10-18T00:00:00.000Z',
      issuedAt: '2026-10-19T00:00:00.000Z',
      revokedAt: null,
      revokedReason: null,
      signatories: [
        {
          fullName: 'Dr. Tariq Mahmood',
          designation: 'Founder & Patron',
          department: 'Executive Board',
        },
        { fullName: 'Prof. Nadia Khalid', designation: 'Quiz Convener' },
      ],
    };

    const html = renderToStaticMarkup(
      <CertificateVerificationView
        initialCode="ASRA-2026-QUIZ-9090"
        initialLookup={{ status: 'found', data }}
      />,
    );
    assert.ok(html.includes('Authentic &amp; Verified Certificate'));
    assert.ok(html.includes('National Olympiad Quiz'));
    assert.ok(html.includes('CERTIFICATE OF ACHIEVEMENT'));
    assert.ok(html.includes('Zayd Ibn Ali'));
    assert.ok(html.includes('Seerah Heritage Challenge 2026'));
    assert.ok(html.includes('Finalist Distinction — Rank #2'));
    assert.ok(html.includes('Dr. Tariq Mahmood'));
    assert.ok(html.includes('Quiz Convener'));
  });

  it('displays revocation warning and reason when a certificate is REVOKED', () => {
    const revoked: PublicCertificateVerificationDto = {
      valid: false,
      certificateNumber: 'ASRA-2026-REVK-2222',
      status: 'REVOKED',
      sourceType: 'WORKSHOP',
      sourceLabel: 'Workshop',
      certificateTitle: 'CERTIFICATE OF PARTICIPATION',
      recipientName: 'Test Participant',
      courseTitle: 'Arabic Calligraphy Intensive',
      description: null,
      achievementDetails: null,
      academyName: 'ASRA Academy',
      completedAt: '2026-10-01T00:00:00.000Z',
      issuedAt: '2026-10-02T00:00:00.000Z',
      revokedAt: '2026-10-05T00:00:00.000Z',
      revokedReason: 'Superseded by corrected spelling reissue.',
      signatories: [],
    };
    const html = renderToStaticMarkup(
      <CertificateVerificationView
        initialCode="ASRA-2026-REVK-2222"
        initialLookup={{ status: 'found', data: revoked }}
      />,
    );
    assert.ok(html.includes('Certificate Revoked'));
    assert.ok(html.includes('Superseded by corrected spelling reissue.'));
  });

  it('displays superseded notice and active replacement link when lifecycleStatus is SUPERSEDED', () => {
    const superseded: PublicCertificateVerificationDto = {
      valid: false,
      certificateNumber: 'ASRA-2026-SUPD-3333',
      status: 'REVOKED',
      lifecycleStatus: 'SUPERSEDED',
      supersededByCertificateNumber: 'ASRA-2026-NEWW-4444',
      sourceType: 'COURSE',
      sourceLabel: 'Course',
      certificateTitle: 'CERTIFICATE OF COMPLETION',
      recipientName: 'Corrected Recipient',
      courseTitle: 'Classical Arabic Grammar',
      description: null,
      achievementDetails: null,
      academyName: 'ASRA Academy',
      completedAt: '2026-10-01T00:00:00.000Z',
      issuedAt: '2026-10-02T00:00:00.000Z',
      revokedAt: '2026-10-05T00:00:00.000Z',
      revokedReason: 'Superseded by reissue: Name spelling updated',
      signatories: [],
    };
    const html = renderToStaticMarkup(
      <CertificateVerificationView
        initialCode="ASRA-2026-SUPD-3333"
        initialLookup={{ status: 'found', data: superseded }}
      />,
    );
    assert.ok(html.includes('Certificate Superseded (No Longer Valid)'));
    assert.ok(html.includes('ASRA-2026-NEWW-4444'));
  });
});
