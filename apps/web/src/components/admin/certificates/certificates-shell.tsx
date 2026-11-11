'use client';

import { PERMISSIONS } from '@asra/types';
import * as React from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import {
  CertificateSourceBadge,
  certificateSignatureImageSrc,
} from '@/components/certificates/certificate-preview';
import { PageHeader } from '@/components/layout/page-header';
import { SubNav } from '../admin-kit';
import { hasPermission } from '../use-admin';

export function CertificatesHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  const { user } = useAuth();
  const can = (perm: string) => hasPermission(user, perm);
  const canIssue = can(PERMISSIONS.CERTIFICATES_ISSUE) || can(PERMISSIONS.CERTIFICATES_MANAGE);

  return (
    <div className="mb-6 grid gap-4">
      <PageHeader
        title={title}
        description={description}
        breadcrumbs={[
          { label: 'Overview', href: '/admin' },
          { label: 'Certificates', href: '/admin/certificates' },
          ...(title === 'Certificate Management' ? [] : [{ label: title }]),
        ]}
        actions={actions}
      />
      <SubNav
        label="Certificate Management"
        items={[
          { href: '/admin/certificates', label: 'Overview', exact: true },
          { href: '/admin/certificates/templates', label: 'Templates' },
          { href: '/admin/certificates/signatures', label: 'Digital Signatures' },
          { href: '/admin/certificates/issued', label: 'Issued Certificates' },
          ...(canIssue
            ? [{ href: '/admin/certificates/generate', label: 'Manual Generation' }]
            : []),
          { href: '/admin/certificates/settings', label: 'Verification & Settings' },
        ]}
      />
    </div>
  );
}

export const signatureImageSrc = certificateSignatureImageSrc;
export const SourceTypeBadge = CertificateSourceBadge;
