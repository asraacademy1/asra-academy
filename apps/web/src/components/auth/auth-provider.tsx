'use client';

import type { AuthSessionData, AuthUser } from '@asra/types';
import type { LoginInput } from '@asra/validation';
import * as React from 'react';
import {
  ApiClientError,
  apiRequest,
  buildApiUrl,
  type ApiRequestOptions,
  type ClientErrorCode,
} from '@/lib/api';
import { authApi } from '@/lib/auth/auth-api';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: (input: LoginInput) => Promise<AuthUser>;
  logout: () => Promise<void>;
  logoutAllDevices: () => Promise<void>;
  /** Calls a protected endpoint; refreshes once on 401, then gives up (no retry loops). */
  authorizedRequest: <T>(
    path: string,
    options?: Omit<ApiRequestOptions, 'accessToken'>,
  ) => Promise<T>;
  /** Downloads a binary asset from a protected endpoint with authentication. */
  authorizedDownload: (path: string) => Promise<Blob>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

/** Refresh this many seconds before the access token expires. */
const REFRESH_LEAD_SECONDS = 60;

/**
 * Session state for the browser.
 *
 * - The access token lives ONLY in a ref (memory). It is never written to localStorage,
 *   sessionStorage or cookies, and disappears on reload.
 * - On mount, one `POST /auth/refresh` restores the session from the HttpOnly refresh cookie.
 * - Refreshes are single-flight: concurrent callers share one request, which matters because
 *   the API treats a reused refresh token as theft and revokes the session.
 * - The token is refreshed shortly before it expires.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<AuthStatus>('loading');
  const [user, setUser] = React.useState<AuthUser | null>(null);
  const accessToken = React.useRef<string | null>(null);
  const refreshInFlight = React.useRef<Promise<AuthSessionData | null> | null>(null);
  const refreshTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSession = React.useCallback(() => {
    accessToken.current = null;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    setUser(null);
    setStatus('anonymous');
  }, []);

  const refresh = React.useCallback((): Promise<AuthSessionData | null> => {
    refreshInFlight.current ??= authApi
      .refresh()
      .then((session) => {
        applySessionRef.current(session);
        return session;
      })
      .catch((error: unknown) => {
        // Network failures keep the current state; an invalid session signs the user out.
        if (!(error instanceof ApiClientError) || error.code !== 'NETWORK_ERROR') clearSession();
        return null;
      })
      .finally(() => {
        refreshInFlight.current = null;
      });
    return refreshInFlight.current;
  }, [clearSession]);

  const applySession = React.useCallback(
    (session: AuthSessionData) => {
      accessToken.current = session.accessToken;
      setUser(session.user);
      setStatus('authenticated');
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      const delay = Math.max(session.expiresIn - REFRESH_LEAD_SECONDS, 10) * 1000;
      refreshTimer.current = setTimeout(() => void refresh(), delay);
    },
    [refresh],
  );
  // `refresh` and `applySession` reference each other; a ref breaks the cycle.
  const applySessionRef = React.useRef(applySession);
  React.useEffect(() => {
    applySessionRef.current = applySession;
  }, [applySession]);

  React.useEffect(() => {
    void refresh();
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refresh]);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      async login(input) {
        const session = await authApi.login(input);
        applySession(session);
        return session.user;
      },
      async logout() {
        try {
          await authApi.logout();
        } finally {
          clearSession();
        }
      },
      async logoutAllDevices() {
        try {
          if (accessToken.current) await authApi.logoutAll(accessToken.current);
        } finally {
          clearSession();
        }
      },
      async authorizedRequest<T>(
        path: string,
        options: Omit<ApiRequestOptions, 'accessToken'> = {},
      ) {
        const token = accessToken.current ?? (await refresh())?.accessToken;
        if (!token) throw new ApiClientError(401, 'UNAUTHORIZED', 'Please sign in to continue.');
        try {
          return await apiRequest<T>(path, { ...options, accessToken: token });
        } catch (error) {
          if (!(error instanceof ApiClientError) || error.status !== 401) throw error;
          const renewed = await refresh();
          if (!renewed)
            throw new ApiClientError(
              401,
              'UNAUTHORIZED',
              'Your session has expired. Please sign in again.',
            );
          return apiRequest<T>(path, { ...options, accessToken: renewed.accessToken });
        }
      },
      async authorizedDownload(path: string): Promise<Blob> {
        let token = accessToken.current ?? (await refresh())?.accessToken;
        if (!token) throw new ApiClientError(401, 'UNAUTHORIZED', 'Please sign in to continue.');
        const url = buildApiUrl(path);
        let res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'include',
        });
        if (res.status === 401) {
          const renewed = await refresh();
          if (!renewed) {
            throw new ApiClientError(
              401,
              'UNAUTHORIZED',
              'Your session has expired. Please sign in again.',
            );
          }
          token = renewed.accessToken;
          res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            credentials: 'include',
          });
        }
        if (!res.ok) {
          let code: ClientErrorCode = 'BAD_REQUEST';
          let message = 'Failed to download file.';
          try {
            const errBody = (await res.json()) as {
              error?: { code?: ClientErrorCode };
              message?: string;
            };
            if (errBody?.error?.code) code = errBody.error.code;
            if (errBody?.message) message = errBody.message;
          } catch {
            // Keep fallback message for non-JSON error bodies
          }
          throw new ApiClientError(res.status, code, message);
        }
        return res.blob();
      },
    }),
    [status, user, applySession, clearSession, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
