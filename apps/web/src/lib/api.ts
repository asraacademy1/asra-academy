import type { ApiErrorCode, ApiResponse, HealthData } from '@asra/types';
import { unstable_rethrow } from 'next/navigation';
import { publicEnv } from './env';

/** Client-side error codes for failures that never reached the API's envelope. */
export type ClientErrorCode = ApiErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE';

/** A failed API call, normalised from the `{ success: false, error }` envelope. */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }

  /**
   * Field → first message, from a 422 response's Zod issues or a 409 field conflict (e.g. a
   * duplicate slug), which the API reports in the same `{ path, message }` shape.
   */
  get fieldErrors(): Record<string, string> {
    if (!['VALIDATION_ERROR', 'CONFLICT'].includes(this.code) || !Array.isArray(this.details)) {
      return {};
    }
    const errors: Record<string, string> = {};
    for (const issue of this.details as { path?: unknown[]; message?: string }[]) {
      const field = issue.path?.[0];
      if (typeof field === 'string' && issue.message && !errors[field])
        errors[field] = issue.message;
    }
    return errors;
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** In-memory access token; sent as `Authorization: Bearer`. Never persisted. */
  accessToken?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  next?: { revalidate?: number | false; tags?: string[] };
  cache?: RequestCache;
}

/**
 * The single fetch wrapper for the ASRA API. Always sends cookies (`credentials: 'include'`)
 * so the HttpOnly refresh cookie reaches `/auth/*`; never retries automatically.
 * Resolves with `data` on success, throws `ApiClientError` otherwise.
 */
export async function apiRequest<TData>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<TData> {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  // A Blob (e.g. a compressed image) is sent as raw bytes with its own type.
  const isBlob = typeof Blob !== 'undefined' && options.body instanceof Blob;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (isBlob) headers['Content-Type'] = (options.body as Blob).type || 'application/octet-stream';
  else if (options.body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

  let response: Response;
  try {
    response = await fetch(`${publicEnv.NEXT_PUBLIC_API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body:
        options.body === undefined
          ? undefined
          : isFormData || isBlob
            ? (options.body as BodyInit)
            : JSON.stringify(options.body),
      credentials: 'include',
      cache: options.cache ?? (options.next ? undefined : 'no-store'),
      next: options.next,
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    // On the server, Next.js may throw from a `no-store` fetch to switch a route to request-time
    // rendering (e.g. /courses/<slug> pages that were not prerendered). That is control flow, not
    // a network failure, and must reach Next.js untouched. A no-op for every other error.
    unstable_rethrow(error);
    throw new ApiClientError(
      0,
      'NETWORK_ERROR',
      'Cannot reach the server. Check your connection and try again.',
    );
  }

  let body: ApiResponse<TData>;
  try {
    body = (await response.json()) as ApiResponse<TData>;
  } catch {
    throw new ApiClientError(
      response.status,
      'INVALID_RESPONSE',
      'Unexpected response from the server.',
    );
  }

  if (!body.success) {
    throw new ApiClientError(response.status, body.error.code, body.message, body.error.details);
  }
  return body.data;
}

export type ApiHealthResult =
  { ok: true; message: string; data: HealthData } | { ok: false; message: string };

/** Fetches the API liveness endpoint. Never throws — the page renders either way. */
export async function getApiHealth(): Promise<ApiHealthResult> {
  try {
    const data = await apiRequest<HealthData>('/health', { timeoutMs: 3_000 });
    return { ok: true, message: 'ASRA Academy API is running', data };
  } catch {
    return { ok: false, message: 'API is not reachable' };
  }
}
