'use client';

import { PERMISSIONS, type AuthUser } from '@asra/types';
import * as React from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import { ApiClientError, type ApiRequestOptions } from '@/lib/api';

/**
 * Data access for the admin portal. TanStack Query is not part of the approved stack yet
 * (ARCHITECTURE §2 "later"), so this is a deliberately small layer over `authorizedRequest`
 * (in-memory access token, one refresh on 401). Authorization is enforced by the API; the
 * permission helpers below only decide what the UI offers.
 */

export const ADMIN_PERMISSIONS = [
  PERMISSIONS.ACADEMIC_STRUCTURE_MANAGE,
  PERMISSIONS.COURSES_MANAGE,
  PERMISSIONS.CONTENT_MANAGE,
  PERMISSIONS.LIVE_CLASSES_MANAGE,
  PERMISSIONS.PAYMENTS_VIEW,
  PERMISSIONS.ANALYTICS_VIEW,
  PERMISSIONS.STUDENTS_MANAGE,
  PERMISSIONS.FACULTY_MANAGE,
  PERMISSIONS.ADMINS_MANAGE,
  PERMISSIONS.ENROLLMENTS_MANAGE,
  PERMISSIONS.NOTIFICATIONS_VIEW,
  PERMISSIONS.ROLES_MANAGE,
  PERMISSIONS.AUDIT_LOGS_VIEW,
  PERMISSIONS.CERTIFICATES_VIEW,
  PERMISSIONS.CERTIFICATES_MANAGE,
  PERMISSIONS.CERTIFICATES_TEMPLATES_MANAGE,
  PERMISSIONS.CERTIFICATES_SIGNATURES_MANAGE,
  PERMISSIONS.CERTIFICATES_ISSUE,
  PERMISSIONS.CERTIFICATES_REVOKE,
  PERMISSIONS.RECRUITMENT_MANAGE,
  PERMISSIONS.ACADEMY_QUIZZES_MANAGE,
  PERMISSIONS.ANNOUNCEMENTS_MANAGE,
] as const;

/**
 * True when the user's EFFECTIVE permissions (the union of their role grants, as returned by
 * `/auth/me`) include `permission`. Role names are deliberately not consulted: the API authorizes
 * by permission, so the UI must offer exactly what the API will allow — e.g. an Admin never holds
 * `admins.manage`, `roles.manage` or `audit_logs.view` and must not see those areas.
 */
export function hasPermission(user: AuthUser | null, permission: string): boolean {
  if (!user) return false;
  return user.permissions.includes(permission);
}

/** True when the user can use at least one area of the admin portal. */
export function canUseAdminPortal(user: AuthUser | null): boolean {
  if (!user) return false;
  return ADMIN_PERMISSIONS.some((permission) => hasPermission(user, permission));
}

export function useAdminApi() {
  const { authorizedRequest, authorizedDownload } = useAuth();
  return React.useMemo(() => {
    const send =
      (method: NonNullable<ApiRequestOptions['method']>) =>
      <T>(path: string, body?: unknown) =>
        authorizedRequest<T>(path, { method, ...(body === undefined ? {} : { body }) });
    return {
      get: <T>(path: string) => authorizedRequest<T>(path),
      post: send('POST'),
      patch: send('PATCH'),
      put: send('PUT'),
      del: send('DELETE'),
      download: (path: string) => authorizedDownload(path),
    };
  }, [authorizedRequest, authorizedDownload]);
}

export type AdminApi = ReturnType<typeof useAdminApi>;

interface ResourceResult<T> {
  key: string;
  version: number;
  data?: T;
  error?: Error;
}

/**
 * Loads data for `key` (anything that changes the request: path, filters, page) and reloads on
 * demand. Previous data stays visible while a new request runs, so tables do not flash empty.
 * State is only set from the async result (React Compiler lint: no synchronous setState in
 * effects), and late responses for an old key are ignored.
 */
export function useApiResource<T>(key: string | null, load: () => Promise<T>) {
  const [result, setResult] = React.useState<ResourceResult<T> | null>(null);
  const [version, setVersion] = React.useState(0);
  const loadRef = React.useRef(load);

  React.useEffect(() => {
    loadRef.current = load;
  });

  React.useEffect(() => {
    if (key === null) return;
    let active = true;
    loadRef.current().then(
      (data) => active && setResult({ key, version, data }),
      (error: unknown) =>
        active &&
        setResult({
          key,
          version,
          error: error instanceof Error ? error : new Error('Something went wrong'),
        }),
    );
    return () => {
      active = false;
    };
  }, [key, version]);

  const current = result?.key === key && result.version === version;
  return {
    data: result?.data,
    error: current ? result?.error : undefined,
    loading: key !== null && !current,
    reload: React.useCallback(() => setVersion((value) => value + 1), []),
    /** Replace the data with a server response (e.g. the updated course after a save). */
    replace: React.useCallback(
      (data: T) => setResult({ key: key ?? '', version, data }),
      [key, version],
    ),
  };
}

/** A user-facing message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError || error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
