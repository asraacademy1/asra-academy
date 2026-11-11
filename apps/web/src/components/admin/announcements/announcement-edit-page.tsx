'use client';

import type { AdminAnnouncementDetail } from '@asra/types';
import * as React from 'react';

import { ErrorPanel, LoadingPanel } from '../admin-ui';
import { errorMessage, useAdminApi, useApiResource } from '../use-admin';
import { AnnouncementForm } from './announcement-form';

export function AnnouncementEditPage({ id }: { id: string }) {
  const api = useAdminApi();
  const resource = useApiResource(id, () =>
    api.get<AdminAnnouncementDetail>(`/admin/announcements/${id}`),
  );

  if (resource.error && !resource.data) {
    return <ErrorPanel message={errorMessage(resource.error)} onRetry={resource.reload} />;
  }
  if (!resource.data) {
    return <LoadingPanel label="Loading announcement…" />;
  }
  return <AnnouncementForm announcement={resource.data} onUpdated={resource.replace} />;
}
