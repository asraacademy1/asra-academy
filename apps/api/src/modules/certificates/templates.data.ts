import type { CertificateTemplateConfigDto, CertificateTemplateStyle } from '@asra/types';

export interface DefaultTemplateSeed {
  key: string;
  name: string;
  style: CertificateTemplateStyle;
  description: string;
  defaultTitle: string;
  defaultSubtitle: string;
  defaultBodyText: string;
  issuingAuthority: string;
  isDefault: boolean;
  config: CertificateTemplateConfigDto;
}

export const INITIAL_CERTIFICATE_TEMPLATES: readonly DefaultTemplateSeed[] = [
  {
    key: 'classic-institutional',
    name: 'Classic / Institutional',
    style: 'CLASSIC_INSTITUTIONAL',
    description:
      'Traditional academic certificate with nested gold-and-emerald borders, formal serif typography, and official institutional seal. Suitable for course completion, academic achievements, and training programs.',
    defaultTitle: 'CERTIFICATE OF COMPLETION',
    defaultSubtitle: 'ACADEMY OF ISLAMIC & CONTEMPORARY STUDIES',
    defaultBodyText:
      'has successfully completed the curriculum and all required assessments for the course',
    issuingAuthority: 'ASRA Academy',
    isDefault: true,
    config: {
      accentColor: '#034729',
      secondaryColor: '#C88717',
      showLogo: true,
      showSeal: true,
      showQrCode: true,
      showCompletionDate: true,
      showIssueDate: true,
      showCertificateNumber: true,
      showSourceLabel: false,
      footerNote: 'Official Academic Credential · ASRA Academy',
    },
  },
  {
    key: 'modern-minimal',
    name: 'Modern / Minimal',
    style: 'MODERN_MINIMAL',
    description:
      'Clean contemporary layout with minimal borders, strong typographic hierarchy, and emerald accent spine. Ideal for technical courses, coding competitions, Academy Quizzes, workshops, and events.',
    defaultTitle: 'CERTIFICATE OF RECOGNITION',
    defaultSubtitle: 'VERIFIED DIGITAL CREDENTIAL · ASRA ACADEMY',
    defaultBodyText:
      'is hereby recognized for successfully fulfilling all requirements and demonstrating proficiency in',
    issuingAuthority: 'ASRA Academy',
    isDefault: false,
    config: {
      accentColor: '#034729',
      secondaryColor: '#13211A',
      showLogo: true,
      showSeal: false,
      showQrCode: true,
      showCompletionDate: true,
      showIssueDate: true,
      showCertificateNumber: true,
      showSourceLabel: true,
      footerNote: 'Issued digitally with cryptographic verification by ASRA Academy.',
    },
  },
  {
    key: 'premium-achievement',
    name: 'Premium / Achievement',
    style: 'PREMIUM_ACHIEVEMENT',
    description:
      'Editorial distinction design featuring a deep forest-green crest header, rich restrained gold accents, and prominent honour highlight. Crafted for excellence awards, top performers, and special recognitions.',
    defaultTitle: 'CERTIFICATE OF EXCELLENCE',
    defaultSubtitle: 'HONOURS & SPECIAL DISTINCTION · ASRA ACADEMY',
    defaultBodyText:
      'is awarded this distinction in recognition of exceptional merit, dedication, and achievement in',
    issuingAuthority: 'ASRA Academy',
    isDefault: false,
    config: {
      accentColor: '#012114',
      secondaryColor: '#D89E34',
      showLogo: true,
      showSeal: true,
      showQrCode: true,
      showCompletionDate: true,
      showIssueDate: true,
      showCertificateNumber: true,
      showSourceLabel: true,
      footerNote: 'Awarded under the authority of the Academic Board, ASRA Academy.',
    },
  },
] as const;
