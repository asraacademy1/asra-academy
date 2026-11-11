# ASRA Academy — Database

| Field   | Value                                                                |
| ------- | -------------------------------------------------------------------- |
| Version | 0.16.0                                                               |
| Status  | Phase 16 — Careers & Recruitment subsystem added (10 models)         |
| Schema  | [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma)  |
| Engine  | PostgreSQL 17 (Docker, local) · Neon PostgreSQL (staging/production) |
| ORM     | Prisma 7.10 with the `@prisma/adapter-pg` driver adapter             |

This document covers the data model, its conventions and constraints, and how to migrate, seed and reset the database. Architecture context: [ARCHITECTURE.md §6](./ARCHITECTURE.md#6-database-responsibilities).

---

## 1. Entity overview

```
                 ┌──────────── Identity & access ────────────┐
                 │  Role ──< RolePermission >── Permission    │
                 │   │                                        │
                 │   └──< UserRole >── User                   │
                 │                     │ 1:1      │ 1:1       │
                 └─────────────────────┼──────────┼───────────┘
                          StudentProfile        FacultyProfile
                            │      │                  │
       ┌────── Academic ────┼──────┼──┐               │
       │  AcademicLevel ──< Class ◄───┘ (current)     │
       │        │                     │               │
       │        └──< Stream ◄─────────┘ (current)     │
       │  Subject                                     │
       └──┬─────────┬────────┬────────────────────────┘
          │ class?  │stream? │subject?                │
          ▼         ▼        ▼                        │
 CourseCategory ──< Course >──────< CourseInstructor >┘
                      │
                      ├──< Module ──< Chapter ──< Lesson ──< Resource
                      │                             │
 User ──< Enrollment >┘          User ──< LessonProgress >── Lesson   (Phase 07)

 Lesson (ASSIGNMENT) ──1:1── Assignment ──< AssignmentSubmission >── User (student)  (Phase 08)
 Course ──< LiveClassSession >── FacultyProfile (host)                               (Phase 08)
 Lesson (QUIZ) ──1:1── Quiz ──< AssessmentQuestion ──< AssessmentQuestionOption      (Phase 09)
 Course ──< Examination ──< AssessmentQuestion                                        (Phase 09)
 Quiz | Examination ──< AssessmentAttempt >── User ; AssessmentAttempt ──< AttemptQuestion (snapshot + answer)
 AssignmentSubmission ──< AssignmentSubmissionRevision ; AssessmentAuditLog (append-only)  (Phase 09)
 User ──< Order >── Course ; Order ──< Payment ──< Refund ; Enrollment ?──> Order       (Phase 10)
 PaymentWebhookEvent (dedup by provider event id) ; PaymentAuditLog (append-only)        (Phase 10)
 Enrollment ?──1:1── Certificate ; User ?──< Certificate ; Course ?──< Certificate        (Phase 13+17)
 AcademyQuiz ?──< Certificate ; Examination ?──< Certificate ; CertificateTemplate ──< Certificate (Phase 17)
 CertificateTemplate ──< CertificateTemplateSignature >── CertificateSignature           (Phase 17)
 CertificateSettings ; CertificateVerification (1:1 Certificate) ; CertificateAuditLog   (Phase 17)

 JobSequence ; ApplicationSequence (atomic year-based sequence counters)                 (Phase 16)
 Job ──< JobApplicationQuestion                                                          (Phase 16)
 Job ──< JobApplication ──< JobApplicationAnswer                                         (Phase 16)
 JobApplication ──< JobApplicationStatusHistory (append-only)                            (Phase 16)
 JobApplication ──< JobApplicationNote (confidential)                                    (Phase 16)
 JobApplication ──< JobInterview (Google Meet sessions)                                  (Phase 16)
 JobApplication ──< JobApplicationCommunication (Resend outbox log)                      (Phase 16)
```

`A ──< B` = one A has many B. `?` = optional (nullable foreign key).

| Model                           | Table                                                 | Purpose                                                                                                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`                          | `users`                                               | Central identity: email, password hash (Phase 03), name, status, email verification                                                                                                                                                                 |
| `Role`                          | `roles`                                               | Named permission set (`SUPER_ADMIN`, `ADMIN`, `FACULTY`, `STUDENT`; more can be added)                                                                                                                                                              |
| `Permission`                    | `permissions`                                         | Grantable capability with a stable key, e.g. `courses.manage`                                                                                                                                                                                       |
| `UserRole`                      | `user_roles`                                          | **Additional join model** — User ↔ Role (many-to-many)                                                                                                                                                                                              |
| `RolePermission`                | `role_permissions`                                    | **Additional join model** — Role ↔ Permission (many-to-many)                                                                                                                                                                                        |
| `StudentProfile`                | `student_profiles`                                    | Student academic data, 1:1 with User                                                                                                                                                                                                                |
| `FacultyProfile`                | `faculty_profiles`                                    | Faculty professional data, 1:1 with User                                                                                                                                                                                                            |
| `AcademicLevel`                 | `academic_levels`                                     | Band of school education, e.g. "Classes 6–10", "Classes 11–12"                                                                                                                                                                                      |
| `Class`                         | `classes`                                             | School grade, e.g. "Class 10"; belongs to one academic level                                                                                                                                                                                        |
| `Stream`                        | `streams`                                             | Stream within a level, e.g. Science (Classes 11–12); list pending                                                                                                                                                                                   |
| `Subject`                       | `subjects`                                            | Reusable subject, e.g. Mathematics                                                                                                                                                                                                                  |
| `CourseCategory`                | `course_categories`                                   | Admin-managed course grouping                                                                                                                                                                                                                       |
| `Course`                        | `courses`                                             | Enrollable unit: a subject for a class (± stream), or a special course                                                                                                                                                                              |
| `CourseInstructor`              | `course_instructors`                                  | Course ↔ FacultyProfile assignment with `isPrimary`                                                                                                                                                                                                 |
| `Module`                        | `modules`                                             | Ordered section of a course                                                                                                                                                                                                                         |
| `Chapter`                       | `chapters`                                            | Ordered section of a module                                                                                                                                                                                                                         |
| `Lesson`                        | `lessons`                                             | Ordered learning item in a chapter (video, document, text, link)                                                                                                                                                                                    |
| `Resource`                      | `resources`                                           | Learning material attached to a lesson (storage object or external URL)                                                                                                                                                                             |
| `Enrollment`                    | `enrollments`                                         | Phase 07: a student's entitlement to a course (ACTIVE/CANCELLED, FREE/ADMIN source)                                                                                                                                                                 |
| `LessonProgress`                | `lesson_progress`                                     | Phase 07: one student's progress in one lesson (viewed, completed, video telemetry)                                                                                                                                                                 |
| `Assignment`                    | `assignments`                                         | Phase 08: submission settings (max marks, due date) of one ASSIGNMENT lesson                                                                                                                                                                        |
| `AssignmentSubmission`          | `assignment_submissions`                              | Phase 08: a student's work, marks, feedback, reviewer and result release                                                                                                                                                                            |
| `LiveClassSession`              | `live_class_sessions`                                 | Phase 08: a scheduled live class of a course (provider-neutral, optional manual link)                                                                                                                                                               |
| `Quiz`                          | `quizzes`                                             | Phase 09: rules of one QUIZ lesson's online quiz                                                                                                                                                                                                    |
| `Examination`                   | `examinations`                                        | Phase 09: scheduled, timed exam of a course                                                                                                                                                                                                         |
| `AssessmentQuestion`(+`Option`) | `assessment_questions`, `assessment_question_options` | Phase 09: questions of one quiz XOR exam                                                                                                                                                                                                            |
| `AssessmentAttempt`             | `assessment_attempts`                                 | Phase 09: one attempt with server times, status, evaluation and scores                                                                                                                                                                              |
| `AttemptQuestion`               | `attempt_questions`                                   | Phase 09: frozen question snapshot + the student's answer + outcome                                                                                                                                                                                 |
| `AssignmentSubmissionRevision`  | `assignment_submission_revisions`                     | Phase 09: earlier versions archived on resubmission                                                                                                                                                                                                 |
| `AssessmentAuditLog`            | `assessment_audit_logs`                               | Phase 09: append-only audit of publication, finalization, grading and release                                                                                                                                                                       |
| `Order`                         | `orders`                                              | Phase 10: a purchase request for one course at a frozen price, in TEST or LIVE mode                                                                                                                                                                 |
| `Payment`                       | `payments`                                            | Phase 10: one Razorpay payment (attempt) of an order; monotonic status                                                                                                                                                                              |
| `Refund`                        | `refunds`                                             | Phase 10: a (partial) refund of a captured payment; payment row never rewritten                                                                                                                                                                     |
| `PaymentWebhookEvent`           | `payment_webhook_events`                              | Phase 10: received webhooks, deduplicated by event id, with processing state                                                                                                                                                                        |
| `PaymentAuditLog`               | `payment_audit_logs`                                  | Phase 10: append-only audit of financial events and administrator actions                                                                                                                                                                           |
| `AdminAuditLog`                 | `admin_audit_logs`                                    | Phase 12: append-only audit of account, role, course, live-class and enrolment actions                                                                                                                                                              |
| `Certificate`                   | `certificates`                                        | Phase 13+17: data-only multi-source verifiable credential (`COURSE`, `ACADEMY_QUIZ`, `COMPETITION`, `EXAM`, `EVENT`, `WORKSHOP`, `TRAINING`, `MANUAL`, `CUSTOM`) with immutable template/signature snapshots (no persisted generated PDF/PNG files) |
| `CertificateTemplate`           | `certificate_templates`                               | Phase 17: reusable certificate template configuration (`CLASSIC_INSTITUTIONAL`, `MODERN_MINIMAL`, `PREMIUM_ACHIEVEMENT`), versioning, and default signatory layout                                                                                  |
| `CertificateSignature`          | `certificate_signatures`                              | Phase 17: digital signature PNG registry with free-text designation, transparency metadata, and active status                                                                                                                                       |
| `CertificateTemplateSignature`  | `certificate_template_signatures`                     | Phase 17: ordered template ↔ signature placements (2–4 per template, name/designation visibility flags)                                                                                                                                             |
| `CertificateSettings`           | `certificate_settings`                                | Phase 17: global academy certificate defaults (default template, QR toggle, auto-issuance toggles)                                                                                                                                                  |
| `CertificateVerification`       | `certificate_verifications`                           | Phase 17: 1:1 public verification URL payload, lookup count, and last-verified telemetry                                                                                                                                                            |
| `CertificateAuditLog`           | `certificate_audit_logs`                              | Phase 17: append-only certificate lifecycle, signature, template, and settings audit log                                                                                                                                                            |
| `JobSequence`                   | `job_sequences`                                       | Phase 16: atomic year-based counter for unique job identifiers (`ASRA-JOB-YYYY-XXXXX`)                                                                                                                                                              |
| `ApplicationSequence`           | `application_sequences`                               | Phase 16: atomic year-based counter for unique application reference numbers (`ASRA-APP-YYYY-XXXXX`)                                                                                                                                                |
| `Job`                           | `jobs`                                                | Phase 16: recruitment vacancy with compensation visibility, department, deadlines, and state                                                                                                                                                        |
| `JobApplicationQuestion`        | `job_application_questions`                           | Phase 16: dynamic screening questions configured per job with type, options, and limits                                                                                                                                                             |
| `JobApplication`                | `job_applications`                                    | Phase 16: guest candidate application, resume metadata, and recruitment pipeline stage                                                                                                                                                              |
| `JobApplicationAnswer`          | `job_application_answers`                             | Phase 16: immutable candidate answers with snapshotted question labels and option definitions                                                                                                                                                       |
| `JobApplicationStatusHistory`   | `job_application_status_history`                      | Phase 16: append-only audit log of application status transitions, actor, and remarks                                                                                                                                                               |
| `JobApplicationNote`            | `job_application_notes`                               | Phase 16: confidential internal evaluation notes added by recruitment administrators                                                                                                                                                                |
| `JobInterview`                  | `job_interviews`                                      | Phase 16: scheduled interviews with Google Meet link, interviewers, timestamps, and outcome                                                                                                                                                         |
| `JobApplicationCommunication`   | `job_application_communications`                      | Phase 16: outbox log of transactional recruitment emails sent via Resend with delivery status                                                                                                                                                       |

### Why the two additional models

`UserRole` and `RolePermission` are explicit join tables rather than Prisma implicit many-to-many relations. This gives:

- snake_case table and column names, consistent with every other table;
- an assignment timestamp (`assigned_at`, `granted_at`), which audit logging (FR-AUD-001) will need;
- `RESTRICT` on role deletion while users still hold that role.

No other models were added beyond the Phase 02 list.

## 2. Key design decisions

### 2.1 Users and roles: many-to-many

The requirements do not say whether a user can hold more than one role. Admin sub-roles are pending (S-01), and a faculty member who is also an admin is plausible. The schema therefore uses the **least restrictive** model: a user can hold several roles through `user_roles`.

A one-role-per-user policy, if the client confirms it, can be enforced in the Phase 03 service layer without a schema change. This is recorded as **CLIENT-CLARIFICATIONS S-04**.

Roles are **rows, not a PostgreSQL enum**. New roles (e.g. Parent/Guardian, Accounts) need no migration. `Role.isSystem` marks seeded roles that administrators must not delete.

### 2.2 Profiles are separate from User

`User` holds identity and authentication data only. Student and faculty data live in `StudentProfile` and `FacultyProfile` (each `user_id UNIQUE`, so at most one of each per user). A profile is deleted with its user (`CASCADE`).

Registration fields, date of birth, guardian details and parental consent are **pending** (D-01, E-01). They are deliberately absent and will be added by a later migration once confirmed.

### 2.3 Academic structure

- `AcademicLevel 1──< Class` and `AcademicLevel 1──< Stream`. Class and stream names are unique within a level; slugs are globally unique.
- `Subject` is **independent** of class and stream. Where a subject is taught is expressed by a **Course** (`class_id`, `stream_id`, `subject_id`, all optional). This follows SRS §1.3: a course is "a subject for a class, or a special course". No class–subject mapping table is introduced until the client confirms the subject list per class and stream (A-01, A-02).
- `AcademicLevel.board` is a free-text curriculum label (e.g. "CBSE"). Supporting more boards (A-03) does not need a redesign. `Class.gradeNumber` is deliberately **not unique**, so a second board can reuse the same grades.
- Faculty subject allocation (FR-FAC-002) is derived from course assignments. If the client needs allocation independent of courses, a `faculty_subjects` table can be added in Phase 06.
- **No academic catalogue is seeded.** Classes, streams, subjects and categories are created by admins (Phase 06).

### 2.4 Courses

- `status` (`DRAFT` | `PUBLISHED` | `ARCHIVED`). `published_at` is required once a course is published (CHECK).
- `visibility` (`PUBLIC` | `UNLISTED` | `PRIVATE`, Phase 06) is independent of `status`; see [COURSE-MANAGEMENT.md §3](./COURSE-MANAGEMENT.md#3-publication-and-visibility).
- `category_id`, `class_id`, `stream_id` and `subject_id` are all optional. Special courses have no class, and school courses do not require a category.
- **Phase 06 fields:** `thumbnail_url` (HTTPS, exclusive with `thumbnail_key`), `duration_minutes` (estimated learning time, minutes), `price_minor` + `currency` (minor units, ISO 4217; `0` = free), `discount_type` + `discount_value` (percentage 1–100 or fixed amount ≤ price). Price data is administration-only; no checkout price is derived (PHASE 10).
- **Not modelled yet:** language, level, batches and validity (B-02…B-04, A-06).
- `course_instructors` links to `faculty_profiles`, not `users`, so only faculty can be instructors. "Exactly one primary instructor when any are assigned" is a **service-layer rule**, implemented in Phase 06 (`courseInstructorsSchema`). Prisma 7.10 cannot declare the partial unique index this would need without the index being reported as drift.

### 2.5 Curriculum and content

```
Course ──< Module ──< Chapter ──< Lesson ──< Resource
```

- Each level has a 0-based `position`, unique within its parent (`@@unique([parentId, position])`) and non-negative (CHECK).
- To **reorder** siblings, do it inside one transaction. The unique index is not deferrable, so first move the affected rows to temporary positions (e.g. negative values are rejected, so use `position + 10000`), then write their final positions.
- `Lesson`: `content_type` (`VIDEO` | `DOCUMENT` | `TEXT` | `LINK`, plus `PDF` | `QUIZ` | `ASSIGNMENT` from Phase 06 — quiz/assignment are placeholders until PHASE 09), optional `body`, `status`, `duration_seconds`, `is_preview` (H-04 assumption) and `published_at` (required when published).
- `Resource` never stores binary data. It points to **exactly one** location:
  - a stored object: `storage_provider` + `storage_key` (provider-neutral, e.g. `s3`, `r2` or `vimeo` with the object key); or
  - an external URL: `external_url`.

  The CHECK `resources_location_exclusive` enforces this, and `EXTERNAL_LINK` resources must use a URL. The Zod schema `resourceInputSchema` in `@asra/validation` mirrors the same rule for API input. Since Phase 06 external URLs must be `https://` on a public domain, and the API refuses stored-object locations while no storage provider is configured (`apps/api/src/config/storage.ts`). Upload and signed URLs come in a later phase (R-01, G-01).

### 2.6 Careers & Recruitment Subsystem (Phase 16)

The recruitment subsystem provides a complete, isolated, guest-friendly applicant flow with dedicated administrative management:

- **Guest Applicant Model:** Applicants never touch the `users` table, eliminating credential leaks, account creation fatigue, and unnecessary database bloating. Submissions are stored in `job_applications`.
- **Atomic Sequential Identifiers:** Two dedicated sequence tables (`job_sequences` and `application_sequences`) maintain year-partitioned counters (`ASRA-JOB-YYYY-XXXXX` and `ASRA-APP-YYYY-XXXXX`), protected against race conditions using PostgreSQL row-level locks.
- **Dynamic Question Snapshots:** When an applicant answers job-specific questions, the responses in `job_application_answers` store frozen snapshots (`question_label`, `question_type`, `options_snapshot`). Updating or deleting questions on the job record later does not alter historical application data.
- **Strict Anti-Duplicate Submissions:** `UNIQUE (job_id, email)` ensures an applicant cannot flood a posting with multiple submissions while allowing them to apply for different positions across the academy.
- **Secure File Storage & Auditability:** Resumes are uploaded to Cloudinary (or secure local storage) with tamper-proof HMAC tokens, and streamed only via authenticated administrative endpoints. Status changes, confidential notes, interviews, and outbox communications are all audited across dedicated tables (`job_application_status_history`, `job_application_notes`, `job_interviews`, `job_application_communications`).

## 3. Conventions

| Topic        | Convention                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Naming       | Models `PascalCase` singular → tables `snake_case` plural (`@@map`). Fields `camelCase` → columns `snake_case` (`@map`). Enums `snake_case` types.                                |
| Primary keys | `UUID DEFAULT gen_random_uuid()` (built into PostgreSQL ≥ 13, available on Neon). IDs are generated by the database, so raw SQL and Prisma agree. Join tables use composite keys. |
| Timestamps   | `created_at` / `updated_at` as `timestamptz(3)`. Prisma writes UTC; `updated_at` is maintained by Prisma (`@updatedAt`).                                                          |
| Strings      | Bounded `varchar(n)` for identifiers, names and keys; `text` for long-form descriptions and bodies.                                                                               |
| Emails       | Stored trimmed and lower-case (CHECK), so the plain unique index is case-insensitive. Normalise with `emailSchema` from `@asra/validation`.                                       |
| Slugs        | `^[a-z0-9]+(-[a-z0-9]+)*$` (CHECK) and unique per table. Validate with `slugSchema`.                                                                                              |
| Archival     | Catalogue rows (levels, classes, streams, subjects, categories) are retired with `is_active = false`. There is no global soft-delete.                                             |
| Deletion     | `RESTRICT` from catalogue rows and from roles and faculty in use. `CASCADE` down the curriculum tree and from a user to its profiles and role links.                              |
| Updates      | All foreign keys use `ON UPDATE CASCADE` (UUID keys are never expected to change).                                                                                                |

## 4. Constraints

### 4.1 Unique

| Table                                                    | Unique on                                        |
| -------------------------------------------------------- | ------------------------------------------------ |
| `users`                                                  | `email`                                          |
| `roles` / `permissions`                                  | `key`                                            |
| `user_roles` / `role_permissions` / `course_instructors` | composite primary key (no duplicate assignments) |
| `student_profiles`                                       | `user_id`, `student_code`                        |
| `faculty_profiles`                                       | `user_id`, `employee_code`                       |
| `academic_levels`                                        | `name`, `slug`                                   |
| `classes` / `streams`                                    | `slug`; `(academic_level_id, name)`              |
| `subjects`                                               | `name`, `slug`, `code`                           |
| `course_categories`                                      | `name`, `slug`                                   |
| `courses`                                                | `slug`                                           |
| `modules` / `chapters` / `lessons` / `resources`         | `(parent_id, position)`                          |

Nullable unique columns (`student_code`, `employee_code`, `subjects.code`) allow any number of `NULL`s.

### 4.2 CHECK constraints (hand-written in the migration SQL)

Prisma cannot declare CHECK constraints. They are appended to `20261013042559_init_database_core/migration.sql`. Prisma Migrate does not diff CHECK constraints, so later migrations keep them; verify with `npm run db:migrate`, which reports "Already in sync".

| Constraint                                                                | Rule                                         |
| ------------------------------------------------------------------------- | -------------------------------------------- |
| `users_email_normalized`                                                  | `email = lower(btrim(email))` and not empty  |
| `roles_key_format`                                                        | `^[A-Z][A-Z0-9_]*$`                          |
| `permissions_key_format`                                                  | `resource.action` in lower snake case        |
| `*_slug_format` (levels, classes, streams, subjects, categories, courses) | slug pattern                                 |
| `classes_grade_number_positive`                                           | `grade_number > 0`                           |
| `faculty_profiles_experience_years_non_negative`                          | `experience_years >= 0`                      |
| `modules/chapters/lessons/resources_position_non_negative`                | `position >= 0`                              |
| `lessons_duration_seconds_non_negative`                                   | `duration_seconds >= 0`                      |
| `resources_size_bytes_non_negative`                                       | `size_bytes >= 0`                            |
| `courses_published_at_required`, `lessons_published_at_required`          | `PUBLISHED` ⇒ `published_at IS NOT NULL`     |
| `resources_location_exclusive`                                            | (provider + key) XOR external URL            |
| `resources_external_link_has_url`                                         | `EXTERNAL_LINK` ⇒ `external_url IS NOT NULL` |

### 4.2.1 Phase 03 CHECK constraints (`20261013045953_auth_sessions_and_tokens`)

| Constraint                                                                                                         | Rule                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `auth_sessions_token_hash_format`, `auth_sessions_previous_token_hash_format`, `one_time_tokens_token_hash_format` | `^[0-9a-f]{64}$` — only SHA-256 digests can be stored, never a raw token |
| `auth_sessions_revocation_consistent`                                                                              | `revoked_at` and `revoked_reason` are both set or both null              |
| `auth_sessions_expires_after_created`, `one_time_tokens_expires_after_created`                                     | `expires_at > created_at`                                                |

Unique: `auth_sessions.token_hash`, `auth_sessions.previous_token_hash`, `one_time_tokens.token_hash`. Indexes: `(user_id, revoked_at)`, `(user_id, purpose)`, `expires_at` (future cleanup job). Both tables `CASCADE` from `users`. Design rationale: [AUTHENTICATION.md](./AUTHENTICATION.md).

### 4.2.2 Phase 06 CHECK constraints (`20261015071102_phase06_course_management`)

| Constraint                             | Rule                                               |
| -------------------------------------- | -------------------------------------------------- |
| `courses_duration_minutes_positive`    | `duration_minutes IS NULL OR > 0`                  |
| `courses_price_minor_non_negative`     | `price_minor IS NULL OR >= 0`                      |
| `courses_price_currency_consistent`    | price and currency both set or both null           |
| `courses_currency_format`              | `currency ~ '^[A-Z]{3}$'`                          |
| `courses_discount_consistent`          | discount type and value both set or both null      |
| `courses_discount_requires_price`      | a discount needs `price_minor > 0`                 |
| `courses_discount_value_valid`         | `PERCENTAGE` 1–100; `FIXED_AMOUNT` 1–`price_minor` |
| `courses_thumbnail_location_exclusive` | not both `thumbnail_key` and `thumbnail_url`       |
| `courses_thumbnail_url_https`          | `thumbnail_url ~ '^https://'`                      |

The same rules are validated first by the Zod schemas in `@asra/validation` (`courses.ts`) so clients get field-level errors; the CHECKs are the backstop. New index: `courses(status, visibility)` for the public catalogue.

### 4.2.3 Phase 07 constraints (`20261016083843_phase07_student_lms`)

| Constraint                                    | Rule                                                |
| --------------------------------------------- | --------------------------------------------------- |
| `enrollments_cancelled_at_consistent`         | `status = 'CANCELLED'` ⇔ `cancelled_at IS NOT NULL` |
| `enrollments_free_has_no_enroller`            | a `FREE` enrolment never names an administrator     |
| `lesson_progress_video_position_non_negative` | `video_position_seconds IS NULL OR >= 0`            |
| `lesson_progress_video_watched_non_negative`  | `video_watched_seconds >= 0`                        |

Unique: `enrollments(user_id, course_id)` (one enrolment per student and course; re-enrolment reactivates the row) and `lesson_progress(user_id, lesson_id)` (one current progress row per student and lesson). Indexes: `enrollments(user_id, status, last_activity_at)` (dashboard/continue learning), `enrollments(course_id, status)` (admin lists), `lesson_progress(user_id, last_viewed_at)` (history), plus the foreign keys. Referential actions: student deleted → their enrolments and progress `CASCADE`; course with enrolments → `RESTRICT` (archive instead); lesson deleted → its progress `CASCADE`, `enrollments.last_lesson_id` `SET NULL`; administrator deleted → `enrolled_by_id` `SET NULL`. Rules and rationale: [STUDENT-LMS.md](./STUDENT-LMS.md).

### 4.2.4 Phase 08 constraints (`20261016102329_phase08_faculty_portal`)

| Constraint                                      | Rule                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `assignments_max_marks_range`                   | `max_marks BETWEEN 1 AND 1000`                                            |
| `assignment_submissions_marks_non_negative`     | `marks_awarded IS NULL OR >= 0` (upper bound = max marks, in the service) |
| `assignment_submissions_graded_consistent`      | `status = 'GRADED'` ⇔ marks and `graded_at` recorded                      |
| `assignment_submissions_release_requires_grade` | `result_released_at` only on a GRADED submission                          |
| `assignment_submissions_body_not_blank`         | the submitted text is not empty                                           |
| `assignment_submissions_attachment_https`       | `attachment_url` is null or starts with `https://`                        |
| `live_class_sessions_duration_range`            | `duration_minutes BETWEEN 15 AND 480`                                     |
| `live_class_sessions_cancelled_at_consistent`   | `status = 'CANCELLED'` ⇔ `cancelled_at IS NOT NULL`                       |
| `live_class_sessions_join_url_https`            | `join_url` is null, or `https://…` with a `provider` recorded             |

Unique: `assignments(lesson_id)` (one settings row per lesson) and `assignment_submissions(assignment_id, user_id)` (one submission per student, I-02). Indexes: `assignment_submissions(assignment_id, status)` (review queue/counts), `(user_id, result_released_at)` (student results), `live_class_sessions(course_id, starts_at)` and `(host_faculty_profile_id, starts_at)` (schedules), plus the foreign keys. Referential actions: lesson deleted → its `assignments` row `CASCADE`, but `assignment_submissions → assignments` is `RESTRICT`, so a lesson with submitted work cannot be deleted (the service answers 409 first); student deleted → their submissions `CASCADE`; reviewer/creator deleted → `SET NULL`; course deleted → its live classes `CASCADE` (courses are deletable only while empty drafts). Rules: [FACULTY-PORTAL.md](./FACULTY-PORTAL.md).

### 4.2.5 Phase 09 constraints (`20261017090000_phase09_assessment_engine`)

Details and rationale: [ASSESSMENTS.md](./ASSESSMENTS.md) §3.

| Table                             | Constraint(s)                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assignment_submissions`          | `version_positive`                                                                                                                                                                                                                                                                                                                                       |
| `assignment_submission_revisions` | `version_positive`, `attachment_https`; unique `(submission_id, version)`                                                                                                                                                                                                                                                                                |
| `quizzes`                         | `time_limit_range` (1–300 or NULL), `max_attempts_range` (1–20), `pass_percent_range` (0–100), `questions_per_attempt_positive`, `published_at_consistent`, `closed_at_consistent`                                                                                                                                                                       |
| `examinations`                    | `window_order` (`closes_at > opens_at`), `duration_range` (1–600), `max_attempts_range` (1–5), `pass_percent_range`, `title_not_blank`, `published_at_consistent`, `closed_at_consistent`                                                                                                                                                                |
| `assessment_questions`            | `single_owner` (quiz XOR exam), `marks_range` (0 < marks ≤ 100), `negative_marks_range` (0 ≤ negative ≤ marks), `position_non_negative`, `prompt_not_blank`                                                                                                                                                                                              |
| `assessment_question_options`     | `position_non_negative`; unique `(question_id, position)`                                                                                                                                                                                                                                                                                                |
| `assessment_attempts`             | `single_owner`, `number_positive`, `deadline_after_start`, `finalized_consistent` (IN_PROGRESS ⇔ no finalized/submitted time and no evaluation), `expired_has_deadline`, `scores_non_negative` (0 ≤ score ≤ max, 0 ≤ percent ≤ 100), `evaluated_consistent`; unique `(quiz_id, user_id, attempt_number)` and `(examination_id, user_id, attempt_number)` |
| `attempt_questions`               | `marks_range`, `awarded_range` (0 … marks), `penalty_range` (0 … negative marks), `sequence_non_negative`; unique `(attempt_id, position)`                                                                                                                                                                                                               |

Foreign keys: attempts → quizzes/examinations and examinations → courses are RESTRICT (history is never cascaded away); questions/options/attempt questions CASCADE from their owner; `attempt_questions.question_id` is SET NULL (the snapshot stays authoritative); audit rows have no FK to their subject.

### 4.2.6 Phase 10 constraints (`20261019090000_phase10_enrolment_payment`)

Details and rationale: [PAYMENTS.md](./PAYMENTS.md) §9.

| Table                    | Constraint(s)                                                                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders`                 | partial unique `orders_one_open_per_student_course` (`user_id, course_id` WHERE status IN CREATED/PENDING); `amounts_valid` (amount = list − discount, all ≥ 0); `currency_format`; `discount_pair`; `provider_order_when_open`; `paid_consistent`; `counters_non_negative`; unique `reference`, `provider_order_id` |
| `payments`               | `amounts_valid` (amount > 0, 0 ≤ refunded ≤ amount), `currency_format`, `captured_consistent`, `applied_requires_capture`, `refund_requires_capture`; unique `(provider, provider_payment_id)`                                                                                                                       |
| `refunds`                | `amount_positive`, `currency_format`, `processed_consistent`; unique `receipt`, `idempotency_key`, `provider_refund_id`                                                                                                                                                                                              |
| `payment_webhook_events` | `hash_format`, `attempts_non_negative`; unique `(provider, mode, event_id)`                                                                                                                                                                                                                                          |

Foreign keys: orders, payments and refunds are RESTRICT towards users, courses and each other, so financial history can never be cascaded away (a student or course with orders cannot be hard-deleted; deactivate/archive instead). `enrollments.order_id` is RESTRICT. Audit rows have no FK to their subject. `EnrollmentSource` gained `PAYMENT` (the migration only adds the value; `PAYMENT ⇒ order_id` is enforced by the payment service).

### 4.2.7 Phase 11 constraints (`20261020090000_phase11_live_classes_notifications`)

| Table                     | Constraint                                      | Rule                                                         |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| `live_class_sessions`     | `live_class_sessions_completed_at_consistent`   | `completed_at` set exactly when `status = COMPLETED`         |
| `live_class_sessions`     | `live_class_sessions_recording_url_https`       | Recording link is `https://…` and has `recording_updated_at` |
| `live_class_sessions`     | `live_class_sessions_meeting_id_has_provider`   | A provider meeting id always names its provider              |
| `live_class_sessions`     | `live_class_sessions_time_zone_not_blank`       | Time zone is not empty                                       |
| `live_class_sessions`     | UNIQUE `(provider, provider_meeting_id)`        | One class per provider meeting                               |
| `notifications`           | UNIQUE `(user_id, dedupe_key)`                  | One notification per recipient and event occurrence          |
| `notifications`           | `notifications_event_format`                    | `event` is `family.action`                                   |
| `notifications`           | `notifications_action_url_relative`             | Action link is an app path (`/…`, never `//…`)               |
| `notifications`           | `notifications_resource_pair`                   | Resource type and id set together                            |
| `notification_deliveries` | UNIQUE `(notification_id, channel)`             | One delivery per channel                                     |
| `notification_deliveries` | `notification_deliveries_accepted_consistent`   | `accepted_at` set exactly when `ACCEPTED`                    |
| `notification_deliveries` | `notification_deliveries_claim_consistent`      | `claimed_at` set exactly when `SENDING`                      |
| `notification_deliveries` | `notification_deliveries_attempts_non_negative` | `attempts >= 0`                                              |

### 4.2.8 Phase 12 constraints (`20261023090000_phase12_admin_dashboard`)

| Table              | Constraint                            | Rule                                                   |
| ------------------ | ------------------------------------- | ------------------------------------------------------ |
| `admin_audit_logs` | `admin_audit_logs_action_format`      | `action` is `family.action` (e.g. `user.role_granted`) |
| `admin_audit_logs` | `admin_audit_logs_entity_type_format` | `entity_type` is lower-case `snake_case`               |

### 4.2.9 Phase 13 constraints (`20261025090000_phase13_certificate_system`)

| Table          | Constraint                               | Rule                                                                                                   |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `certificates` | UNIQUE `certificate_number`              | Unique public verification code                                                                        |
| `certificates` | UNIQUE `enrollment_id`                   | One certificate per qualifying enrollment                                                              |
| `certificates` | `certificates_certificate_number_format` | `certificate_number` matches `^ASRA-[0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$`                                 |
| `certificates` | `certificates_recipient_name_not_blank`  | `recipient_name` is non-empty                                                                          |
| `certificates` | `certificates_course_title_not_blank`    | `course_title` is non-empty                                                                            |
| `certificates` | `certificates_revocation_consistent`     | If `status = 'REVOKED'`, `revoked_at` and `revoked_reason` must be set; if `ISSUED`, both must be null |

Foreign keys (Phase 13 + Phase 17 upgrade `20261112090000_phase17_generic_certificate_module`):

- `enrollment_id` references `enrollments(id)` ON DELETE RESTRICT ON UPDATE CASCADE (nullable since Phase 17 for non-course sources).
- `user_id` references `users(id)` ON DELETE RESTRICT ON UPDATE CASCADE (nullable since Phase 17 for manual external recipients).
- `course_id` references `courses(id)` ON DELETE RESTRICT ON UPDATE CASCADE (nullable).
- `academy_quiz_id` references `academy_quizzes(id)` ON DELETE RESTRICT ON UPDATE CASCADE (nullable).
- `examination_id` references `examinations(id)` ON DELETE RESTRICT ON UPDATE CASCADE (nullable).
- `template_id` references `certificate_templates(id)` ON DELETE SET NULL ON UPDATE CASCADE.
- `reissued_from_id` references `certificates(id)` ON DELETE SET NULL ON UPDATE CASCADE (self-relation).
- `issued_by_id` references `users(id)` ON DELETE SET NULL ON UPDATE CASCADE.
  Historical completion integrity: a student, course, quiz, exam, or enrollment with an issued certificate cannot be hard-deleted.

Phase 17 constraints (`20261112090000_phase17_generic_certificate_module`):

| Table                             | Constraint                                          | Rule                                                                              |
| --------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `certificates`                    | `certificates_enrollment_requires_course_and_user`  | When `enrollment_id` is set, both `course_id` and `user_id` must be present       |
| `certificates`                    | UNIQUE `idempotency_key`                            | Guarantees duplicate-free issuance per `(source_type, source_reference, user_id)` |
| `certificate_signatures`          | `certificate_signatures_dimensions_positive`        | Signature PNG `width > 0`, `height > 0`, and `bytes > 0`                          |
| `certificate_template_signatures` | UNIQUE `(template_id, signature_id)`                | Prevents selecting the same digital signature twice on one template               |
| `certificate_template_signatures` | `certificate_template_signatures_sort_order_range`  | Restricts placement `sort_order` to `0..3` (max 4 slots)                          |
| `certificate_verifications`       | UNIQUE `certificate_id`, UNIQUE `verification_code` | 1:1 public verification lookup record per credential                              |

### 4.3 Indexes

Besides the unique indexes above, there are B-tree indexes on:

- every foreign key not already covered by a unique or composite index (`user_roles.role_id`, `role_permissions.permission_id`, `student_profiles.class_id`/`stream_id`, `course_instructors.faculty_profile_id`, `courses.category_id`/`stream_id`/`subject_id`, and `(class_id, subject_id)`);
- the main listing filters: `users.status`, `courses(status, published_at)`, `lessons.status`, `faculty_profiles.is_public`, `classes.grade_number`, and `(is_active, sort_order)` on catalogue tables;
- Phase 12 analytics time series: `users.created_at` (student registrations) and `enrollments.enrolled_at` (new enrolments); `admin_audit_logs` on `created_at`, `(action, created_at)`, `(entity_type, entity_id, created_at)` and `actor_id` for the audit viewer. Payment analytics reuse the Phase 10 `(status, mode, captured_at)` index;
- Phase 13 certificates: `(user_id, status, issued_at)` for student portal listings, `(course_id, status)` for course credential reporting, `(status, issued_at)` for administrative filtering, and `issued_by_id` for staff action auditing. Public verification uses the unique index on `certificate_number`.

## 5. Connections: local vs. Neon

| Variable              | Used by                                          | Local (Docker)                               | Neon (staging/production)                                |
| --------------------- | ------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------- |
| `DATABASE_URL`        | Running API (`pg` pool via `@prisma/adapter-pg`) | `postgresql://…@localhost:5432/asra_academy` | **Pooled** endpoint (`…-pooler…`) with `sslmode=require` |
| `DIRECT_DATABASE_URL` | Prisma CLI (`prisma.config.ts`): migrate, studio | same as `DATABASE_URL`                       | **Direct** endpoint with `sslmode=require`               |
| `DATABASE_POOL_MAX`   | API pool size per process (default 10)           | default                                      | keep small; the Neon pooler multiplexes                  |
| `TEST_DATABASE_URL`   | Automated tests (optional)                       | defaults to `<DATABASE_URL db>_test`         | **never** Neon (refused by the test harness)             |

In Prisma 7 the schema's `datasource` block holds no URL:

- `prisma.config.ts` supplies the CLI URL (`DIRECT_DATABASE_URL`, falling back to `DATABASE_URL`);
- the runtime client receives `DATABASE_URL` through the driver adapter (`apps/api/src/database/prisma.ts`).
- the seed (`prisma db seed` → `prisma/seed.ts`) uses that same runtime client, so it connects through `DATABASE_URL`.

Migrations go over the direct connection because they take advisory locks, which PgBouncer transaction pooling does not support.

## 6. Day-to-day workflow (local)

All commands run from the repository root.

```bash
# 1. Start PostgreSQL + Redis and wait for "(healthy)"
docker compose up -d
docker compose ps

# 2. Check PostgreSQL readiness directly (optional)
docker exec asra-postgres pg_isready -U asra -d asra_academy

# 3. Generate the Prisma client and validate the schema
npm run db:generate
npm run db:validate

# 4. Apply all migrations (creates the database objects on a fresh volume)
npm run db:migrate

# 5. Seed reference data (roles + permissions) — safe to repeat
npm run db:seed

# 6. Inspect data
npm run db:studio            # http://localhost:5555
npm run check:services       # PostgreSQL + Redis connectivity
npm run db:migrate:status    # applied vs. pending migrations
```

### Changing the schema

1. Edit `apps/api/prisma/schema.prisma`.
2. Run `npm run db:migrate -- --name <short_snake_case_name>`. This creates `prisma/migrations/<timestamp>_<name>/migration.sql`, applies it locally and regenerates the client.
   - To review or hand-edit the SQL first (e.g. to add a CHECK constraint or a data backfill), run `npm run db:migrate:create -- --name <name>`, edit the file, then run `npm run db:migrate`.
3. Run `npm test -w @asra/api`. The schema test fails if the migrations and `schema.prisma` disagree.
4. Commit the schema **and** the new migration folder together. Never edit a migration that has already been applied outside your machine; add a new migration instead.

### Command reference

| Root command                | Runs                                         | Notes                                                          |
| --------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `npm run db:generate`       | `prisma generate`                            | Client output: `apps/api/src/generated/prisma` (git-ignored)   |
| `npm run db:validate`       | `prisma validate`                            |                                                                |
| `npm run db:migrate`        | `prisma migrate dev` (guarded)               | **Local hosts only**; can prompt to reset on drift             |
| `npm run db:migrate:create` | `prisma migrate dev --create-only` (guarded) | Create SQL without applying                                    |
| `npm run db:migrate:deploy` | `prisma migrate deploy`                      | Applies committed migrations only. Use for Neon. Never resets. |
| `npm run db:migrate:status` | `prisma migrate status`                      | Read-only                                                      |
| `npm run db:seed`           | `prisma db seed` → `apps/api/prisma/seed.ts` | Idempotent                                                     |
| `npm run db:studio`         | `prisma studio` on :5555                     |                                                                |
| `npm run db:reset`          | `prisma migrate reset` + seed (guarded)      | ⚠ **Destroys all local data**; asks for confirmation           |

"Guarded" commands go through `apps/api/scripts/db-command.ts`. It refuses to run when `NODE_ENV=production` or when the migration URL's host is not local (`localhost`, `127.0.0.1`, `::1`, `host.docker.internal`). A Neon URL is therefore always rejected.

## 7. Resetting the local database

```bash
npm run db:reset
```

This **drops every table and all data** in the local database. It then re-applies all migrations and runs the seed. Prisma asks for confirmation first, and the guard refuses non-local hosts.

To wipe the Docker volume entirely (e.g. after changing `POSTGRES_PASSWORD`):

```bash
docker compose down -v      # deletes the asra_postgres_data volume
docker compose up -d
npm run db:migrate && npm run db:seed
```

Nothing resets the database automatically: not `npm run dev`, not API startup, and not CI.

## 8. Seed

`apps/api/prisma/seed.ts` calls `seedAccessControl()` (`apps/api/src/database/seed/`). The seed creates **only** RBAC reference data:

| Permission                     | Requirement                 | SUPER_ADMIN | ADMIN | FACULTY | STUDENT |
| ------------------------------ | --------------------------- | :---------: | :---: | :-----: | :-----: |
| `system.manage`                | SRS §4                      |      ✓      |       |         |         |
| `admins.manage`                | FR-ADM-014                  |      ✓      |       |         |         |
| `roles.manage`                 | FR-RBAC-005                 |      ✓      |       |         |         |
| `students.manage`              | FR-ADM-001                  |      ✓      |   ✓   |         |         |
| `faculty.manage`               | FR-ADM-002                  |      ✓      |   ✓   |         |         |
| `academic_structure.manage`    | FR-ADM-003, FR-ACA-003      |      ✓      |   ✓   |         |         |
| `courses.manage`               | FR-ADM-004                  |      ✓      |   ✓   |         |         |
| `content.manage`               | FR-ADM-009                  |      ✓      |   ✓   |         |         |
| `content.manage_assigned`      | FR-FAC-003/004, FR-RBAC-003 |      ✓      |       |    ✓    |         |
| `students.view_assigned`       | FR-FAC-007 (Phase 08)       |      ✓      |       |    ✓    |         |
| `submissions.grade_assigned`   | FR-FAC-006 (Phase 08)       |      ✓      |       |    ✓    |         |
| `live_classes.manage_assigned` | FR-FAC-005 (Phase 08)       |      ✓      |       |    ✓    |         |
| `enrollments.manage`           | Phase 07 (manual enrolment) |      ✓      |   ✓   |         |         |
| `content.view_enrolled`        | FR-RBAC-004                 |      ✓      |       |         |    ✓    |
| `profile.manage_own`           | FR-STU-008                  |      ✓      |   ✓   |    ✓    |    ✓    |
| `payments.make_own`            | Phase 10                    |      ✓      |       |         |    ✓    |
| `payments.view`                | Phase 10                    |      ✓      |   ✓   |         |         |
| `payments.refund`              | Phase 10 (AD-03)            |      ✓      |       |         |         |
| `live_classes.manage`          | Phase 11                    |      ✓      |   ✓   |         |         |
| `analytics.view`               | Phase 12 (S-03)             |      ✓      |   ✓   |         |         |
| `notifications.view`           | Phase 12                    |      ✓      |   ✓   |         |         |
| `audit_logs.view`              | Phase 12 (AF-03)            |      ✓      |       |         |         |

Permission keys are shared with the web app as `PERMISSIONS` in `@asra/types`. Permissions for later modules (payments, assessments, certificates, notifications and reports) will be added in their phases. Because the seed is additive, run `npm run db:seed` once on existing databases to grant `enrollments.manage` (Phase 07), the three faculty permissions (Phase 08) and the Phase 12 permissions `analytics.view`, `notifications.view` and `audit_logs.view` — the admin dashboard returns 403 until this is done. The `*_assigned` permissions always also require a `CourseInstructor` assignment (FACULTY-PORTAL.md §2).

Properties:

- **Idempotent.** Roles and permissions are upserted by `key`, and grants use `createMany({ skipDuplicates: true })`. Re-running changes nothing (this is covered by tests).
- **Additive.** The seed never removes grants, so permissions an administrator adds later survive a re-seed. Removing a permission from the definitions requires an explicit migration or admin action.
- **Atomic.** The seed runs in one interactive transaction (~18 sequential round trips: one upsert per permission and role, then one grant insert). Its limits are raised above Prisma's 5 s default (`SEED_TRANSACTION_OPTIONS`) because, run from a workstation against remote Neon, each round trip can take a few hundred milliseconds.
- **No accounts.** No administrator, test user, password or email is seeded. Staff accounts (including the first Super Admin) are created explicitly with `npm run auth:create-user -- --email … --name "…" --role SUPER_ADMIN` (password via hidden prompt or `NEW_USER_PASSWORD`) — see [AUTHENTICATION.md §7](./AUTHENTICATION.md#7-provisioning-staff-accounts).
- **No academic catalogue.** The final classes, streams, subjects and courses are pending client confirmation; administrators create them in the Phase 06 admin portal.

## 9. Neon (staging / production)

Neon credentials were **not available during Phase 02**. Connectivity to Neon has **not been tested**; all verification used local Docker PostgreSQL.

To verify a Neon branch:

1. In the Neon console, create (or select) a project in the region closest to India (W-02), plus a branch (e.g. `dev`).
2. Copy **both** connection strings, each with `sslmode=require`:
   - Pooled (host contains `-pooler`) → `DATABASE_URL`
   - Direct → `DIRECT_DATABASE_URL`
3. Set them in the shell or the deployment platform's secret store, never in a committed file:

   ```bash
   export DATABASE_URL='postgresql://…-pooler…/asra?sslmode=require'
   export DIRECT_DATABASE_URL='postgresql://…/asra?sslmode=require'
   ```

4. Apply migrations with the non-destructive command: `npm run db:migrate:deploy`.
5. Check status: `npm run db:migrate:status` (expect "Database schema is up to date").
6. Seed reference data: `npm run db:seed`.
7. Check connectivity: `npm run check:services`. Alternatively, start the API and call `GET /api/v1/health/ready` (expect `"database": "up"`).

Production rules:

- Migrations are applied **deliberately**, as a deployment step (`db:migrate:deploy`), never on API startup.
- `db:migrate`, `db:migrate:create` and `db:reset` cannot target Neon; the guard refuses them.
- Use a dedicated least-privilege runtime role for `DATABASE_URL` where possible (FR-SEC-006). The migration role needs DDL rights.
- Backups and point-in-time recovery are provided by Neon. Retention is pending (W-05).

## 10. Tests

`npm test -w @asra/api` uses Node's built-in test runner with `tsx`, so no extra dependencies are needed. It runs against a **separate local database**: `TEST_DATABASE_URL`, or by default `DATABASE_URL` with `_test` appended (`asra_academy_test`). The harness refuses any non-local host and any database whose name does not end in `_test`.

Before the tests run, `npm run test:db:prepare -w @asra/api` creates the test database if needed and applies migrations with `migrate deploy`.

| File                     | Covers                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/schema.test.ts`   | `prisma validate`, migration status, migrations ≡ schema (no drift), generated models, CHECK constraints present                                              |
| `tests/seed.test.ts`     | Roles and permissions created, per-role grants, idempotency, additive behaviour                                                                               |
| `tests/database.test.ts` | Connectivity (up/down), unique/FK/CHECK enforcement, cascades, RESTRICT, UUIDs, UTC timestamps, error mapping                                                 |
| `tests/http.test.ts`     | Health/readiness, 404, malformed JSON, Zod validation → 422, Prisma errors → 409/422 without leaking SQL or row data                                          |
| Phase 06 suites          | `academics`, `courses`, `curriculum`, `public-catalog`, `acceptance-phase06` — see [COURSE-MANAGEMENT.md §9](./COURSE-MANAGEMENT.md#9-tests-and-verification) |
| Phase 07 suites          | `student-lms`, `progress-rules` — see [STUDENT-LMS.md §9](./STUDENT-LMS.md#9-tests-and-verification)                                                          |

`resetAuthState()` (tests/support/auth.ts) rebuilds role grants from the seed definitions before each test, so a permission granted at runtime by one test cannot leak into another suite (the seed itself stays additive).
