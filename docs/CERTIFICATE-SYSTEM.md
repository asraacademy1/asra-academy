# ASRA Academy — Certificate Management System (Phase 13 + Phase 17 Upgrade)

| Field   | Value                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| Version | 2.0.0 (Phase 17 Generic Certificate Management Module)                                                                   |
| Status  | Complete Production Architecture — Backward-Compatible Upgrade                                                           |
| Scope   | Centralized issuance engine, 3 reusable PDF templates, digital signature management, student gallery, verification, RBAC |

---

## 1. Overview & Architecture

ASRA Academy's Certificate Management Module provides a single centralized engine for issuing, managing, verifying, and downloading official verifiable credentials across the entire platform:

- **Supported Sources (`CertificateSourceType`)**: `COURSE`, `ACADEMY_QUIZ`, `COMPETITION`, `EXAM`, `EVENT`, `WORKSHOP`, `TRAINING`, `MANUAL`, `CUSTOM`.
- **Admin Control Center (`/admin/certificates`)**:
  - Overview Dashboard (`/admin/certificates`)
  - Certificate Templates (`/admin/certificates/templates`)
  - Digital Signatures (`/admin/certificates/signatures`)
  - Issued Certificates Registry (`/admin/certificates/issued`)
  - Manual Certificate Generation (`/admin/certificates/generate`)
  - Verification & Settings (`/admin/certificates/settings`)
- **Backward Compatibility**: All Phase 13 course completion eligibility logic, `ASRA-YYYY-XXXX-XXXX` identifiers, existing certificate rows, and `/verify/:certificateNumber` routes remain intact.

```
   COURSE / ACADEMY_QUIZ / COMPETITION / EXAM / EVENT / WORKSHOP / TRAINING / MANUAL / CUSTOM
                                              │
                                              ▼
                       CertificateService.issueGenericCertificate({...})
                      (Eligibility + Idempotency + Unique ID + Snapshots)
                                              │
                   ┌──────────────────────────┴──────────────────────────┐
                   ▼                                                     ▼
   PostgreSQL Structured Data Only                              Verification Record
  (No generated PDF/PNG persisted or cached)                   /verify/:certificateNumber
                   │
                   ▼ (On-Demand Dynamic Rendering in Memory)
    Live React Preview · Sharp PNG (1684×1190) · PDFKit A4 PDF
```

---

## 2. Three Initial Certificate Templates

All three templates render server-side as printable **Landscape A4 (`841.89 × 595.28` pt)** PDFs via `pdfkit` (`apps/api/src/modules/certificates/pdf.service.ts`) with dynamic long-name sizing, vector QR codes (`qrcode`), academy branding, and 2–4 positioned digital signatures, paired with matching live React previews (`apps/web/src/components/certificates/certificate-preview.tsx`):

1. **Classic / Institutional (`CLASSIC_INSTITUTIONAL`)**: Ivory background, triple forest-green & gold academic borders, corner diamond flourishes, circular academy seal, traditional formal typography. Suitable for courses, diplomas, and training programs.
2. **Modern / Minimal (`MODERN_MINIMAL`)**: Crisp high-whitespace studio card layout with vertical accent stripe, structured metadata grid, top-right verification QR badge, and sleek underline signatures. Suitable for coding competitions, technical quizzes, and workshops.
3. **Premium / Achievement (`PREMIUM_ACHIEVEMENT`)**: Deep-emerald & champagne-gold ceremonial header ribbon, crest medallion, distinction achievement callout box, and editorial honor presentation. Suitable for excellence awards, Olympiad top performers, and special recognitions.

---

## 3. Digital Signatures & Selection Rules

- **Free-Text Official Designations**: Designations (Founder, Director, Academic Director, Principal, Examination Controller, Custom…) are never hardcoded. Multiple people holding similar titles remain uniquely identifiable by record ID, full name, and optional department.
- **Image Validation**: Uploads (`multipart/form-data` or base64 PNG) are inspected byte-for-byte via `validateSignaturePng`: strict PNG magic bytes + `IHDR` dimensions (`40×20` to `2400×1200`), size limit (`512 KB`), APNG (`acTL`) rejection, and alpha/tRNS transparency detection.
- **Original Preservation & Subtle Render Enhancement**: Uploaded original signature PNG binaries remain unmodified in Cloudinary in production (never generated certificate PDFs/PNGs/QRs). At render time, React Preview, SVG/Sharp PNG (`png.service.ts`), and PDFKit (`pdf.service.ts`) fetch required signature PNGs and render certificates dynamically in memory without storing output files.
- **Selection Rules**: Templates and manual certificates require **2 to 4** unique, **active** signatures (`sortOrder` unique, custom position labels, per-slot `showName` & `showDesignation` toggles).
- **Historical Snapshot Integrity**: Both `templateSnapshot` and `signatureSnapshots` are frozen in PostgreSQL on the issued `Certificate` row (data-only). Later editing, replacing, or deactivating a template or signature never alters previously issued certificates. If an active credential is revoked or reissued (`SUPERSEDED`), subsequent previews, dynamic PNG/PDF exports, and public verification immediately reflect the live status.

---

## 4. Eligibility & Generic Issuance

- **Courses (`COURSE`)**: Existing `certificatesService.checkEligibility` enforces `ACTIVE` enrolment, 100% curriculum completion, and passing grades on published course examinations. Automatic issuance on course completion respects `CertificateSettings.autoIssueOnCourseCompletion`.
- **Academy Quizzes (`ACADEMY_QUIZ`)**: Enforces released results and a finalized `EVALUATED` passing attempt (`POST /api/v1/student/academy-quizzes/:id/certificate`), with idempotency key `ACADEMY_QUIZ:{quizId}:{userId}`.
- **Manual & Generic Issuance (`POST /api/v1/admin/certificates/manual`, `/issue`)**:
  - **Option A — Existing Student**: Search by student name, email, or `studentCode` and bind `userId`, making the credential immediately visible in `/student/certificates`.
  - **Option B — Manual External Recipient**: Issue to an external recipient without requiring a platform account (`userId = null`) while retaining PDF download and public `/verify/:certificateNumber`.
- **Reissue & Revocation**: Active certificates can be superseded cleanly (`POST /api/v1/admin/certificates/:id/reissue` linking `reissuedFromId`) or revoked with a mandatory audit reason (`POST /api/v1/admin/certificates/:id/revoke`).

---

## 5. Certificate Identifier Format & Privacy

- Public identifier format: `ASRA-YYYY-XXXX-XXXX` (`ASRA-[0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}` checked in PostgreSQL using 30 unambiguous symbols drawn via `crypto.randomInt`).
- Public verification (`GET /api/v1/certificates/verify/:certificateNumber` & `/verify/:certificateNumber`) returns `valid`, `certificateNumber`, `status`, `sourceType`, `sourceLabel`, `certificateTitle`, `recipientName`, `courseTitle`, `description`, `achievementDetails`, `academyName`, `completedAt`, `issuedAt`, `revokedAt`, `revokedReason`, and public `signatories: { fullName, designation, department }[]`.
- Student emails, internal UUIDs, `studentCode` values, payment records, and numeric scores are never exposed on public verification pages, and pages emit `noindex` metadata free of recipient names.

---

## 6. Granular RBAC Permissions

Granted to `ADMIN` and `SUPER_ADMIN` only (never `FACULTY` or `STUDENT`):

- `certificates.view` — Read overview KPIs, templates, active/archived signatures, issued certificates, audit logs, settings, and download PDFs.
- `certificates.templates.manage` — Configure templates, colors/layout flags, and 2–4 template signatures.
- `certificates.signatures.manage` — Upload, replace, edit, activate, or deactivate digital signatures.
- `certificates.issue` — Issue generic/manual certificates and reissue existing certificates.
- `certificates.revoke` — Revoke issued certificates with mandatory audit reason.
- `certificates.manage` — Full administrative authority including global settings (`PATCH /api/v1/admin/certificates/settings`) plus all sub-capabilities above.

---

## 7. API Reference Summary

### Student & Public Routes

- `GET /api/v1/certificates/verify/:certificateNumber` (public, rate-limited, `Cache-Control: no-store`)
- `GET /api/v1/student/certificates` (supports `?sourceType=` & `?search=`)
- `GET /api/v1/student/certificates/:id`, `/download` (`?format=pdf|png`), `/download/pdf`, and `/download/png`
- `GET /api/v1/student/courses/:id/certificate/eligibility` & `POST /api/v1/student/courses/:id/certificate`
- `POST /api/v1/student/academy-quizzes/:id/certificate`

### Admin Routes (`/api/v1/admin/certificates/*`)

- `GET /overview`, `GET/PATCH /settings`, `GET /audit-logs`, `GET /students/search`, `GET /sources`
- `GET /templates`, `GET /templates/:id`, `PATCH /templates/:id`, `GET /templates/:id/preview` (`?format=pdf|png`), `GET /templates/:id/preview/png`
- `GET /signatures`, `GET /signatures/active`, `GET /signatures/:id`, `POST /signatures`, `PATCH /signatures/:id`
- `POST /manual`, `POST /issue`
- `GET /`, `GET /:id`, `GET /:id/download` (`?format=pdf|png`), `GET /:id/download/pdf`, `GET /:id/download/png`, `POST /:id/reissue`, `POST /:id/revoke`
