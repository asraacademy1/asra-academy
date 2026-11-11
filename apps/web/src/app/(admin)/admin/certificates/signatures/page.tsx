import type { Metadata } from 'next';
import { CertificatesSignaturesAdmin } from '@/components/admin/certificates/certificates-signatures';

export const metadata: Metadata = { title: 'Digital Signatures' };

export default function CertificatesSignaturesPage() {
  return <CertificatesSignaturesAdmin />;
}
