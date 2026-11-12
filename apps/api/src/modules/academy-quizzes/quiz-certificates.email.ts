import type { QuizCertificateCategory, QuizCertificateFormat } from '@asra/types';
import { env } from '../../config/env.js';
import { renderBrandedEmail, type RenderedEmail } from '../../email/templates.js';

export interface QuizCertificateEmailInput {
  recipientName: string;
  quizTitle: string;
  category: QuizCertificateCategory;
  rank: number | null;
  certificateId: string;
  certificateNumber: string;
  issuedAt: Date;
  format: QuizCertificateFormat;
  showInStudentDashboard: boolean;
}

const FORMAT_LABELS: Record<QuizCertificateFormat, string> = {
  PDF: 'PDF',
  PNG: 'PNG Image',
  BOTH: 'PDF & PNG Image',
};

function ordinalRank(rank: number): string {
  const mod100 = rank % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${rank}th`;
  switch (rank % 10) {
    case 1:
      return `${rank}st`;
    case 2:
      return `${rank}nd`;
    case 3:
      return `${rank}rd`;
    default:
      return `${rank}th`;
  }
}

export function formatQuizCertificateDate(date: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(date);
}

export function buildQuizCertificateTexts(input: {
  quizTitle: string;
  category: QuizCertificateCategory;
  rank: number | null;
  percent: number | null;
  templateDefaultTitle: string;
  templateDefaultBody: string;
}): {
  certificateTitle: string;
  description: string;
  achievementDetails: string | null;
} {
  const scorePart = input.percent !== null ? `Score: ${input.percent}%` : null;
  if (input.category === 'RANK' && input.rank !== null) {
    return {
      certificateTitle: input.templateDefaultTitle || 'CERTIFICATE OF ACHIEVEMENT',
      description: `in recognition of securing Rank #${input.rank} in the Academy Quiz`,
      achievementDetails: scorePart ? `Rank #${input.rank} · ${scorePart}` : `Rank #${input.rank}`,
    };
  }
  return {
    certificateTitle: input.templateDefaultTitle || 'CERTIFICATE OF PARTICIPATION',
    description: 'for actively participating and completing the Academy Quiz',
    achievementDetails: scorePart
      ? `Academy Quiz Participant · ${scorePart}`
      : 'Academy Quiz Participant',
  };
}

/**
 * Renders the congratulations email sent to a student once their Academy Quiz certificate has
 * been generated. Uses the canonical ASRA Academy branded email layout (Resend-compatible).
 */
export function renderQuizCertificateEmail(input: QuizCertificateEmailInput): RenderedEmail {
  const baseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
  const dashboardUrl = `${baseUrl}/student/dashboard`;
  const certificatesUrl = `${baseUrl}/student/certificates`;
  const downloadQuery = input.format === 'PNG' ? 'png' : 'pdf';
  const secureDownloadUrl = `${certificatesUrl}?certificateId=${encodeURIComponent(input.certificateId)}&download=${downloadQuery}`;
  const verifyUrl = `${baseUrl}/verify/${encodeURIComponent(input.certificateNumber)}`;

  const hasRank = input.rank !== null && input.rank > 0;
  const isRankAward = input.category === 'RANK' && hasRank;

  const intro = isRankAward
    ? `Congratulations on securing ${ordinalRank(input.rank!)} Place in "${input.quizTitle}" at ASRA Academy! Your official quiz achievement certificate is now ready to view and download.`
    : `Congratulations on completing "${input.quizTitle}" at ASRA Academy! Your official quiz participation certificate is now ready to view and download.`;

  const details: { label: string; value: string }[] = [
    { label: 'Quiz', value: input.quizTitle },
    ...(isRankAward
      ? [{ label: 'Rank', value: `Rank #${input.rank} (${ordinalRank(input.rank!)})` }]
      : []),
    { label: 'Certificate ID', value: input.certificateNumber },
    { label: 'Issue Date', value: formatQuizCertificateDate(input.issuedAt) },
    { label: 'Format', value: FORMAT_LABELS[input.format] },
  ];

  const primaryUrl = input.showInStudentDashboard ? secureDownloadUrl : verifyUrl;
  const primaryLabel = input.showInStudentDashboard
    ? 'Download Certificate'
    : 'View Verification Record';

  const links: { label: string; url: string }[] = [
    { label: 'Student Dashboard', url: dashboardUrl },
    ...(input.showInStudentDashboard
      ? [{ label: 'Verify Credential', url: verifyUrl }]
      : [{ label: 'Certificates Portal', url: certificatesUrl }]),
  ];

  return renderBrandedEmail({
    recipientName: input.recipientName,
    subject: 'Congratulations! Your ASRA Academy Quiz Certificate is Ready',
    heading: isRankAward
      ? `Congratulations on Rank #${input.rank}!`
      : 'Your Quiz Certificate is Ready',
    intro,
    details,
    action: { label: primaryLabel, url: primaryUrl },
    links,
    footnote:
      'Sign in to your ASRA Academy student account to securely download your official PDF/PNG certificate at any time.',
  });
}
