import type { Metadata } from 'next';
import { CertificatesTemplatesAdmin } from '@/components/admin/certificates/certificates-templates';

export const metadata: Metadata = { title: 'Certificate Templates' };

export default function CertificatesTemplatesPage() {
  return <CertificatesTemplatesAdmin />;
}
