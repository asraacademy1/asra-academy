'use client';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, registerSchema } from '@asra/validation';
import { MailCheck } from 'lucide-react';
import * as React from 'react';
import { AuthCard, AuthLink } from '@/components/auth/auth-card';
import { FormAlert, FormField, PasswordField, SubmitButton } from '@/components/auth/form-controls';
import { authApi } from '@/lib/auth/auth-api';
import { rememberReturnTo, useRememberedLoginHref } from '@/lib/auth/return-to';
import { describeError, validateForm, type FieldErrors } from '@/lib/auth/form-errors';

/** Public self-registration — always creates a STUDENT account (no role choice is offered). */
export function RegisterForm() {
  const [pending, setPending] = React.useState(false);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [error, setError] = React.useState<string | null>(null);
  const [submittedEmail, setSubmittedEmail] = React.useState<string | null>(null);
  // `?next=` (e.g. the course checkout a visitor started from) survives email verification.
  React.useEffect(
    () => rememberReturnTo(new URLSearchParams(window.location.search).get('next')),
    [],
  );
  const signIn = useRememberedLoginHref();

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = validateForm(registerSchema, {
      fullName: form.get('fullName'),
      email: form.get('email'),
      password: form.get('password'),
    });
    setError(null);
    if (parsed.errors) return setErrors(parsed.errors);

    setErrors({});
    setPending(true);
    try {
      await authApi.register(parsed.data);
      setSubmittedEmail(parsed.data.email);
    } catch (caught) {
      const { message, fieldErrors } = describeError(caught);
      setErrors(fieldErrors);
      setError(message);
    } finally {
      setPending(false);
    }
  }

  if (submittedEmail) {
    return (
      <AuthCard
        title="Check your email"
        footer={
          <p>
            Already verified? <AuthLink href={signIn}>Sign in</AuthLink>
          </p>
        }
      >
        <div className="grid justify-items-center gap-4 text-center">
          <span className="inline-flex size-14 items-center justify-center rounded-full bg-asra-green-100 text-asra-green-700">
            <MailCheck className="size-7" aria-hidden />
          </span>
          <p className="text-sm text-muted-foreground" role="status">
            If <strong className="text-foreground">{submittedEmail}</strong> can be used for a new
            account, we have sent a verification link to it. Open the link to activate your account,
            then sign in.
          </p>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your account"
      description="Join ASRA Academy as a student."
      footer={
        <p>
          Already have an account? <AuthLink href={signIn}>Sign in</AuthLink>
        </p>
      }
    >
      <form onSubmit={onSubmit} noValidate className="grid gap-5">
        {error ? <FormAlert tone="error">{error}</FormAlert> : null}
        <FormField
          id="fullName"
          label="Full name"
          autoComplete="name"
          required
          error={errors.fullName}
        />
        <FormField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          error={errors.email}
        />
        <PasswordField
          id="password"
          label="Password"
          autoComplete="new-password"
          required
          maxLength={PASSWORD_MAX_LENGTH}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A memorable phrase works well.`}
          error={errors.password}
        />
        <SubmitButton pending={pending} pendingLabel="Creating account…">
          Create account
        </SubmitButton>
      </form>
    </AuthCard>
  );
}
