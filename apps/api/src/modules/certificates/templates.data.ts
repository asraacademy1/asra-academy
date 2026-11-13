import type { CertificateTemplateConfigDto, CertificateTemplateStyle } from '@asra/types';
import {
  QUIZORA_2026_DEFAULT_BODY_TEXT,
  QUIZORA_2026_DESIGN_2_DEFAULT_BODY_TEXT,
  QUIZORA_2026_DESIGN_2_TEMPLATE_KEY,
  QUIZORA_2026_DESIGN_2_TEMPLATE_STYLE,
  QUIZORA_2026_TEMPLATE_KEY,
  QUIZORA_2026_TEMPLATE_STYLE,
} from '@asra/validation';

export interface DefaultTemplateSeed {
  key: string;
  name: string;
  style: CertificateTemplateStyle;
  description: string;
  defaultTitle: string;
  defaultSubtitle: string | null;
  defaultBodyText: string;
  issuingAuthority: string;
  isDefault: boolean;
  config: CertificateTemplateConfigDto;
}

/**
 * Phase 13/17 vector templates. RETIRED: archived (is_active = false) by the bootstrap and never
 * offered for new issuance. Kept so historical certificates — and legacy rows without a
 * template snapshot — keep rendering exactly as issued.
 */
export const LEGACY_CERTIFICATE_TEMPLATES: readonly DefaultTemplateSeed[] = [
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

/** @deprecated Use LEGACY_CERTIFICATE_TEMPLATES (the original Phase 17 seeds). */
export const INITIAL_CERTIFICATE_TEMPLATES = LEGACY_CERTIFICATE_TEMPLATES;

/**
 * Templates seeded and offered for new issuance. Template 1: ASRA QUIZORA 2026 — Certificate of
 * Participation (category QUIZ_PARTICIPATION), rendered over the approved reference artwork.
 * The heading, emblem, borders and signatory captions are part of the artwork; only the
 * recipient name, the statement (template body with {title}/{date}), signatures, QR code and
 * metadata are dynamic.
 */
export const ACTIVE_CERTIFICATE_TEMPLATES: readonly DefaultTemplateSeed[] = [
  {
    key: QUIZORA_2026_TEMPLATE_KEY,
    name: 'ASRA QUIZORA 2026 — Certificate of Participation',
    style: QUIZORA_2026_TEMPLATE_STYLE,
    description:
      'Landscape 1536 × 1024 artwork template (category QUIZ_PARTICIPATION). Recipient name, statement, completion & issue dates, certificate ID and verification QR are dynamic. Requires exactly 2 signatures: Event Coordinator and Director. Never displays scores, marks, percentages or ranks.',
    defaultTitle: 'Certificate of Participation',
    defaultSubtitle: null,
    defaultBodyText: QUIZORA_2026_DEFAULT_BODY_TEXT,
    issuingAuthority: 'ASRA Academy',
    isDefault: true,
    config: {
      accentColor: '#0B1638',
      secondaryColor: '#C9A13B',
      showLogo: true,
      showSeal: true,
      showQrCode: true,
      showCompletionDate: true,
      showIssueDate: true,
      showCertificateNumber: true,
      showSourceLabel: false,
      footerNote: null,
    },
  },
  /**
   * Template 2: ASRA QUIZORA 2026 — Certificate of Participation (Design 2). Independent artwork
   * (script recipient name, bottom-centre QR); same engine, rules and signature enforcement.
   */
  {
    key: QUIZORA_2026_DESIGN_2_TEMPLATE_KEY,
    name: 'ASRA QUIZORA 2026 — Certificate of Participation (Design 2)',
    style: QUIZORA_2026_DESIGN_2_TEMPLATE_STYLE,
    description:
      'Landscape 1536 × 1024 artwork template, Design 2 (category QUIZ_PARTICIPATION). Script recipient name, statement, completion & issue dates, certificate ID and bottom-centre verification QR are dynamic. Requires exactly 2 signatures: Event Coordinator and Director. Never displays scores, marks, percentages or ranks.',
    defaultTitle: 'Certificate of Participation',
    defaultSubtitle: null,
    defaultBodyText: QUIZORA_2026_DESIGN_2_DEFAULT_BODY_TEXT,
    issuingAuthority: 'ASRA Academy',
    isDefault: false,
    config: {
      accentColor: '#0B1638',
      secondaryColor: '#C9A13B',
      showLogo: true,
      showSeal: true,
      showQrCode: true,
      showCompletionDate: true,
      showIssueDate: true,
      showCertificateNumber: true,
      showSourceLabel: false,
      footerNote: null,
    },
  },
];
