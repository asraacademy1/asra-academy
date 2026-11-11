import type { Metadata } from 'next';
import { CertificatesGenerateAdmin } from '@/components/admin/certificates/certificates-generate';

export const metadata: Metadata = { title: 'Generate Certificate' };

export default function CertificatesGeneratePage() {
  return <CertificatesGenerateAdmin />;
}
