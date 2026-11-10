/**
 * Initial platform roles (see docs/SRS.md §4). Parent/Guardian and admin sub-roles are
 * pending client confirmation and will be added once confirmed. Roles are stored as data
 * (`roles` table), so new roles do not require a schema change.
 */
export const USER_ROLES = ['STUDENT', 'FACULTY', 'ADMIN', 'SUPER_ADMIN'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * Initial permission catalogue, derived from the documented role capabilities
 * (docs/SRS.md §8–11, docs/DATABASE.md §Seed). Keys are `<resource>.<action>`.
 * Enforcement (RBAC middleware) arrives in PHASE 03.
 */
export const PERMISSIONS = {
  /** Platform settings and system configuration — SRS §4 (Super Admin). */
  SYSTEM_MANAGE: 'system.manage',
  /** Create/disable admin accounts — FR-ADM-014. */
  ADMINS_MANAGE: 'admins.manage',
  /** Manage roles and their permissions — FR-RBAC-005. */
  ROLES_MANAGE: 'roles.manage',
  /** Manage student accounts — FR-ADM-001. */
  STUDENTS_MANAGE: 'students.manage',
  /** Manage faculty accounts and profiles — FR-ADM-002. */
  FACULTY_MANAGE: 'faculty.manage',
  /** Manage academic levels, classes, streams and subjects — FR-ADM-003, FR-ACA-003. */
  ACADEMIC_STRUCTURE_MANAGE: 'academic_structure.manage',
  /** Manage courses, categories and instructor assignments — FR-ADM-004. */
  COURSES_MANAGE: 'courses.manage',
  /** Manage learning content of any course — FR-ADM-009. */
  CONTENT_MANAGE: 'content.manage',
  /** Manage learning content of courses the faculty member is assigned to — FR-FAC-003/004, FR-RBAC-003. */
  CONTENT_MANAGE_ASSIGNED: 'content.manage_assigned',
  /** View progress and work of students enrolled in assigned courses — FR-FAC-007 (PHASE 08). */
  STUDENTS_VIEW_ASSIGNED: 'students.view_assigned',
  /** Review, grade and release assignment submissions of assigned courses — FR-FAC-006 (PHASE 08). */
  SUBMISSIONS_GRADE_ASSIGNED: 'submissions.grade_assigned',
  /** Schedule and manage live classes of assigned courses — FR-FAC-005 (PHASE 08). */
  LIVE_CLASSES_MANAGE_ASSIGNED: 'live_classes.manage_assigned',
  /** Schedule live classes for any course and assign their host faculty (PHASE 11). */
  LIVE_CLASSES_MANAGE: 'live_classes.manage',
  /** Enrol students in courses and cancel enrolments (manual/offline enrolment, PHASE 07). */
  ENROLLMENTS_MANAGE: 'enrollments.manage',
  /** View learning content of courses the student is enrolled in — FR-RBAC-004. */
  CONTENT_VIEW_ENROLLED: 'content.view_enrolled',
  /** View and update one's own profile — FR-STU-008. */
  PROFILE_MANAGE_OWN: 'profile.manage_own',
  /** Buy courses online and see one's own orders, payments and receipts (PHASE 10). */
  PAYMENTS_MAKE_OWN: 'payments.make_own',
  /** View orders, payments, refunds and revenue; reconcile with the provider (PHASE 10). */
  PAYMENTS_VIEW: 'payments.view',
  /** Issue refunds through the payment provider (PHASE 10; S-02 pending → Super Admin only). */
  PAYMENTS_REFUND: 'payments.refund',
  /** Dashboard KPIs and analytics reports (PHASE 12; S-03 pending — reports listed there). */
  ANALYTICS_VIEW: 'analytics.view',
  /** Inspect notification delivery activity of all users (PHASE 12). */
  NOTIFICATIONS_VIEW: 'notifications.view',
  /** Read the administrative, payment and assessment audit trails (PHASE 12; Super Admin only). */
  AUDIT_LOGS_VIEW: 'audit_logs.view',
  /** View certificates and public verification records (PHASE 13). */
  CERTIFICATES_VIEW: 'certificates.view',
  /** Manage certificates, generate and revoke certificates (PHASE 13). */
  CERTIFICATES_MANAGE: 'certificates.manage',
  /** Manage recruitment, job postings, applications, interviews, and candidate communications. */
  RECRUITMENT_MANAGE: 'recruitment.manage',
  /** Create and run standalone Academy Quizzes (questions, images, schedule, results). */
  ACADEMY_QUIZZES_MANAGE: 'academy_quizzes.manage',
  /** Take published Academy Quizzes (no course enrolment needed; eligibility still applies). */
  ACADEMY_QUIZZES_PARTICIPATE: 'academy_quizzes.participate',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
