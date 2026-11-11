import type { Metadata } from 'next';
import { CertificatesOverview } from '@/components/admin/certificates/certificates-overview';

export const metadata: Metadata = { title: 'Certificate Management' };

export default function CertificatesAdminPage() {
  return <CertificatesOverview />;
}
