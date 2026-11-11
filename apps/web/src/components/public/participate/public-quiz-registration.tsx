'use client';

import type {
  PublicAcademyQuizDetail,
  QuizRegistrationResultDto,
  QuizRegistrationStatusDto,
} from '@asra/types';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  Loader2,
  MailCheck,
  ShieldAlert,
  Timer,
  UserCheck,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { AuthProvider, useAuth } from '@/components/auth/auth-provider';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { ApiClientError } from '@/lib/api';
import { authApi } from '@/lib/auth/auth-api';
import { describeError } from '@/lib/auth/form-errors';
import { loginHref, rememberReturnTo } from '@/lib/auth/return-to';
import { formatDateTime } from '@/lib/format';
import { formatQuizWindowIst, publicQuizHref, timingLabel } from '@/lib/participate';
import { academyQuizHref } from '@/lib/student/academy-quizzes';

type QuizRegistrationTarget = Pick<
  PublicAcademyQuizDetail,
  | 'id'
  | 'slug'
  | 'title'
  | 'phase'
  | 'startsAt'
  | 'endsAt'
  | 'timerMode'
  | 'durationMinutes'
  | 'questionTimeSeconds'
  | 'registrationOpen'
  | 'registrationClosedReason'
>;

export function PublicQuizRegistration({ quiz }: { quiz: QuizRegistrationTarget }) {
  return (
    <AuthProvider>
      <PublicQuizRegistrationPanel quiz={quiz} />
    </AuthProvider>
  );
}

export function PublicQuizRegistrationPanel({ quiz }: { quiz: QuizRegistrationTarget }) {
  const { status, user, authorizedRequest } = useAuth();
  const path = publicQuizHref(quiz.slug);
  const regEndpoint = `/participate/quizzes/${encodeURIComponent(quiz.slug)}/registration`;
  const registerEndpoint = `/participate/quizzes/${encodeURIComponent(quiz.slug)}/register`;

  const [regStatus, setRegStatus] = React.useState<QuizRegistrationStatusDto | null>(null);
  const [loadingStatus, setLoadingStatus] = React.useState(false);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [justRegistered, setJustRegistered] = React.useState(false);
  const [resending, setResending] = React.useState(false);
  const [resendDone, setResendDone] = React.useState(false);

  const loadRegistration = React.useCallback(async () => {
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const data = await authorizedRequest<QuizRegistrationStatusDto>(regEndpoint);
      setRegStatus(data);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        setRegStatus(null);
      } else {
        setStatusError(describeError(error).message);
      }
    } finally {
      setLoadingStatus(false);
    }
  }, [authorizedRequest, regEndpoint]);

  React.useEffect(() => {
    if (status === 'authenticated') {
      void loadRegistration();
    } else {
      setRegStatus(null);
      setStatusError(null);
    }
  }, [status, loadRegistration]);

  function redirectToLogin() {
    rememberReturnTo(path);
    if (typeof window !== 'undefined') {
      window.location.assign(loginHref(path));
    }
  }

  function handleRegisterClick() {
    setSubmitError(null);
    if (status === 'anonymous') {
      redirectToLogin();
      return;
    }
    if (status !== 'authenticated') return;
    if (user && !user.emailVerified) return;
    if (regStatus && !regStatus.canRegister) return;
    setConfirmOpen(true);
  }

  async function confirmRegistration() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await authorizedRequest<QuizRegistrationResultDto>(registerEndpoint, {
        method: 'POST',
        body: {},
      });
      setRegStatus((current) => ({
        quizId: result.quizId,
        slug: result.slug,
        registered: true,
        registeredAt: result.registeredAt,
        emailVerified: true,
        canRegister: false,
        blockedCode: 'ALREADY_REGISTERED',
        blockedReason: 'You are already registered for this quiz.',
        eligibleClasses: current?.eligibleClasses ?? [],
        eligibleStreams: current?.eligibleStreams ?? [],
      }));
      setJustRegistered(true);
      setConfirmOpen(false);
      toast.success('Registration confirmed', {
        description: `You are now registered for ${quiz.title}.`,
      });
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        setConfirmOpen(false);
        redirectToLogin();
        return;
      }
      if (error instanceof ApiClientError && error.code === 'EMAIL_NOT_VERIFIED') {
        setConfirmOpen(false);
        setRegStatus((current) =>
          current
            ? {
                ...current,
                emailVerified: false,
                canRegister: false,
                blockedCode: 'EMAIL_NOT_VERIFIED',
                blockedReason: error.message,
              }
            : current,
        );
        toast.error('Account verification required', { description: error.message });
        return;
      }
      if (error instanceof ApiClientError && error.status === 409) {
        // Re-sync state from backend in case the quiz closed or another tab registered already.
        await loadRegistration();
      }
      const message = describeError(error).message;
      setSubmitError(message);
      toast.error('Could not complete registration', { description: message });
    } finally {
      setSubmitting(false);
    }
  }

  async function resendVerification() {
    if (!user?.email || resending) return;
    setResending(true);
    try {
      await authApi.resendVerification({ email: user.email });
      setResendDone(true);
      toast.success('Verification email sent', {
        description: 'Check your inbox for the verification link.',
      });
    } catch (error) {
      toast.error('Could not send verification email', {
        description: describeError(error).message,
      });
    } finally {
      setResending(false);
    }
  }

  // Already registered (either from DB fetch or fresh POST confirmation)
  if (regStatus?.registered) {
    const portalHref = academyQuizHref(quiz.slug);
    const registeredWhen = formatDateTime(regStatus.registeredAt);
    return (
      <div className="grid gap-3 border-t pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="success">
            <CheckCircle2 aria-hidden /> Registered
          </Badge>
          {registeredWhen ? (
            <span className="type-caption text-muted-foreground">on {registeredWhen} IST</span>
          ) : null}
        </div>
        {justRegistered ? (
          <Alert tone="success" title="Registration confirmed">
            <p>
              You are registered for {quiz.title}. Open the student quiz portal to begin when the
              quiz is live.
            </p>
          </Alert>
        ) : null}
        <Button type="button" variant="secondary" disabled className="w-full">
          <UserCheck aria-hidden /> Already Registered
        </Button>
        <Button asChild variant="outline" className="w-full">
          <Link href={portalHref}>
            {quiz.phase === 'LIVE' ? 'Open quiz in student portal' : 'View in student portal'}{' '}
            <ExternalLink aria-hidden />
          </Link>
        </Button>
      </div>
    );
  }

  // Quiz closed or past deadline
  if (!quiz.registrationOpen) {
    return (
      <div className="grid gap-3 border-t pt-4">
        <Alert tone="info" title="Registration unavailable">
          <p>{quiz.registrationClosedReason ?? 'Registration is closed for this quiz.'}</p>
        </Alert>
        <Button type="button" variant="secondary" disabled className="w-full">
          Registration Closed
        </Button>
      </div>
    );
  }

  // Loading auth or loading authenticated status
  if (status === 'loading' || (status === 'authenticated' && loadingStatus && !regStatus)) {
    return (
      <div className="grid gap-2 border-t pt-4">
        <Button type="button" disabled className="w-full">
          <Loader2 className="animate-spin" aria-hidden /> Checking eligibility…
        </Button>
      </div>
    );
  }

  // Anonymous visitor -> link directly to login with preserved return URL
  if (status === 'anonymous') {
    const nextRegisterHref = `/register?next=${encodeURIComponent(path)}`;
    return (
      <div className="grid gap-3 border-t pt-4">
        <Button asChild size="lg" className="w-full">
          <Link href={loginHref(path)} onClick={() => rememberReturnTo(path)}>
            Register Now
          </Link>
        </Button>
        <p className="type-caption text-muted-foreground">
          You must be signed in with a verified student account to register. New here?{' '}
          <Link
            href={nextRegisterHref}
            onClick={() => rememberReturnTo(path)}
            className="font-medium text-primary underline underline-offset-2 hover:no-underline"
          >
            Create an account
          </Link>
          .
        </p>
      </div>
    );
  }

  // Status load error for authenticated user
  if (statusError && !regStatus) {
    return (
      <div className="grid gap-3 border-t pt-4">
        <Alert tone="error" title="Could not check registration status">
          <p>{statusError}</p>
        </Alert>
        <Button type="button" variant="outline" onClick={() => void loadRegistration()}>
          Try again
        </Button>
      </div>
    );
  }

  // Logged in but email not verified (checked against both session & DB)
  const isUnverified = (user && !user.emailVerified) || (regStatus && !regStatus.emailVerified);
  if (isUnverified) {
    return (
      <div className="grid gap-3 border-t pt-4">
        <Alert tone="warning" title="Verify your email to register">
          <p>
            Your account is not verified yet. Complete email verification before registering for
            this quiz.
          </p>
        </Alert>
        {resendDone ? (
          <p className="flex items-center gap-2 type-body-sm font-medium text-asra-green-700">
            <MailCheck className="size-4 shrink-0" aria-hidden /> A verification link has been sent
            to {user?.email}.
          </p>
        ) : (
          <div className="grid gap-2">
            {user?.email ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void resendVerification()}
                loading={resending}
                loadingText="Sending…"
              >
                Resend verification email
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link href="/verify-email" onClick={() => rememberReturnTo(path)}>
                Open verification flow
              </Link>
            </Button>
          </div>
        )}
        <Button type="button" disabled className="w-full">
          Verify Email Required
        </Button>
      </div>
    );
  }

  // Logged in, verified, but blocked (non-student account, ineligible class/stream, or closed on server)
  if (regStatus && !regStatus.canRegister) {
    const isEligibilityBlock = regStatus.blockedCode === 'NOT_ELIGIBLE';
    return (
      <div className="grid gap-3 border-t pt-4">
        <Alert
          tone={isEligibilityBlock ? 'warning' : 'info'}
          title={
            regStatus.blockedCode === 'NOT_STUDENT'
              ? 'Student account required'
              : isEligibilityBlock
                ? 'Not eligible for this quiz'
                : 'Registration unavailable'
          }
        >
          <p>{regStatus.blockedReason}</p>
          {isEligibilityBlock ? (
            <p className="mt-2">
              Your class and stream come from your{' '}
              <Link href="/student/profile" className="underline hover:text-primary">
                student profile
              </Link>
              .
            </p>
          ) : null}
        </Alert>
        <Button type="button" variant="secondary" disabled className="w-full">
          <ShieldAlert aria-hidden /> Unavailable
        </Button>
      </div>
    );
  }

  // Logged in, verified, eligible, not registered -> show Register Now + Confirmation Modal
  return (
    <div className="grid gap-3 border-t pt-4">
      {submitError ? (
        <Alert tone="error">
          <p className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{submitError}</span>
          </p>
        </Alert>
      ) : null}
      <Button type="button" size="lg" className="w-full" onClick={handleRegisterClick}>
        Register Now
      </Button>
      <p className="type-caption text-muted-foreground">
        Free registration with your verified student account.
      </p>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!submitting) {
            setConfirmOpen(open);
            if (!open) setSubmitError(null);
          }
        }}
      >
        <DialogContent showCloseButton={!submitting}>
          <DialogHeader>
            <DialogTitle>Confirm Quiz Registration</DialogTitle>
            <DialogDescription>Are you sure you want to register for this quiz?</DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 rounded-xl border bg-secondary/40 p-4 type-body-sm">
            <p className="type-label text-heading">{quiz.title}</p>
            <dl className="grid gap-1.5 text-muted-foreground">
              <div className="flex items-start gap-2">
                <CalendarClock className="mt-0.5 size-4 shrink-0" aria-hidden />
                <dd>{formatQuizWindowIst(quiz.startsAt, quiz.endsAt)}</dd>
              </div>
              <div className="flex items-start gap-2">
                <Timer className="mt-0.5 size-4 shrink-0" aria-hidden />
                <dd>{timingLabel(quiz)}</dd>
              </div>
            </dl>
          </div>

          {submitError ? (
            <Alert tone="error">
              <p>{submitError}</p>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={submitting}
              onClick={() => setConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              loading={submitting}
              loadingText="Registering…"
              onClick={() => void confirmRegistration()}
            >
              Confirm Registration
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
