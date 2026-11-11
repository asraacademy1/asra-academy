import type { Metadata } from 'next';
import { CertificatesSettingsAdmin } from '@/components/admin/certificates/certificates-settings';

export const metadata: Metadata = { title: 'Certificate Verification & Settings' };

export default function CertificatesSettingsPage() {
  return <CertificatesSettingsAdmin />;
}
