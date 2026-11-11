import type { Metadata } from 'next';
import * as React from 'react';
import { CertificatesIssuedAdmin } from '@/components/admin/certificates/certificates-issued';
import { LoadingPanel } from '@/components/admin/admin-ui';

export const metadata: Metadata = { title: 'Issued Certificates' };

export default function CertificatesIssuedPage() {
  return (
    <React.Suspense fallback={<LoadingPanel label="Loading issued certificates…" />}>
      <CertificatesIssuedAdmin />
    </React.Suspense>
  );
}
