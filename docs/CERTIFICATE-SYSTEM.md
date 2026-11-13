# ASRA Academy — Certificate Management System (Phase 13 + Phase 17 Upgrade)

| Field   | Value                                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version | 2.0.0 (Phase 17 Generic Certificate Management Module)                                                                                                         |
| Status  | Complete Production Architecture — Backward-Compatible Upgrade                                                                                                 |
| Scope   | Centralized issuance engine, ASRA QUIZORA 2026 artwork template (+3 archived PDF templates), digital signature management, student gallery, verification, RBAC |

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

## 2. Certificate Templates

### 2.1 Active template — ASRA QUIZORA 2026 — Certificate of Participation (`QUIZORA_PARTICIPATION`)

The only template offered for new issuance (category `QUIZ_PARTICIPATION`, key `asra-quizora-2026-participation`, default). It is used for every certificate source (course, quiz participation and rank, exam, event, manual, …).

- **Artwork background**: the approved reference image (`apps/api/assets/certificates/quizora-2026/artwork.jpg`, 1536 × 1024) is embedded unmodified. Logo, central emblem, heading, borders, laurels, trophy, badge, building and the Event Coordinator / Director captions come from the artwork.
- **Dynamic content** (shared layout in `packages/validation/src/certificate-artwork.ts`): recipient name on the rule under "This is to certify that" (54 → 30 px, two balanced lines below that, ellipsis as last resort); the statement, rendered from the template body text with `{title}` (certificate subject — quiz/course/event name), `{date}` (completion date, e.g. "14th November 2026", Asia/Kolkata), `**bold**` and line breaks — the baked-in artwork statement is hidden by `statement-patch.png`; metadata (completion date, issued date, certificate ID, verification URL); the verification QR (bottom right, encodes `{NEXT_PUBLIC_APP_URL}/verify/{certificateNumber}`).
- **Mandatory signatures**: exactly 2 active signatures — position 1 Event Coordinator, position 2 Director. Enforced in the backend for template configuration, template/quiz sample previews, every issuance path (course, quiz claim, manual, generic, reissue, bulk quiz preview/issue/worker) and at render time; there is never a fallback or substitute signatory.
- **No scores**: scores, marks, percentages, accuracy and ranks are never rendered; `achievementDetails` is not stored and is hidden from DTOs and public verification for this template.
- **Output**: PDF 1152 × 768 pt (exact 3:2 page, original JPEG embedded, TeX Gyre Pagella embedded, vector QR); PNG 3072 × 2048 (2×, same font outlines). The admin live preview (`quizora-certificate-preview.tsx`) uses the same artwork, fonts and layout functions.

### 2.1b Active template — ASRA QUIZORA 2026 — Certificate of Participation (Design 2) (`QUIZORA_PARTICIPATION_DESIGN_2`)

Template 2 (key `asra-quizora-2026-participation-design-2`, category `QUIZ_PARTICIPATION`, not the default) is independently selectable everywhere Template 1 is (template admin, manual / generic issuance, quiz bulk issuance). It uses its own reference artwork (`apps/api/assets/certificates/quizora-2026-design-2/`) and its own layout definition (`QUIZORA_2026_DESIGN_2_DEFINITION`) on the same engine, rules and signature enforcement as Template 1:

- Recipient name in Parisienne script above the gold divider; statement in four centred lines (Pagella Bold Italic, title in red) from the template body (`{title}`, `{date}`, `**bold**`, line breaks).
- Bottom-centre per-certificate verification QR at the reference QR position (sample QR removed by the patch); metadata as two centred footer lines between the QR and the bottom wave.
- Exactly 2 signatures (Event Coordinator, Director) — the reference sample signatures are removed and replaced by the selected ones; no scores are ever rendered.

Both artwork templates share `packages/validation/src/certificate-artwork.ts` (`ARTWORK_TEMPLATE_DEFINITIONS`); each certificate renders with the definition of the style frozen in its template snapshot, so switching templates never carries artwork or positions across.

### 2.2 Archived templates (Phase 13 / 17)

Classic / Institutional, Modern / Minimal and Premium / Achievement are **archived** by `ensureCertificateDefaults` (`is_active = false`, `is_default = false`, `template.archived` audit entries) — never deleted. They cannot be re-activated or selected for new certificates, but every certificate issued with them keeps rendering (from its immutable snapshot) and verifying exactly as before; reissuing such a certificate uses the current default template.

The archived templates render server-side as printable **Landscape A4 (`841.89 × 595.28` pt)** PDFs via `pdfkit` (`apps/api/src/modules/certificates/pdf.service.ts`) with dynamic long-name sizing, vector QR codes (`qrcode`), academy branding, and 2–4 positioned digital signatures, paired with matching live React previews (`apps/web/src/components/certificates/certificate-preview.tsx`):

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
