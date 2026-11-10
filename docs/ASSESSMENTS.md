# ASRA Academy — Assessment Engine (PHASE 09)

Three related but separate assessment systems — **quizzes**, **assignments** and **examinations** — built on the Phase 03 auth/RBAC, the Phase 06 curriculum, the Phase 07 enrolment policy and the Phase 08 faculty portal. They share a question bank, an attempt model, one scoring engine and one result-release vocabulary; their lifecycles and rules stay distinct.

Open decisions: [CLIENT-CLARIFICATIONS.md](./CLIENT-CLARIFICATIONS.md) §I, §J, §K and §AC. Defaults below are **proposed defaults, not confirmed client policy**, unless marked _confirmed_ (nothing in this phase is confirmed yet).

---

## 1. What exists

| Capability                                           | Status                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Quiz authoring (MCQ, True/False, multiple answers)   | **Implemented** — faculty, course-scoped                                                                                                   |
| Quiz attempts, server scoring, limits, randomisation | **Implemented**                                                                                                                            |
| Assignments                                          | **Extended from Phase 08**: per-assignment late/resubmission policy, server-decided lateness, version history, private note, grade history |
| Assignment file upload                               | **Not available** — no storage provider (R-01). Text + `https://` link only; the API reports `fileUploads.available = false`               |
| Examinations (scheduled, timed)                      | **Implemented** with server-controlled timing, autosave, expiry, finalization, evaluation, result publication                              |
| Written (subjective) answers                         | **Implemented for examinations only** (`SHORT_ANSWER`), graded manually by faculty                                                         |
| Administrators managing assessments                  | **Not exposed.** Endpoints live under `/faculty/*` (FACULTY role + course assignment). No admin route was added (J-03 pending)             |
| Proctoring (tab-switch, webcam)                      | **Not implemented** (K-03 assumption: none). The integrity controls are the server-side ones listed in §7.6                                |
| Report cards / mark sheets                           | Not implemented (K-04)                                                                                                                     |
| Certificates, course progress                        | **Unchanged.** Quiz/exam results do not feed course progress (AA-04) or certificate eligibility (L-02, Phase 13)                           |

## 2. Architecture

```
apps/api/src/modules/assessments/
  scoring.ts            pure scoring in integer hundredths of a mark (no I/O)
  attempts.core.ts      snapshot, locking, THE finalization path, expiry, sweep, serialisers
  questions.service.ts  question authoring shared by quizzes and exams (draft-only)
  quizzes.service.ts    quiz lifecycle (faculty) + quiz panel/start (student)
  exams.service.ts      exam lifecycle + deadline rule + start window (student)
  attempts.service.ts   get/save/submit/results (student), list/detail/grade (faculty)
  audit.ts              append-only assessment_audit_logs
  expiry-worker.ts      background sweep (long-running server only)
apps/api/src/lib/clock.ts   single server time source (`clock.now()`), pinnable in tests
```

- **Quiz = the online part of a QUIZ lesson** (1:1, like Phase 08 `Assignment` for ASSIGNMENT lessons). The lesson keeps title, instructions and curriculum publication; `Quiz` holds rules, questions and attempts. No parallel content system.
- **Examination = a scheduled, timed assessment of a course** (`examinations.course_id`).
- **Shared:** `assessment_questions` (+ options) belong to exactly one quiz **or** exam (CHECK); `assessment_attempts` + `attempt_questions` serve both kinds.
- **Immutable attempt snapshot.** When an attempt starts, the questions assigned to it (selection and order, prompt, options in display order, answer key, marks, negative marks, explanation) are copied into `attempt_questions.snapshot`. Scoring, review and refresh always use the snapshot, so later edits to the bank never change a started or finished attempt. In addition, questions and rules can be edited **only while the assessment is DRAFT**.

## 3. Data model and migration

Migration **`20261017090000_phase09_assessment_engine`** (additive; generated with `prisma migrate diff` and applied with `migrate deploy`; no reset, no data loss):

| Object                                                                                             | Purpose                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| enums `assessment_status`, `question_type`, `answer_reveal`, `attempt_status`, `evaluation_status` | lifecycle and type vocabularies                                                                            |
| `quizzes`                                                                                          | rules of a QUIZ lesson (unique `lesson_id`)                                                                |
| `examinations`                                                                                     | course exam: window, duration, attempts, pass mark, reveal, result publication                             |
| `assessment_questions`, `assessment_question_options`                                              | question bank (owner quiz XOR exam)                                                                        |
| `assessment_attempts`                                                                              | one attempt: server start/deadline/submit/finalize times, status, evaluation, scores                       |
| `attempt_questions`                                                                                | per-attempt snapshot + answer (`selected_option_ids uuid[]`, `text_answer`, `answer_sequence`) + outcome   |
| `assessment_audit_logs`                                                                            | append-only audit (publication, finalization, grading, grade changes, release)                             |
| `assignments` + 2 columns                                                                          | `allow_late_submissions` (default **true**), `allow_resubmission` (default **false**) — Phase 08 behaviour |
| `assignment_submissions` + 3 columns                                                               | `late` (now stored), `version`, `faculty_note`; existing rows back-filled `late = submitted_at > due_at`   |
| `assignment_submission_revisions`                                                                  | earlier versions archived on resubmission (append-only)                                                    |

Integrity: unique `(quiz_id|examination_id, user_id, attempt_number)` (attempt-limit backstop), unique `(attempt_id, position)`, unique `(question_id, position)` for options; RESTRICT from attempts to quizzes/exams and from exams to courses (history is never deleted by a cascade); 33 CHECK constraints (listed in [DATABASE.md](./DATABASE.md) §4.2.5) — e.g. single owner, `closes_at > opens_at`, bounded durations/attempts/percent, `0 < marks ≤ 100`, `0 ≤ negative_marks ≤ marks`, `0 ≤ score ≤ max_score`, finalization fields set together, EXPIRED requires a deadline, EVALUATED ⇔ score present.

Service guards: deleting a QUIZ lesson or changing its type is refused (409) once anyone attempted the quiz; a course with examinations cannot be deleted (archive instead).

After pulling: `npm run db:migrate:deploy` (or `npm run db:migrate` locally). **No seed change, no new permission, no new environment variable.**

## 4. Lifecycles and state transitions

### 4.1 Quiz / examination status

| From → to          | Action      | Who                                        | Server conditions                                                                                                             |
| ------------------ | ----------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| DRAFT → PUBLISHED  | `publish`   | course faculty (`content.manage_assigned`) | ≥ 1 question; quiz: `questionsPerAttempt ≤ questions`; exam: `closesAt` in the future                                         |
| PUBLISHED → CLOSED | `close`     | course faculty                             | quiz: running attempts are finalized now (EXPIRED, saved answers). exam: no new starts; running attempts keep their deadlines |
| CLOSED → PUBLISHED | `reopen`    | course faculty                             | exam: results not published and window not ended                                                                              |
| PUBLISHED → DRAFT  | `unpublish` | course faculty                             | **no attempts exist**                                                                                                         |

Anything else is **409**. Rules and questions change only in DRAFT (409 otherwise). Students never see DRAFT assessments (404). A quiz is attemptable only when the **course, the lesson and the quiz** are PUBLISHED and the student has an ACTIVE enrolment.

### 4.2 Attempt

```
IN_PROGRESS ──submit before deadline──▶ SUBMITTED ─┐
     │                                              ├─▶ evaluation: EVALUATED (score) or PENDING (written answers)
     └──deadline passed / quiz closed────▶ EXPIRED ─┘        PENDING ──faculty grades last answer──▶ EVALUATED
```

SUBMITTED and EXPIRED are terminal: answers can never change again (409 `{ attemptStatus }`).

### 4.3 Assignment (Phase 08 + 09)

Create → publish lesson → **submit** (server time; late flag; refused if late and `allowLateSubmissions = false`) → optional **resubmit** (only if `allowResubmission`, only while not graded, same due-date rule; previous version archived) → faculty **grade** (marks 0…max, feedback, private note; regrading allowed and audited) → **release** (final; grading afterwards is 409) → student sees marks + feedback.

### 4.4 Result visibility

| Assessment | Student sees the score when…                                         | Correct answers/explanations when…                                                                        |
| ---------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Quiz       | evaluated AND (`showResultImmediately` OR faculty published results) | score visible AND `answerReveal` = AFTER_SUBMISSION, or AFTER_CLOSE and the quiz is CLOSED                |
| Exam       | evaluated AND faculty published results                              | score visible AND `answerReveal` = AFTER_SUBMISSION, or AFTER_CLOSE and the exam is closed / window ended |
| Assignment | faculty released that submission                                     | n/a (feedback only; the private note never)                                                               |

Exam results can be published only when the window has ended (or the exam is closed), **no attempt is running** and **no written answer awaits grading**. A result awaiting grading is shown as "Awaiting evaluation", never as a provisional score. One SQL filter (`studentAttemptService.results`) and one function (`resultStateOf`) express the same rule.

## 5. Server-controlled timing (examinations and timed quizzes)

- **Single time source:** `clock.now()` (server). Timestamps are `timestamptz`, stored in UTC, shown in IST (V-09).
- **Start** (`POST /student/exams/:id/attempts`), in order: exam PUBLISHED and visible (404 otherwise) → enrolment (`assertCanViewCourseContent`) → per-student advisory lock → a running attempt is **resumed** (same id, same questions, same deadline) → `opensAt ≤ now < closesAt` → at least **60 s** left before closing (`EXAM_MIN_START_REMAINING_MS`) → attempts left → questions exist.
- **Deadline** (`examAttemptDeadline`, the only implementation): `min(startedAt + durationMinutes, closesAt)`. Persisted at start; never recomputed, never extended (refresh, reconnect, restart or resume return the stored value). Timed quiz: `startedAt + timeLimitMinutes`.
- **Late start policy:** a student starting 20 minutes before closing gets 20 minutes, not the full duration. Starting with < 1 minute left is refused.
- **Acceptance boundary:** an answer save or submit is accepted iff, at server time `t`, the attempt is IN_PROGRESS and `t < deadlineAt`. At `t ≥ deadlineAt` saves are refused (409) and the attempt is finalized as **EXPIRED** with the answers already stored; its `submittedAt` is the **deadline** (not the processing time — `finalizedAt` records when it was processed). There is **no grace period** (proposed default; AC-05).
- **The browser provides nothing authoritative:** request bodies are strict — `startedAt`, `deadlineAt`, remaining time, scores or correctness flags are 422. The countdown is computed from the server `deadlineAt` and `serverNow` (corrected for the device clock skew) and is display-only; reaching zero merely asks the server to submit.
- **Connectivity near the deadline:** the server's receive time decides. Answers are autosaved per change; an answer that reaches the server after the deadline is not counted. The UI states this.

### 5.1 Expiry processing (restart-tolerant)

1. **Lazy, on every touch:** attempt read, answer save, submit, the quiz panel, exam detail/list, faculty attempt list/detail, manual grading and result publication all check the stored deadline and finalize an expired attempt first.
2. **Sweeper:** `sweepExpiredAttempts()` selects `IN_PROGRESS AND deadline_at <= now … FOR UPDATE SKIP LOCKED` in batches and finalizes each through the same path. The long-running API (`server.ts`) runs it every 30 s (`ASSESSMENT_EXPIRY_SWEEP_MS`); faculty can trigger it per exam (`POST /faculty/exams/:id/process-expired`).
3. **No in-memory state, no `setTimeout` correctness:** deadlines live in PostgreSQL, so a restart or a delayed worker changes nothing except _when_ an unattended attempt is marked finalized; its outcome and `submittedAt` are the same.
4. **Serverless (Vercel):** the sweeper does not run there (no long-lived process; Redis exists but no BullMQ/queue is configured). Unattended expired attempts are finalized when next touched (always before anyone can see or publish results). For a guaranteed periodic sweep in production, add a scheduled job (e.g. a cron calling a protected endpoint or a worker process running `sweepExpiredAttempts`). Not built here — no secret/cron infrastructure was approved.
5. **Academy Quizzes — bounded backlog processing:** after a large quiz ends, many attempts can be left expired-but-unfinalized (students who closed the tab). Request paths (leaderboards, the admin attempts list, the student's results, manual result publication) call `finalizeExpiredBounded()`: at most `ACADEMY_FINALIZE_LIMITS.maxPerRequest` (250) attempts per request, in transactions of 50, and no new batch once 3 s have elapsed. Each batch commits on its own, so a retry continues where the previous request stopped and nothing is finalized twice. While any expired attempt of the quiz is still unfinalized, **no ranking is shown and nothing is published**: the student leaderboard returns `finalizing: true` ("Results are being finalized…", with a retry button), the admin leaderboard and attempts list return `pendingFinalization` (with "Continue finalizing"), and manual publication answers 409 with `{ finalizing: true, pendingAttempts }`. Finalization is set-based (one `UPDATE … FROM (VALUES …)` for all question outcomes of a batch, one for the attempts, one audit insert), so a batch costs a handful of statements regardless of its size. Course quizzes and exams keep the unbounded sweep.
6. **Required function duration:** a request that finalizes a backlog runs for at most ≈ 3 s (budget) + one batch + the page's own queries. Measured figures are in the release notes; keep the API function's maximum duration comfortably above that (≥ 10 s). The actual Vercel plan limit has not been verified here — check it in the Vercel project settings and on staging before relying on it.

### 5.2 Concurrency

| Race                                  | Protection                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent starts / last attempt      | `pg_advisory_xact_lock(student, assessment)` serialises starts; the second sees (and resumes) the first. Unique `(assessment, user, attemptNumber)` as backstop → 409                       |
| Concurrent submits / submit + sweeper | Attempt row `SELECT … FOR UPDATE`; finalization runs only from IN_PROGRESS; later calls return the final attempt (`already_final`) — evaluated **once** (one `attempt.finalized` audit row) |
| Answer save vs finalization           | Both lock the attempt row: either the save commits first and is included, or finalization commits first and the save gets 409. The acknowledgement is sent only after commit                |
| Out-of-order autosaves                | `answer_sequence`: a save whose sequence is not higher than the stored one is ignored (`applied: false`)                                                                                    |
| Faculty publish vs question edits     | Owner row locked; DRAFT re-checked inside the transaction                                                                                                                                   |
| Assignment grading / resubmission     | Submission row locked; identical grade retries change nothing and add no history                                                                                                            |

## 6. Scoring (`scoring.ts`)

All arithmetic in **integer hundredths** of a mark; stored as `DECIMAL(…,2)`; never computed in the browser.

| Rule                 | Definition                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Units                | marks per question `0.25–100`, ≤ 2 decimals; negative marks `0–marks`; durations in whole minutes; pass mark whole percent `0–100`                    |
| Max score            | Σ marks of the questions **in the attempt's snapshot** (a random subset has its own maximum)                                                          |
| MCQ / True-False     | correct ⇔ exactly the one correct option selected → full marks; otherwise 0                                                                           |
| Multiple answers     | **all-or-nothing**: correct ⇔ selected set = correct set (subset, superset or different set = wrong). No partial credit (AC-03)                       |
| Unanswered           | 0 marks, no penalty                                                                                                                                   |
| Negative marking     | only when the quiz/exam has `negativeMarking`; a wrong **answered** objective question loses its `negativeMarks` once                                 |
| Written answer       | blank → 0 automatically; answered → manual marks `0…marks` (≤ 2 decimals); attempt stays PENDING until every answered one is graded                   |
| Total                | `score = max(0, raw − penalties)` — never negative (AC-04)                                                                                            |
| Percentage           | `score ÷ max × 100`, **rounded half-up to 2 decimals**                                                                                                |
| Pass                 | `score ≥ passPercent % of max` — **inclusive** (exactly the threshold passes; AC-02), compared exactly in integers                                    |
| Attempt numbering    | 1, 2, 3 … per student and assessment; EXPIRED attempts count                                                                                          |
| Which attempt counts | every finalized attempt is kept and shown; no single "final" grade is derived (AC-01). Dashboards list released attempts, not a best/latest aggregate |
| Assignments          | whole marks `0…maxMarks` (unchanged I-03 assumption); no late penalty                                                                                 |

Persisted per attempt: raw score, penalty, score, max, percent, passed, submit/expiry time, evaluation status, evaluation time; per question: answer, awarded marks, penalty, correctness, feedback, grader and time.

## 7. API

Standard envelope; lists `{ items, pagination }`; bodies Zod `.strict()`. All routes `no-store`.

### 7.1 Faculty — `/api/v1/faculty` (FACULTY role + permission + course assignment resolved from the database)

| Method & path                                                | Permission                   | Notes                                                                                                                                          |
| ------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /quizzes?courseId&page`                                 | `content.manage_assigned`    | QUIZ lessons of assigned courses with quiz rules (or `null`) and counts                                                                        |
| `GET /quizzes/:lessonId`                                     | `content.manage_assigned`    | Rules, questions (with key), counts                                                                                                            |
| `POST /chapters/:id/quizzes`                                 | `content.manage_assigned`    | DRAFT QUIZ lesson + quiz in one transaction                                                                                                    |
| `PUT /lessons/:id/quiz`                                      | `content.manage_assigned`    | Create/replace rules (DRAFT only)                                                                                                              |
| `POST /quizzes/:lessonId/questions`                          | `content.manage_assigned`    | Add (DRAFT only; no SHORT_ANSWER in quizzes)                                                                                                   |
| `PUT /quizzes/:lessonId/question-order`                      | `content.manage_assigned`    | Full new order                                                                                                                                 |
| `POST /quizzes/:lessonId/status` `{action}`                  | `content.manage_assigned`    | publish · close · reopen · unpublish (§4.1)                                                                                                    |
| `POST /quizzes/:lessonId/publish-results`                    | `submissions.grade_assigned` | Idempotent                                                                                                                                     |
| `GET /quizzes/:lessonId/attempts?status&page`                | `submissions.grade_assigned` | `status`: IN_PROGRESS · PENDING_EVALUATION · EVALUATED                                                                                         |
| `GET /exams?courseId&page`, `GET /exams/:id`                 | `content.manage_assigned`    | Detail includes `windowEnded`                                                                                                                  |
| `POST /courses/:id/exams`                                    | `content.manage_assigned`    | DRAFT; `closesAt > opensAt`, `closesAt` in the future                                                                                          |
| `PATCH /exams/:id`, `DELETE /exams/:id`                      | `content.manage_assigned`    | DRAFT only                                                                                                                                     |
| `POST /exams/:id/questions`, `PUT /exams/:id/question-order` | `content.manage_assigned`    | DRAFT only                                                                                                                                     |
| `POST /exams/:id/status` `{action}`                          | `content.manage_assigned`    | §4.1                                                                                                                                           |
| `POST /exams/:id/publish-results`                            | `submissions.grade_assigned` | §4.4 conditions; idempotent                                                                                                                    |
| `POST /exams/:id/process-expired`                            | `submissions.grade_assigned` | Runs the sweep for this exam; returns `{ finalized }`                                                                                          |
| `GET /exams/:id/attempts?status&page`                        | `submissions.grade_assigned` |                                                                                                                                                |
| `PATCH /questions/:id`, `DELETE /questions/:id`              | `content.manage_assigned`    | Either kind; DRAFT only                                                                                                                        |
| `GET /attempts/:id`                                          | `submissions.grade_assigned` | Snapshot with key, answers, outcomes (no answers while running)                                                                                |
| `PUT /attempt-answers/:id/grade`                             | `submissions.grade_assigned` | `{ awardedMarks, feedback? }` — SHORT_ANSWER only, until results published                                                                     |
| Phase 08 assignment routes                                   | unchanged paths              | Settings accept `allowLateSubmissions`, `allowResubmission`; grading accepts `facultyNote`; detail adds `revisions`, `gradeHistory`, `version` |

### 7.2 Student — `/api/v1/student` (STUDENT role + `content.view_enrolled` + enrolment policy)

| Method & path                                     | Rate limit (per user)    | Notes                                                                               |
| ------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `GET /lessons/:id/quiz`                           | —                        | Rules, attempts used, `cannotStartReason`, own attempts (score only when released)  |
| `POST /lessons/:id/quiz/attempts`                 | 20/min (`attemptStart`)  | 201 new · 200 resumed · 409 not allowed                                             |
| `GET /exams?when=current\|past`, `GET /exams/:id` | —                        | Accessible courses only; drafts 404                                                 |
| `POST /exams/:id/attempts`                        | 20/min                   | §5                                                                                  |
| `GET /attempts/:id`                               | —                        | Own attempts only (others: 404). Questions without key; `review` only when revealed |
| `PUT /attempts/:id/answers/:questionId`           | 300/min (`answerSave`)   | `{ selectedOptionIds                                                                | textAnswer, sequence }`; 409 `{attemptStatus}` after deadline/finalization |
| `POST /attempts/:id/submit`                       | 30/min (`attemptSubmit`) | Empty body; idempotent                                                              |
| `GET /assessment-results?page`                    | —                        | Released quiz/exam results                                                          |
| `GET /lessons/:id/assignment`                     | —                        | Adds `canSubmit`, `cannotSubmitReason`, policy flags, `fileUploads`, `version`      |
| `POST /lessons/:id/submission`                    | —                        | First submission or permitted resubmission                                          |

Students only ever receive their own data; faculty receive student **names** only (no contact details), as in Phase 08.

## 8. Portals

| Route                                                | Content                                                                                                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/faculty/quizzes`                                   | Quiz lessons + "New quiz"                                                                                                                                                                          |
| `/faculty/quizzes/[lessonId]`                        | Rules form (draft only, unsaved-change hint), question editor (add/edit/delete/reorder, student preview), lifecycle buttons, result publication, attempts                                          |
| `/faculty/exams`, `/faculty/exams/[examId]`          | Exam list + "New exam" (IST inputs); schedule/rules form, questions, lifecycle, publish results, process expired, attempts                                                                         |
| `/faculty/attempts/[attemptId]`                      | Frozen questions with key and answers; manual grading of written answers                                                                                                                           |
| `/faculty/assignments…`, `/faculty/submissions/[id]` | + late/resubmission toggles, private note, earlier versions, grading history                                                                                                                       |
| Lesson player (QUIZ lessons)                         | Quiz panel: rules, attempts used, start/continue, own attempts and released scores                                                                                                                 |
| `/student/exams`, `/student/exams/[examId]`          | Upcoming/open and closed exams; instructions, timing explanation, start/continue, attempts                                                                                                         |
| `/student/attempts/[attemptId]`                      | Attempt player (quiz and exam): server-corrected countdown, question palette, autosave status, offline banner, confirm submit, auto-submit at 0, navigation warning; outcome view per result state |
| `/student/results`                                   | Quiz/exam results + assignment results                                                                                                                                                             |

States covered: loading, unavailable/not open, no questions, attempt limit reached, attempt in progress (resume), time expired, submitting, submitted, network offline/retrying, awaiting evaluation, result not published, released.

## 9. Security and privacy

Server-side role + permission + course assignment for faculty; enrolment for students; owner-only attempts (404 for others, so ids cannot be probed); strict bodies (no client times, scores, correctness or reviewers); answer key and explanations never serialised for students before release; student text rendered as text; private faculty notes never selected for students; per-user rate limits on start/save/submit; audit rows for publication, finalization, grading (with previous marks) and release; no new secrets or logs of answer content. Students may be minors: payloads carry only what the workflow needs.

## 10. Tests

| Suite                                        | Covers                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/tests/assessment-scoring.test.ts`  | Pure scoring (each type, all-or-nothing, penalties, clamp, rounding, inclusive pass), deadline rule, availability, random selection, assignment policy                                                                                                                                                                                                                                           |
| `apps/api/tests/quizzes.test.ts`             | Authoring validation, frozen published quizzes, transitions, lesson-delete guard, scoring over HTTP, negative marking once, pass threshold, key confidentiality and over-posting, stale autosaves, attempt limit + resume, concurrent starts/submits, persisted random subset, snapshots, timed expiry, close finalization, result release + reveal, draft visibility, ownership, course scoping |
| `apps/api/tests/examinations.test.ts`        | The 21 mandatory timing/integrity scenarios (numbered in the file) + written-answer grading and publication + schedule validation + student listing                                                                                                                                                                                                                                              |
| `apps/api/tests/assignments-phase09.test.ts` | Server acceptance time, stored lateness, late refusal, resubmission + versions, payload validation, marks bounds, grade history, private note, isolation                                                                                                                                                                                                                                         |
| `apps/web/tests/assessments.test.tsx`        | Skew-corrected countdown, answer toggling, shared schemas, transitions, outcome rendering per result state                                                                                                                                                                                                                                                                                       |

Timing tests pin the server clock (`setClockForTests`, test-only) — no sleeps. Concurrency tests fire parallel HTTP requests at the real API and database.

Commands: `npm test` (API, Docker PostgreSQL) · `npm test -w @asra/web` · `npm run typecheck` · `npm run lint` · `npm run format:check` · `npm run build`.

**Not verified in a browser.** The portals were type-checked, linted, unit-rendered and built; the full flows are exercised over HTTP by the API suites. Dialogs, focus handling, the countdown and responsive layout have not been clicked through in a real browser.

## 11. Configuration and infrastructure

No new environment variables. Rate limits use the existing Redis-backed store (memory fallback). Optional production follow-ups: a scheduled sweep for serverless hosting (§5.1) and a storage provider for assignment files (R-01, AC-09).

## 12. Academy Quizzes — fullscreen requirement and its limits

Academy Quizzes require the page to be in fullscreen before an attempt starts or a running attempt is reopened. The student starts from the quiz page: **Start quiz** → modal step 1 **Allow fullscreen** (the browser's own fullscreen request, inside the click) → step 2 **Start the quiz now**. Only step 2 sends the start request, and only while `document.fullscreenElement` is set (`startOnlyInFullscreen`, `apps/web/src/lib/student/academy-quizzes.ts`). If fullscreen is unsupported (e.g. iPhone Safari, which has no element fullscreen), refused, or switched off before step 2, no request is sent and no attempt or timer exists. Reopening a running attempt shows "Allow fullscreen and continue"; the server timer keeps running meanwhile.

**This is a browser-side convenience, not a security control.** The server cannot see or verify the browser's fullscreen state, and the API does not accept or record any fullscreen value (the start body is strictly `{ acceptedInstructions: true }`). Anyone able to send HTTP requests with a valid student session — browser developer tools, a script, a modified page — can start and complete an attempt without fullscreen. Leaving fullscreen during an attempt is deliberately **not** watched, recorded or penalised (no tab, focus or fullscreen-exit tracking, by decision). Do not describe the fullscreen requirement as anti-cheating enforcement.

What the server **does** guarantee, whatever the client does: role, permission, verified email and class/stream eligibility; the attempt limit; start window and server deadlines (never past the quiz end); linear navigation and per-question time limits; idempotent submission and finalize-on-access; answer key withheld until release; result release rules.
