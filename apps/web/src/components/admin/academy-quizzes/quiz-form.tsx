'use client';

import {
  PERMISSIONS,
  type AdminAcademyQuizDetail,
  type ClassDto,
  type Paginated,
  type StreamDto,
} from '@asra/types';
import {
  ACADEMY_QUIZ_DEFAULTS,
  ACADEMY_QUIZ_LIMITS,
  ANSWER_REVEALS,
  ATTEMPT_COUNTINGS,
  LEADERBOARD_VISIBILITIES,
  QUESTION_NAVIGATIONS,
  QUESTION_SELECTIONS,
  RANKING_TIE_BREAKS,
  RESULT_RELEASES,
  academyQuizSettingsSchema,
} from '@asra/validation';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import { ImageSlots, useImageUploader } from '@/components/assessments/image-slots';
import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
  ANSWER_REVEAL_OPTIONS,
  COUNTING_LABELS,
  LEADERBOARD_LABELS,
  NAVIGATION_LABELS,
  RESULT_RELEASE_LABELS,
  SELECTION_LABELS,
  TIE_BREAK_LABELS,
  emptyForm,
  formFromDetail,
  formToBody,
  isLockedAfterPublish,
  prizeKey,
  publishedPatch,
  type QuizFormState,
} from '@/lib/admin/academy-quizzes';
import { describeError, validateForm, type FieldErrors } from '@/lib/auth/form-errors';

import { Section } from '../admin-kit';
import { CheckboxField, SelectField } from '../admin-ui';
import { hasPermission, useAdminApi, useApiResource } from '../use-admin';

export const ADMIN_MEDIA_UPLOAD = '/admin/assessment-media';

/**
 * Create (`quiz` absent) or edit the settings of an academy quiz. A DRAFT can change everything;
 * once published, scoring/timing/selection/eligibility/ranking are locked (shown disabled with the
 * reason) — the server enforces the same rule. Times are entered and shown in IST.
 */
export function AcademyQuizForm({ quiz }: { quiz?: AdminAcademyQuizDetail }) {
  const api = useAdminApi();
  const router = useRouter();
  const { user } = useAuth();
  const upload = useImageUploader(ADMIN_MEDIA_UPLOAD);
  const [form, setForm] = React.useState<QuizFormState>(() =>
    quiz ? formFromDetail(quiz) : emptyForm(),
  );
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [uploads, setUploads] = React.useState<Record<string, boolean>>({});
  const uploading = Object.values(uploads).some(Boolean);
  const trackUpload = React.useCallback(
    (key: string) => (busy: boolean) =>
      setUploads((current) => (current[key] === busy ? current : { ...current, [key]: busy })),
    [],
  );

  const draft = !quiz || quiz.status === 'DRAFT';
  const locked = (field: Parameters<typeof isLockedAfterPublish>[0]) =>
    !draft && isLockedAfterPublish(field);
  const set = (patch: Partial<QuizFormState>) => setForm((current) => ({ ...current, ...patch }));
  const perQuestion = form.timerMode === 'PER_QUESTION';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || uploading) return;
    const body = formToBody(form);
    const checked = validateForm(academyQuizSettingsSchema, { ...ACADEMY_QUIZ_DEFAULTS, ...body });
    setFormError(null);
    if (checked.errors) {
      setErrors(checked.errors);
      setFormError('Check the highlighted settings.');
      return;
    }
    setErrors({});
    setPending(true);
    try {
      if (!quiz) {
        const created = await api.post<AdminAcademyQuizDetail>('/admin/academy-quizzes', body);
        toast.success('Academy quiz created', { description: 'Now add its questions.' });
        router.push(`/admin/academy-quizzes/${created.id}`);
      } else {
        await api.patch(`/admin/academy-quizzes/${quiz.id}`, draft ? body : publishedPatch(body));
        toast.success('Settings saved');
        router.push(`/admin/academy-quizzes/${quiz.id}`);
      }
    } catch (error) {
      const described = describeError(error);
      setErrors(described.fieldErrors);
      setFormError(described.message);
    } finally {
      setPending(false);
    }
  }

  const lockHint = (field: Parameters<typeof isLockedAfterPublish>[0]) =>
    locked(field) ? 'Locked after publication.' : undefined;

  return (
    <form onSubmit={submit} noValidate className="grid gap-6">
      <PageHeader
        title={quiz ? `Settings — ${quiz.title}` : 'New academy quiz'}
        description="Times are in IST. Students need a verified email; course enrolment is not required."
        breadcrumbs={[
          { label: 'Academy Quizzes', href: '/admin/academy-quizzes' },
          ...(quiz ? [{ label: quiz.title, href: `/admin/academy-quizzes/${quiz.id}` }] : []),
          { label: quiz ? 'Settings' : 'New' },
        ]}
      />
      {!draft ? (
        <Alert tone="info" title="This quiz is published">
          <p>
            <Lock className="mr-1 inline size-4" aria-hidden />
            Timing, scoring, question selection, eligibility and ranking are locked so every attempt
            is judged by the rules it started under. Content, prizes and result display can still
            change, and the end time can be extended before it passes.
          </p>
        </Alert>
      ) : null}
      {formError ? (
        <Alert tone="error">
          <p>{formError}</p>
        </Alert>
      ) : null}

      <Section title="Announcement" description="What students see on the quiz page.">
        <Field id="aq-title" label="Title" error={errors.title}>
          <Input
            value={form.title}
            maxLength={ACADEMY_QUIZ_LIMITS.title}
            onChange={(e) => set({ title: e.target.value })}
          />
        </Field>
        <Field
          id="aq-slug"
          label="Web address"
          optional
          error={errors.slug}
          hint={
            locked('slug')
              ? 'Locked after publication.'
              : 'Leave empty to create it from the title, e.g. /quizzes/science-olympiad.'
          }
        >
          <Input
            value={form.slug}
            disabled={locked('slug')}
            placeholder="science-olympiad-2026"
            onChange={(e) => set({ slug: e.target.value })}
          />
        </Field>
        <Field id="aq-summary" label="Short description" optional error={errors.summary}>
          <Input
            value={form.summary}
            maxLength={ACADEMY_QUIZ_LIMITS.summary}
            onChange={(e) => set({ summary: e.target.value })}
          />
        </Field>
        <Field
          id="aq-description"
          label="Announcement"
          optional
          error={errors.description}
          hint="The detailed announcement shown on the quiz page (plain text)."
        >
          <Textarea
            rows={5}
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>
        <Field
          id="aq-instructions"
          label="Instructions and rules"
          optional
          error={errors.instructions}
          hint="Shown before the student starts."
        >
          <Textarea
            rows={5}
            value={form.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
          />
        </Field>
        <div className="grid gap-1">
          <span className="type-label">
            Banner image <span className="font-normal text-muted-foreground">(optional)</span>
          </span>
          <ImageSlots
            label="Banner image"
            images={form.banner ? [form.banner] : []}
            max={1}
            onChange={(next) => set({ banner: next[0] ?? null })}
            upload={upload}
            onBusyChange={trackUpload('banner')}
            disabled={pending}
          />
          {errors.bannerMediaId ? (
            <p className="type-body-sm text-destructive">{errors.bannerMediaId}</p>
          ) : null}
        </div>
      </Section>

      <Section title="Schedule and timing">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="aq-starts"
            label="Starts (IST)"
            error={errors.startsAt}
            hint={lockHint('startsAt')}
          >
            <Input
              type="datetime-local"
              value={form.startsAt}
              disabled={locked('startsAt')}
              onChange={(e) => set({ startsAt: e.target.value })}
            />
          </Field>
          <Field
            id="aq-ends"
            label="Ends (IST)"
            error={errors.endsAt}
            hint={
              draft
                ? 'No attempt can start or continue after this. Late starters get only the time left.'
                : 'Can only be extended (a later time), before the quiz ends.'
            }
          >
            <Input
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => set({ endsAt: e.target.value })}
            />
          </Field>
          <SelectField
            id="aq-timer"
            label="Timer"
            value={form.timerMode}
            disabled={locked('timerMode')}
            onValueChange={(value) => set({ timerMode: value as QuizFormState['timerMode'] })}
            options={[
              { value: 'OVERALL', label: 'One timer for the whole quiz' },
              { value: 'PER_QUESTION', label: 'A timer for each question' },
            ]}
            error={errors.timerMode}
            hint={lockHint('timerMode')}
          />
          {perQuestion ? (
            <Field
              id="aq-question-time"
              label="Seconds per question"
              error={errors.questionTimeSeconds}
              hint={
                lockHint('questionTimeSeconds') ?? 'Students move forward one question at a time.'
              }
            >
              <Input
                type="number"
                min={10}
                max={600}
                inputMode="numeric"
                disabled={locked('questionTimeSeconds')}
                value={form.questionTimeSeconds}
                onChange={(e) => set({ questionTimeSeconds: e.target.value })}
              />
            </Field>
          ) : (
            <Field
              id="aq-duration"
              label="Duration (minutes)"
              error={errors.durationMinutes}
              hint={lockHint('durationMinutes')}
            >
              <Input
                type="number"
                min={1}
                max={600}
                inputMode="numeric"
                disabled={locked('durationMinutes')}
                value={form.durationMinutes}
                onChange={(e) => set({ durationMinutes: e.target.value })}
              />
            </Field>
          )}
        </div>
      </Section>

      <Section title="Questions and navigation">
        <SelectField
          id="aq-selection"
          label="Which questions each student gets"
          value={form.selection}
          disabled={locked('selection')}
          onValueChange={(value) => set({ selection: value as QuizFormState['selection'] })}
          options={QUESTION_SELECTIONS.map((value) => ({ value, label: SELECTION_LABELS[value] }))}
          error={errors.selection}
          hint={lockHint('selection')}
        />
        {form.selection === 'RANDOM' ? (
          <Field
            id="aq-per-attempt"
            label="Questions per student"
            error={errors.questionsPerAttempt}
            hint="Every question must carry the same marks, so all totals are equal."
          >
            <Input
              type="number"
              min={1}
              inputMode="numeric"
              disabled={locked('questionsPerAttempt')}
              value={form.questionsPerAttempt}
              onChange={(e) => set({ questionsPerAttempt: e.target.value })}
            />
          </Field>
        ) : null}
        {form.selection === 'BY_DIFFICULTY' ? (
          <div className="grid gap-2">
            <div className="grid gap-4 sm:grid-cols-3">
              {(['easyCount', 'mediumCount', 'hardCount'] as const).map((key) => (
                <Field
                  key={key}
                  id={`aq-${key}`}
                  label={`${key === 'easyCount' ? 'Easy' : key === 'mediumCount' ? 'Medium' : 'Hard'} questions`}
                  error={errors[key]}
                >
                  <Input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    disabled={locked(key)}
                    value={form[key]}
                    onChange={(e) => set({ [key]: e.target.value })}
                  />
                </Field>
              ))}
            </div>
            <p className="type-caption text-muted-foreground">
              Questions of one difficulty must carry the same marks. Unrated questions are never
              drawn.
            </p>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="aq-navigation"
            label="Navigation"
            value={perQuestion ? 'LINEAR' : form.navigation}
            disabled={perQuestion || locked('navigation')}
            onValueChange={(value) => set({ navigation: value as QuizFormState['navigation'] })}
            options={QUESTION_NAVIGATIONS.map((value) => ({
              value,
              label: NAVIGATION_LABELS[value],
            }))}
            error={errors.navigation}
            hint={
              perQuestion
                ? 'A per-question timer always moves forward only.'
                : lockHint('navigation')
            }
          />
          <div className="grid content-end gap-3">
            <CheckboxField
              id="aq-require-answer"
              label="Require an answer before moving on"
              checked={(perQuestion || form.navigation === 'LINEAR') && form.requireAnswerToAdvance}
              disabled={
                !(perQuestion || form.navigation === 'LINEAR') || locked('requireAnswerToAdvance')
              }
              hint={lockHint('requireAnswerToAdvance')}
              onChange={(checked) => set({ requireAnswerToAdvance: checked })}
            />
            <CheckboxField
              id="aq-shuffle-q"
              label="Shuffle the question order"
              checked={form.shuffleQuestions}
              disabled={locked('shuffleQuestions')}
              hint={lockHint('shuffleQuestions')}
              onChange={(checked) => set({ shuffleQuestions: checked })}
            />
            <CheckboxField
              id="aq-shuffle-o"
              label="Shuffle the options"
              checked={form.shuffleOptions}
              disabled={locked('shuffleOptions')}
              hint={lockHint('shuffleOptions')}
              onChange={(checked) => set({ shuffleOptions: checked })}
            />
          </div>
        </div>
      </Section>

      <Section title="Scoring and attempts">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            id="aq-pass"
            label="Pass mark (%)"
            error={errors.passPercent}
            hint={lockHint('passPercent')}
          >
            <Input
              type="number"
              min={0}
              max={100}
              inputMode="numeric"
              disabled={locked('passPercent')}
              value={form.passPercent}
              onChange={(e) => set({ passPercent: e.target.value })}
            />
          </Field>
          <Field
            id="aq-attempts"
            label="Attempts per student"
            error={errors.maxAttempts}
            hint={lockHint('maxAttempts')}
          >
            <Input
              type="number"
              min={1}
              max={5}
              inputMode="numeric"
              disabled={locked('maxAttempts')}
              value={form.maxAttempts}
              onChange={(e) => set({ maxAttempts: e.target.value })}
            />
          </Field>
          <div className="grid content-end">
            <CheckboxField
              id="aq-negative"
              label="Negative marking"
              hint={
                locked('negativeMarking')
                  ? "Locked after publication. Deducts each question's negative marks for a wrong answer."
                  : "Deducts each question's negative marks for a wrong answer."
              }
              checked={form.negativeMarking}
              disabled={locked('negativeMarking')}
              onChange={(checked) => set({ negativeMarking: checked })}
            />
          </div>
        </div>
      </Section>

      <EligibilitySection
        form={form}
        set={set}
        errors={errors}
        locked={locked('eligibleClassIds')}
        canLoad={hasPermission(user, PERMISSIONS.ACADEMIC_STRUCTURE_MANAGE)}
      />

      <Section title="Results and leaderboard">
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="aq-release"
            label="Results are shown"
            value={form.resultRelease}
            onValueChange={(value) =>
              set({ resultRelease: value as QuizFormState['resultRelease'] })
            }
            options={RESULT_RELEASES.map((value) => ({
              value,
              label: RESULT_RELEASE_LABELS[value],
            }))}
            error={errors.resultRelease}
          />
          {form.resultRelease === 'SCHEDULED' ? (
            <Field
              id="aq-results-at"
              label="Results published at (IST)"
              error={errors.resultsAt}
              hint="Not before the quiz ends."
            >
              <Input
                type="datetime-local"
                value={form.resultsAt}
                onChange={(e) => set({ resultsAt: e.target.value })}
              />
            </Field>
          ) : (
            <div />
          )}
          <SelectField
            id="aq-reveal"
            label="Show correct answers"
            value={form.answerReveal}
            onValueChange={(value) => set({ answerReveal: value as QuizFormState['answerReveal'] })}
            options={ANSWER_REVEALS.map((value) => ({
              value,
              label: ANSWER_REVEAL_OPTIONS[value],
            }))}
            error={errors.answerReveal}
            hint="Only once the student's result is visible."
          />
          <SelectField
            id="aq-leaderboard"
            label="Leaderboard visible to"
            value={form.leaderboardVisibility}
            onValueChange={(value) =>
              set({ leaderboardVisibility: value as QuizFormState['leaderboardVisibility'] })
            }
            options={LEADERBOARD_VISIBILITIES.map((value) => ({
              value,
              label: LEADERBOARD_LABELS[value],
            }))}
            error={errors.leaderboardVisibility}
          />
          <SelectField
            id="aq-counting"
            label="Ranked attempt"
            value={form.attemptCounting}
            disabled={locked('attemptCounting')}
            onValueChange={(value) =>
              set({ attemptCounting: value as QuizFormState['attemptCounting'] })
            }
            options={ATTEMPT_COUNTINGS.map((value) => ({ value, label: COUNTING_LABELS[value] }))}
            hint={
              lockHint('attemptCounting') ??
              'Matters only when students may attempt more than once.'
            }
          />
          <SelectField
            id="aq-tie"
            label="Equal scores"
            value={form.tieBreak}
            disabled={locked('tieBreak')}
            onValueChange={(value) => set({ tieBreak: value as QuizFormState['tieBreak'] })}
            options={RANKING_TIE_BREAKS.map((value) => ({ value, label: TIE_BREAK_LABELS[value] }))}
            hint={lockHint('tieBreak') ?? 'Higher score always ranks first; this breaks ties.'}
          />
        </div>
        <CheckboxField
          id="aq-mask"
          label="Mask student names on the leaderboard"
          checked={form.maskNames}
          onChange={(checked) => set({ maskNames: checked })}
        />
      </Section>

      <PrizesSection
        form={form}
        set={set}
        errors={errors}
        upload={upload}
        trackUpload={trackUpload}
        disabled={pending}
      />

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            router.push(quiz ? `/admin/academy-quizzes/${quiz.id}` : '/admin/academy-quizzes')
          }
        >
          Cancel
        </Button>
        <Button
          type="submit"
          loading={pending}
          loadingText="Saving…"
          disabled={uploading}
          title={uploading ? 'Wait for the image upload to finish' : undefined}
        >
          {quiz ? 'Save settings' : 'Create draft'}
        </Button>
      </div>
    </form>
  );
}

function EligibilitySection({
  form,
  set,
  errors,
  locked,
  canLoad,
}: {
  form: QuizFormState;
  set: (patch: Partial<QuizFormState>) => void;
  errors: FieldErrors;
  locked: boolean;
  canLoad: boolean;
}) {
  const api = useAdminApi();
  const classes = useApiResource(canLoad ? '/admin/classes?pageSize=100' : null, () =>
    api.get<Paginated<ClassDto>>('/admin/classes?pageSize=100'),
  );
  const streams = useApiResource(canLoad ? '/admin/streams?pageSize=100' : null, () =>
    api.get<Paginated<StreamDto>>('/admin/streams?pageSize=100'),
  );
  const toggle = (key: 'eligibleClassIds' | 'eligibleStreamIds', id: string, on: boolean) =>
    set({ [key]: on ? [...form[key], id] : form[key].filter((value) => value !== id) });

  const group = (
    key: 'eligibleClassIds' | 'eligibleStreamIds',
    title: string,
    items: { id: string; name: string; academicLevel: { name: string } }[] | undefined,
  ) => (
    <fieldset className="grid gap-2" disabled={locked}>
      <legend className="mb-1 type-label">{title}</legend>
      {locked ? (
        <p className="type-caption text-muted-foreground">Locked after publication.</p>
      ) : null}
      {!canLoad ? (
        <p className="type-caption text-muted-foreground">
          Your account cannot list the academic structure, so this restriction cannot be changed
          here.
        </p>
      ) : !items ? (
        <p className="type-caption text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="type-caption text-muted-foreground">None defined.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <CheckboxField
              key={item.id}
              id={`${key}-${item.id}`}
              label={`${item.name} · ${item.academicLevel.name}`}
              checked={form[key].includes(item.id)}
              onChange={(checked) => toggle(key, item.id, checked)}
            />
          ))}
        </div>
      )}
      {errors[key] ? <p className="type-body-sm text-destructive">{errors[key]}</p> : null}
    </fieldset>
  );

  return (
    <Section
      title="Eligibility"
      description="A verified email is always required. Leave a list empty for no restriction."
    >
      {locked ? (
        <p className="type-caption text-muted-foreground">
          <Lock className="mr-1 inline size-4" aria-hidden />
          Locked after publication.
        </p>
      ) : null}
      {group('eligibleClassIds', 'Only these classes', classes.data?.items)}
      {group('eligibleStreamIds', 'Only these streams', streams.data?.items)}
    </Section>
  );
}

function PrizesSection({
  form,
  set,
  errors,
  upload,
  trackUpload,
  disabled,
}: {
  form: QuizFormState;
  set: (patch: Partial<QuizFormState>) => void;
  errors: FieldErrors;
  upload: ReturnType<typeof useImageUploader>;
  trackUpload: (key: string) => (busy: boolean) => void;
  disabled: boolean;
}) {
  const update = (key: string, patch: Partial<QuizFormState['prizes'][number]>) =>
    set({
      prizes: form.prizes.map((prize) => (prize.key === key ? { ...prize, ...patch } : prize)),
    });
  return (
    <Section
      title="Prizes"
      description="Optional. Shown on the quiz page; winners come from the leaderboard."
    >
      {errors.prizes ? <p className="type-body-sm text-destructive">{errors.prizes}</p> : null}
      {form.prizes.length === 0 ? (
        <p className="type-body-sm text-muted-foreground">No prizes yet.</p>
      ) : (
        <ol className="grid gap-3">
          {form.prizes.map((prize, index) => (
            <li key={prize.key} className="grid gap-3 rounded-lg border p-3">
              <div className="grid gap-3 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
                <Field id={`${prize.key}-position`} label="Position">
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    inputMode="numeric"
                    value={prize.position}
                    onChange={(e) => update(prize.key, { position: e.target.value })}
                  />
                </Field>
                <Field id={`${prize.key}-title`} label="Prize">
                  <Input
                    value={prize.title}
                    maxLength={ACADEMY_QUIZ_LIMITS.prizeTitle}
                    placeholder="e.g. Tablet and certificate"
                    onChange={(e) => update(prize.key, { title: e.target.value })}
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove prize ${index + 1}`}
                  onClick={() => set({ prizes: form.prizes.filter((p) => p.key !== prize.key) })}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
              <Field id={`${prize.key}-description`} label="Description" optional>
                <Textarea
                  rows={2}
                  value={prize.description}
                  onChange={(e) => update(prize.key, { description: e.target.value })}
                />
              </Field>
              <ImageSlots
                compact
                label={`Image for prize ${index + 1}`}
                images={prize.image ? [prize.image] : []}
                max={1}
                onChange={(next) => update(prize.key, { image: next[0] ?? null })}
                upload={upload}
                onBusyChange={trackUpload(prize.key)}
                disabled={disabled}
              />
            </li>
          ))}
        </ol>
      )}
      {form.prizes.length < ACADEMY_QUIZ_LIMITS.prizes ? (
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          onClick={() =>
            set({
              prizes: [
                ...form.prizes,
                {
                  key: prizeKey(),
                  position: String(
                    Math.max(0, ...form.prizes.map((p) => Number(p.position) || 0)) + 1,
                  ),
                  title: '',
                  description: '',
                  image: null,
                },
              ],
            })
          }
        >
          <Plus aria-hidden /> Add prize
        </Button>
      ) : null}
    </Section>
  );
}
