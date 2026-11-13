'use client';

import {
  CERTIFICATE_SOURCE_TYPES,
  type CertificateDto,
  type CertificateSignatureDto,
  type CertificateSourceOptionDto,
  type CertificateSourceType,
  type CertificateStudentLookupDto,
  type CertificateTemplateDto,
} from '@asra/types';
import {
  CERTIFICATE_SIGNATURE_LIMITS,
  isArtworkCertificateStyle,
  artworkTemplateForStyle,
  SOURCE_TYPE_LABELS,
  type CertificateSignaturePlacementInput,
} from '@asra/validation';
import {
  Award,
  CheckCircle2,
  Download,
  ExternalLink,
  Eye,
  FileImage,
  Search,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import {
  CertificatePreview,
  type PreviewSignatureItem,
} from '@/components/certificates/certificate-preview';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { triggerBlobDownload } from '@/lib/certificates';
import { absoluteUrl } from '@/lib/seo';
import { ErrorPanel, LoadingPanel, SelectField } from '../admin-ui';
import { errorMessage, useAdminApi, useApiResource } from '../use-admin';
import { CertificatesHeader, signatureImageSrc } from './certificates-shell';
import { SignaturePicker } from './signature-picker';

function todayDayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function CertificatesGenerateAdmin() {
  const api = useAdminApi();
  const templatesRes = useApiResource<CertificateTemplateDto[]>(
    '/admin/certificates/templates',
    () => api.get<CertificateTemplateDto[]>('/admin/certificates/templates'),
  );
  const sigsRes = useApiResource<CertificateSignatureDto[]>(
    '/admin/certificates/signatures/active',
    () => api.get<CertificateSignatureDto[]>('/admin/certificates/signatures/active'),
  );
  const sourcesRes = useApiResource<{
    courses: CertificateSourceOptionDto[];
    academyQuizzes: CertificateSourceOptionDto[];
    examinations: CertificateSourceOptionDto[];
  }>('/admin/certificates/sources', () =>
    api.get<{
      courses: CertificateSourceOptionDto[];
      academyQuizzes: CertificateSourceOptionDto[];
      examinations: CertificateSourceOptionDto[];
    }>('/admin/certificates/sources'),
  );

  // Recipient selection mode
  const [recipientMode, setRecipientMode] = React.useState<'EXISTING_STUDENT' | 'MANUAL_RECIPIENT'>(
    'EXISTING_STUDENT',
  );
  const [studentQuery, setStudentQuery] = React.useState('');
  const [searchingStudents, setSearchingStudents] = React.useState(false);
  const [studentResults, setStudentResults] = React.useState<CertificateStudentLookupDto[]>([]);
  const [selectedStudent, setSelectedStudent] = React.useState<CertificateStudentLookupDto | null>(
    null,
  );

  const [recipientName, setRecipientName] = React.useState('');
  const [recipientEmail, setRecipientEmail] = React.useState('');
  const [recipientStudentCode, setRecipientStudentCode] = React.useState('');

  // Certificate content & source
  const [sourceType, setSourceType] = React.useState<CertificateSourceType>('MANUAL');
  const [sourceLabel, setSourceLabel] = React.useState('');
  const [linkedCourseId, setLinkedCourseId] = React.useState('');
  const [linkedQuizId, setLinkedQuizId] = React.useState('');
  const [linkedExamId, setLinkedExamId] = React.useState('');

  const [templateId, setTemplateId] = React.useState('');
  const [certificateTitleDraft, setCertificateTitleDraft] = React.useState<string | null>(null);
  const [subjectTitle, setSubjectTitle] = React.useState('');
  const [descriptionDraft, setDescriptionDraft] = React.useState<string | null>(null);
  const [achievementDetails, setAchievementDetails] = React.useState('');
  const [completedDate, setCompletedDate] = React.useState(todayDayString());
  const [issuedDate, setIssuedDate] = React.useState(todayDayString());
  const [signaturesDraft, setSignaturesDraft] = React.useState<
    CertificateSignaturePlacementInput[] | null
  >(null);

  const [generating, setGenerating] = React.useState(false);
  const [generatedCert, setGeneratedCert] = React.useState<CertificateDto | null>(null);
  const [downloadingFormat, setDownloadingFormat] = React.useState<'pdf' | 'png' | null>(null);

  const activeTemplates = React.useMemo(
    () => (templatesRes.data ?? []).filter((t) => t.isActive),
    [templatesRes.data],
  );
  const activeSignatures = sigsRes.data ?? [];

  const signaturesFromTemplate = React.useCallback((tpl: CertificateTemplateDto | null) => {
    if (!tpl) return [];
    const activeConfigured = tpl.signatures
      .filter((s) => s.signature.isActive)
      .map((link, idx) => ({
        signatureId: link.signatureId,
        sortOrder: idx,
        positionLabel: link.positionLabel,
        showName: link.showName,
        showDesignation: link.showDesignation,
      }));
    return activeConfigured.length >= 2 ? activeConfigured : [];
  }, []);

  const defaultTemplate = activeTemplates.find((t) => t.isDefault) ?? activeTemplates[0] ?? null;
  const selectedTemplate = activeTemplates.find((t) => t.id === templateId) ?? defaultTemplate;
  // Artwork template (ASRA QUIZORA 2026): fixed heading, statement from the template body,
  // never any score / achievement text, exactly the Event Coordinator + Director signatures.
  const isArtwork = selectedTemplate ? isArtworkCertificateStyle(selectedTemplate.style) : false;
  const slotLabels = isArtwork
    ? artworkTemplateForStyle(selectedTemplate?.style)?.layout.signatureSlots.map(
        (slot) => slot.label,
      )
    : undefined;
  const requiredCount = selectedTemplate?.requiredSignatureCount ?? null;
  const certificateTitle =
    certificateTitleDraft ?? selectedTemplate?.defaultTitle ?? 'CERTIFICATE OF ACHIEVEMENT';
  const description =
    descriptionDraft ??
    selectedTemplate?.defaultBodyText ??
    'has successfully demonstrated dedication, merit, and completion of';
  const signatures = signaturesDraft ?? signaturesFromTemplate(selectedTemplate);

  const applyTemplateDefaults = React.useCallback(
    (tpl: CertificateTemplateDto) => {
      setTemplateId(tpl.id);
      setCertificateTitleDraft(tpl.defaultTitle);
      setDescriptionDraft(tpl.defaultBodyText);
      const activeConfigured = signaturesFromTemplate(tpl);
      if (activeConfigured.length >= 2) {
        setSignaturesDraft(activeConfigured);
      }
    },
    [signaturesFromTemplate],
  );

  const handleStudentSearch = async () => {
    const q = studentQuery.trim();
    if (!q) return;
    setSearchingStudents(true);
    try {
      const results = await api.get<CertificateStudentLookupDto[]>(
        `/admin/certificates/students/search?q=${encodeURIComponent(q)}`,
      );
      setStudentResults(results);
      if (results.length === 0) {
        toast.info('No matching students', {
          description:
            'Try searching by another name, email, or student ID, or switch to Manual Recipient.',
        });
      }
    } catch (err) {
      toast.error('Student search failed', { description: errorMessage(err) });
    } finally {
      setSearchingStudents(false);
    }
  };

  const pickStudent = (student: CertificateStudentLookupDto) => {
    setSelectedStudent(student);
    setRecipientName(student.fullName);
    setRecipientEmail(student.email);
    setRecipientStudentCode(student.studentCode ?? '');
  };

  const sigById = new Map(activeSignatures.map((s) => [s.id, s]));
  const previewSignatures: PreviewSignatureItem[] = signatures.map((placement) => {
    const sig = sigById.get(placement.signatureId);
    return {
      key: placement.signatureId,
      fullName: sig?.fullName ?? 'Signatory',
      designation: sig?.designation ?? 'Title',
      department: sig?.department,
      positionLabel: placement.positionLabel,
      showName: placement.showName,
      showDesignation: placement.showDesignation,
      imageSrc: sig ? signatureImageSrc(sig) : null,
    };
  });

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (recipientMode === 'EXISTING_STUDENT' && !selectedStudent) {
      toast.error('Select a student', { description: 'Search and pick a student account first.' });
      return;
    }
    if (requiredCount !== null && signatures.length !== requiredCount) {
      toast.error('Signatures required', {
        description: `This template requires exactly ${requiredCount} signatures (${slotLabels?.join(' and ')}). No certificate can be issued without them.`,
      });
      return;
    }
    if (
      signatures.length < CERTIFICATE_SIGNATURE_LIMITS.minSignatures ||
      signatures.length > CERTIFICATE_SIGNATURE_LIMITS.maxSignatures
    ) {
      toast.error('Signatures required', {
        description: 'Configure between 2 and 4 active digital signatures before generating.',
      });
      return;
    }
    if (!selectedTemplate) {
      toast.error('Template required', { description: 'Select an active certificate template.' });
      return;
    }

    setGenerating(true);
    try {
      const created = await api.post<CertificateDto>('/admin/certificates/manual', {
        recipientMode,
        userId: recipientMode === 'EXISTING_STUDENT' ? selectedStudent!.userId : undefined,
        recipientName: recipientName.trim(),
        recipientEmail: recipientEmail.trim() || null,
        recipientStudentCode: recipientStudentCode.trim() || null,
        sourceType,
        sourceLabel: sourceLabel.trim() || null,
        courseId: sourceType === 'COURSE' && linkedCourseId ? linkedCourseId : null,
        academyQuizId: sourceType === 'ACADEMY_QUIZ' && linkedQuizId ? linkedQuizId : null,
        examinationId: sourceType === 'EXAM' && linkedExamId ? linkedExamId : null,
        templateId: selectedTemplate.id,
        certificateTitle: isArtwork ? selectedTemplate.defaultTitle : certificateTitle.trim(),
        subjectTitle: subjectTitle.trim(),
        description: isArtwork ? null : description.trim() || null,
        achievementDetails: isArtwork ? null : achievementDetails.trim() || null,
        completedAt: `${completedDate}T00:00:00.000Z`,
        issuedAt: `${issuedDate}T00:00:00.000Z`,
        signatures,
      });

      setGeneratedCert(created);
      toast.success('Certificate issued', {
        description: `Credential ${created.certificateNumber} recorded in PostgreSQL; previews, PNGs, and PDFs generate on demand.`,
      });
    } catch (err) {
      toast.error('Generation failed', { description: errorMessage(err) });
    } finally {
      setGenerating(false);
    }
  };

  const handleDownloadGenerated = async (format: 'pdf' | 'png') => {
    if (!generatedCert) return;
    setDownloadingFormat(format);
    try {
      const blob = await api.download(`/admin/certificates/${generatedCert.id}/download/${format}`);
      triggerBlobDownload(blob, `ASRA-Certificate-${generatedCert.certificateNumber}.${format}`);
    } catch (err) {
      toast.error(`${format.toUpperCase()} download failed`, { description: errorMessage(err) });
    } finally {
      setDownloadingFormat(null);
    }
  };

  const resetForm = () => {
    setGeneratedCert(null);
    setSelectedStudent(null);
    setRecipientName('');
    setRecipientEmail('');
    setRecipientStudentCode('');
    setSubjectTitle('');
    setAchievementDetails('');
  };

  return (
    <>
      <CertificatesHeader
        title="Manual Certificate Generation"
        description="Issue an individual verified certificate to an existing student or an external recipient using any template and 2–4 signatures."
      />

      {templatesRes.loading && !templatesRes.data ? (
        <LoadingPanel label="Loading certificate builder…" rows={5} />
      ) : templatesRes.error ? (
        <ErrorPanel
          title="Could not load certificate builder"
          message={errorMessage(templatesRes.error)}
          onRetry={templatesRes.reload}
        />
      ) : generatedCert ? (
        <Card className="border-2 border-emerald-500/40 shadow-card">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className="size-6 text-emerald-700" />
                <div>
                  <CardTitle>Certificate Generated Successfully</CardTitle>
                  <p className="type-caption text-muted-foreground">
                    ID:{' '}
                    <span className="font-mono font-semibold">
                      {generatedCert.certificateNumber}
                    </span>
                    {generatedCert.userId
                      ? ' · Added to the student’s account automatically'
                      : ' · Issued for external recipient'}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => void handleDownloadGenerated('png')}
                  disabled={downloadingFormat !== null}
                  loading={downloadingFormat === 'png'}
                >
                  <FileImage className="size-4" /> Download PNG
                </Button>
                <Button
                  onClick={() => void handleDownloadGenerated('pdf')}
                  disabled={downloadingFormat !== null}
                  loading={downloadingFormat === 'pdf'}
                >
                  <Download className="size-4" /> Download PDF
                </Button>
                <Button variant="outline" asChild>
                  <Link href={`/verify/${generatedCert.certificateNumber}`} target="_blank">
                    <ExternalLink className="size-4" /> Public Verify
                  </Link>
                </Button>
                <Button variant="ghost" onClick={resetForm}>
                  Generate Another
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {selectedTemplate && (
              <CertificatePreview
                style={selectedTemplate.style}
                config={selectedTemplate.config}
                issuingAuthority={selectedTemplate.issuingAuthority}
                subtitle={selectedTemplate.defaultSubtitle}
                certificateTitle={generatedCert.certificateTitle}
                recipientName={generatedCert.recipientName}
                bodyText={generatedCert.description ?? description}
                subjectTitle={generatedCert.courseTitle}
                achievementDetails={generatedCert.achievementDetails}
                sourceLabel={generatedCert.sourceLabel}
                completedAt={generatedCert.completedAt}
                issuedAt={generatedCert.issuedAt}
                certificateNumber={generatedCert.certificateNumber}
                verificationUrl={generatedCert.verificationUrl}
                signatures={previewSignatures}
              />
            )}
          </CardContent>
        </Card>
      ) : (
        <form onSubmit={handleGenerate} className="grid gap-6 xl:grid-cols-[1.05fr_1fr]">
          {/* Form Column */}
          <div className="grid gap-5">
            {/* Step 1: Recipient */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">1. Recipient Details</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <Tabs
                  value={recipientMode}
                  onValueChange={(v) => {
                    setRecipientMode(v as 'EXISTING_STUDENT' | 'MANUAL_RECIPIENT');
                    if (v === 'MANUAL_RECIPIENT') setSelectedStudent(null);
                  }}
                >
                  <TabsList>
                    <TabsTrigger value="EXISTING_STUDENT">
                      <UserCheck className="size-4" /> Fetch Existing Student
                    </TabsTrigger>
                    <TabsTrigger value="MANUAL_RECIPIENT">
                      <UserPlus className="size-4" /> Manual Recipient Details
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="EXISTING_STUDENT" className="grid gap-3 pt-2">
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <Field id="stu-search" label="Search Student (Name, Email, or Student ID)">
                          <Input
                            value={studentQuery}
                            onChange={(e) => setStudentQuery(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void handleStudentSearch();
                              }
                            }}
                            placeholder="Search student…"
                          />
                        </Field>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        loading={searchingStudents}
                        onClick={() => void handleStudentSearch()}
                      >
                        <Search className="size-4" /> Find
                      </Button>
                    </div>

                    {studentResults.length > 0 && (
                      <div className="grid max-h-48 gap-1.5 overflow-y-auto rounded-xl border p-2">
                        {studentResults.map((stu) => {
                          const chosen = selectedStudent?.userId === stu.userId;
                          return (
                            <button
                              key={stu.userId}
                              type="button"
                              onClick={() => pickStudent(stu)}
                              className={`flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                                chosen ? 'bg-secondary font-medium text-heading' : 'hover:bg-muted'
                              }`}
                            >
                              <div>
                                <div className="text-heading">{stu.fullName}</div>
                                <div className="type-caption text-muted-foreground">
                                  {stu.email}
                                  {stu.studentCode ? ` · ID: ${stu.studentCode}` : ''}
                                  {stu.className ? ` · ${stu.className}` : ''}
                                </div>
                              </div>
                              {chosen && <Badge variant="success">Selected</Badge>}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {selectedStudent && (
                      <Alert tone="success" title={`Selected: ${selectedStudent.fullName}`}>
                        <p className="text-xs">
                          Certificate will be linked directly to this student account (
                          {selectedStudent.email}).
                        </p>
                      </Alert>
                    )}
                  </TabsContent>

                  <TabsContent value="MANUAL_RECIPIENT" className="pt-2">
                    <p className="type-caption text-muted-foreground">
                      Enter recipient details manually when issuing a certificate for someone
                      without a registered student account.
                    </p>
                  </TabsContent>
                </Tabs>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="rec-name" label="Recipient Full Name">
                    <Input
                      value={recipientName}
                      onChange={(e) => setRecipientName(e.target.value)}
                      placeholder="Full name as printed on certificate"
                      required
                    />
                  </Field>
                  <Field id="rec-email" label="Recipient Email" optional>
                    <Input
                      type="email"
                      value={recipientEmail}
                      onChange={(e) => setRecipientEmail(e.target.value)}
                      placeholder="name@example.com"
                    />
                  </Field>
                </div>
                <Field id="rec-code" label="Student / Registration ID" optional>
                  <Input
                    value={recipientStudentCode}
                    onChange={(e) => setRecipientStudentCode(e.target.value)}
                    placeholder="Optional internal registration code"
                  />
                </Field>
              </CardContent>
            </Card>

            {/* Step 2: Source & Content */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">2. Certificate Source & Content</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <SelectField
                    id="gen-source-type"
                    label="Issuance Source"
                    value={sourceType}
                    onValueChange={(v) => setSourceType(v as CertificateSourceType)}
                    options={CERTIFICATE_SOURCE_TYPES.map((s) => ({
                      value: s,
                      label: SOURCE_TYPE_LABELS[s],
                    }))}
                  />
                  <Field id="gen-source-label" label="Custom Source Label" optional>
                    <Input
                      value={sourceLabel}
                      onChange={(e) => setSourceLabel(e.target.value)}
                      placeholder={SOURCE_TYPE_LABELS[sourceType]}
                    />
                  </Field>
                </div>

                {sourceType === 'COURSE' && sourcesRes.data?.courses.length ? (
                  <SelectField
                    id="gen-course-link"
                    label="Link Existing Course (optional)"
                    value={linkedCourseId || 'NONE'}
                    onValueChange={(v) => {
                      const next = v === 'NONE' ? '' : v;
                      setLinkedCourseId(next);
                      const matched = sourcesRes.data?.courses.find((c) => c.id === next);
                      if (matched && !subjectTitle) setSubjectTitle(matched.title);
                    }}
                    options={[
                      { value: 'NONE', label: 'No specific course record' },
                      ...sourcesRes.data.courses.map((c) => ({ value: c.id, label: c.title })),
                    ]}
                  />
                ) : null}

                {sourceType === 'ACADEMY_QUIZ' && sourcesRes.data?.academyQuizzes.length ? (
                  <SelectField
                    id="gen-quiz-link"
                    label="Link Existing Academy Quiz (optional)"
                    value={linkedQuizId || 'NONE'}
                    onValueChange={(v) => {
                      const next = v === 'NONE' ? '' : v;
                      setLinkedQuizId(next);
                      const matched = sourcesRes.data?.academyQuizzes.find((q) => q.id === next);
                      if (matched && !subjectTitle) setSubjectTitle(matched.title);
                    }}
                    options={[
                      { value: 'NONE', label: 'No specific quiz record' },
                      ...sourcesRes.data.academyQuizzes.map((q) => ({
                        value: q.id,
                        label: q.title,
                      })),
                    ]}
                  />
                ) : null}

                {sourceType === 'EXAM' && sourcesRes.data?.examinations.length ? (
                  <SelectField
                    id="gen-exam-link"
                    label="Link Existing Examination (optional)"
                    value={linkedExamId || 'NONE'}
                    onValueChange={(v) => {
                      const next = v === 'NONE' ? '' : v;
                      setLinkedExamId(next);
                      const matched = sourcesRes.data?.examinations.find((x) => x.id === next);
                      if (matched && !subjectTitle) setSubjectTitle(matched.title);
                    }}
                    options={[
                      { value: 'NONE', label: 'No specific exam record' },
                      ...sourcesRes.data.examinations.map((x) => ({
                        value: x.id,
                        label: `${x.title} (${x.subtitle ?? ''})`,
                      })),
                    ]}
                  />
                ) : null}

                <SelectField
                  id="gen-template"
                  label="Certificate Template"
                  value={selectedTemplate?.id ?? templateId}
                  onValueChange={(id) => {
                    const found = activeTemplates.find((t) => t.id === id);
                    if (found) applyTemplateDefaults(found);
                  }}
                  options={activeTemplates.map((t) => ({ value: t.id, label: t.name }))}
                />

                <Field
                  id="gen-cert-title"
                  label="Certificate Heading Title"
                  hint={isArtwork ? 'Fixed by the approved certificate artwork.' : undefined}
                >
                  <Input
                    value={isArtwork ? (selectedTemplate?.defaultTitle ?? '') : certificateTitle}
                    onChange={(e) => setCertificateTitleDraft(e.target.value)}
                    disabled={isArtwork}
                    required
                  />
                </Field>

                <Field
                  id="gen-subject"
                  label={
                    isArtwork
                      ? 'Certificate Title (replaces {title} in the statement)'
                      : 'Course / Competition / Event / Achievement Name'
                  }
                >
                  <Input
                    value={subjectTitle}
                    onChange={(e) => setSubjectTitle(e.target.value)}
                    placeholder="e.g. Annual Coding Hackathon 2026"
                    required
                  />
                </Field>

                {isArtwork ? (
                  <Field
                    id="gen-description"
                    label="Certificate Statement"
                    hint="Set on the template (Certificates → Templates). Scores, marks, percentages and ranks are never shown on this certificate."
                  >
                    <Textarea rows={3} value={selectedTemplate?.defaultBodyText ?? ''} disabled />
                  </Field>
                ) : (
                  <>
                    <Field id="gen-description" label="Completion / Recognition Text">
                      <Textarea
                        rows={2}
                        value={description}
                        onChange={(e) => setDescriptionDraft(e.target.value)}
                      />
                    </Field>

                    <Field id="gen-achievement" label="Achievement / Rank / Distinction" optional>
                      <Input
                        value={achievementDetails}
                        onChange={(e) => setAchievementDetails(e.target.value)}
                        placeholder="e.g. 1st Place · Score 98% · Special Distinction"
                      />
                    </Field>
                  </>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="gen-comp-date" label="Achievement / Completion Date">
                    <Input
                      type="date"
                      value={completedDate}
                      onChange={(e) => setCompletedDate(e.target.value)}
                      required
                    />
                  </Field>
                  <Field id="gen-issue-date" label="Issue Date">
                    <Input
                      type="date"
                      value={issuedDate}
                      onChange={(e) => setIssuedDate(e.target.value)}
                      required
                    />
                  </Field>
                </div>
              </CardContent>
            </Card>

            {/* Step 3: Signatures */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {slotLabels
                    ? `3. Signatories (${slotLabels.join(' & ')} Required)`
                    : '3. Signatories (2 to 4 Required)'}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <SignaturePicker
                  availableSignatures={activeSignatures}
                  value={signatures}
                  onChange={setSignaturesDraft}
                  slotLabels={slotLabels}
                />
              </CardContent>
            </Card>
          </div>

          {/* Live Preview & Confirm Column */}
          <div className="grid content-start gap-4 xl:sticky xl:top-20">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Eye className="size-4 text-primary" /> Live Certificate Preview
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                {selectedTemplate && (
                  <CertificatePreview
                    style={selectedTemplate.style}
                    config={selectedTemplate.config}
                    issuingAuthority={selectedTemplate.issuingAuthority}
                    subtitle={selectedTemplate.defaultSubtitle}
                    certificateTitle={certificateTitle}
                    recipientName={recipientName}
                    bodyText={description}
                    subjectTitle={subjectTitle}
                    achievementDetails={isArtwork ? null : achievementDetails || null}
                    sourceLabel={sourceLabel.trim() || SOURCE_TYPE_LABELS[sourceType]}
                    completedAt={`${completedDate}T00:00:00.000Z`}
                    issuedAt={`${issuedDate}T00:00:00.000Z`}
                    certificateNumber="ASRA-2026-XXXX-XXXX"
                    verificationUrl={absoluteUrl('/verify/ASRA-2026-XXXX-XXXX')}
                    signatures={previewSignatures}
                  />
                )}
                {isArtwork && (
                  <p className="type-caption text-muted-foreground">
                    Preview uses a placeholder certificate ID; the real ID, verification URL and QR
                    code are generated when the certificate is issued.
                  </p>
                )}

                <Button
                  type="submit"
                  size="lg"
                  loading={generating}
                  loadingText="Generating & storing PDF…"
                  disabled={
                    !selectedTemplate ||
                    (requiredCount !== null
                      ? signatures.length !== requiredCount
                      : signatures.length < 2)
                  }
                >
                  <Award className="size-4" aria-hidden /> Confirm & Generate Certificate
                </Button>
              </CardContent>
            </Card>
          </div>
        </form>
      )}
    </>
  );
}
