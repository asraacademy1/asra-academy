'use client';

import type {
  AdminJobApplicationDetailDto,
  InterviewStatus,
  JobApplicationStatus,
} from '@asra/types';
import {
  ArrowLeft,
  Calendar,
  CheckCircle2,
  Clock,
  FileCheck,
  Mail,
  MapPin,
  MessageSquare,
  PauseCircle,
  Phone,
  Send,
  User,
  Video,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { triggerBlobDownload } from '@/lib/certificates';
import { Section } from '../admin-kit';
import { ErrorPanel, LoadingPanel } from '../admin-ui';
import { errorMessage, useAdminApi, useApiResource } from '../use-admin';
import { StatusBadge } from './recruitment-overview';
import { ApplicantResumeCard, ensurePdfBlob, ResumePreviewDialog } from './resume-actions';

export function ApplicationDetail({ id }: { id: string }) {
  const api = useAdminApi();

  const {
    data: app,
    loading,
    error,
    reload,
  } = useApiResource<AdminJobApplicationDetailDto>(`/admin/recruitment/applications/${id}`, () =>
    api.get<AdminJobApplicationDetailDto>(`/admin/recruitment/applications/${id}`),
  );

  // Status Change Dialog State
  const [statusDialog, setStatusDialog] = React.useState<{
    targetStatus: JobApplicationStatus;
    title: string;
    description: string;
  } | null>(null);
  const [statusReason, setStatusReason] = React.useState('');
  const [statusCustomMessage, setStatusCustomMessage] = React.useState('');
  const [statusFollowUpDate, setStatusFollowUpDate] = React.useState('');
  const [statusSendEmail, setStatusSendEmail] = React.useState(true);
  const [isUpdatingStatus, setIsUpdatingStatus] = React.useState(false);

  // Interview Dialog State
  const [isScheduleOpen, setIsScheduleOpen] = React.useState(false);
  const [interviewDate, setInterviewDate] = React.useState('');
  const [interviewTime, setInterviewTime] = React.useState('11:00');
  const [interviewDuration, setInterviewDuration] = React.useState('45');
  const [interviewType, setInterviewType] = React.useState('Technical Interview');
  const [interviewMeetUrl, setInterviewMeetUrl] = React.useState('https://meet.google.com/');
  const [interviewInstructions, setInterviewInstructions] = React.useState('');
  const [interviewMessage, setInterviewMessage] = React.useState('');
  const [isScheduling, setIsScheduling] = React.useState(false);

  // Internal Note State
  const [newNote, setNewNote] = React.useState('');
  const [isSavingNote, setIsSavingNote] = React.useState(false);

  // Custom Email Composer State
  const [isEmailComposerOpen, setIsEmailComposerOpen] = React.useState(false);
  const emailTemplate = 'custom' as const;
  const [emailSubject, setEmailSubject] = React.useState('');
  const [emailMessage, setEmailMessage] = React.useState('');
  const [isSendingEmail, setIsSendingEmail] = React.useState(false);

  // Independent Resume Preview & Download Handlers
  const [isDownloadingResume, setIsDownloadingResume] = React.useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = React.useState(false);
  const [isLoadingPreview, setIsLoadingPreview] = React.useState(false);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const previewUrlRef = React.useRef<string | null>(null);
  const previewRequestSeqRef = React.useRef(0);

  const revokePreviewUrl = React.useCallback(() => {
    if (previewUrlRef.current) {
      window.URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewUrl(null);
  }, []);

  React.useEffect(() => {
    return () => {
      previewRequestSeqRef.current += 1;
      if (previewUrlRef.current) {
        window.URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    };
  }, []);

  const loadResumePreview = React.useCallback(async () => {
    if (!app) return;
    const requestSeq = ++previewRequestSeqRef.current;
    revokePreviewUrl();
    setPreviewError(null);
    setIsLoadingPreview(true);
    try {
      const rawBlob = await api.download(
        `/admin/recruitment/applications/${app.id}/resume?disposition=inline`,
      );
      if (previewRequestSeqRef.current !== requestSeq) return;
      const pdfBlob = ensurePdfBlob(rawBlob);
      const objectUrl = window.URL.createObjectURL(pdfBlob);
      previewUrlRef.current = objectUrl;
      setPreviewUrl(objectUrl);
    } catch (err) {
      if (previewRequestSeqRef.current !== requestSeq) return;
      setPreviewError(errorMessage(err));
    } finally {
      if (previewRequestSeqRef.current === requestSeq) {
        setIsLoadingPreview(false);
      }
    }
  }, [api, app, revokePreviewUrl]);

  const handleOpenPreview = () => {
    if (!app) return;
    setIsPreviewOpen(true);
    void loadResumePreview();
  };

  const handlePreviewOpenChange = (open: boolean) => {
    setIsPreviewOpen(open);
    if (!open) {
      previewRequestSeqRef.current += 1;
      revokePreviewUrl();
      setPreviewError(null);
      setIsLoadingPreview(false);
    }
  };

  const handleDownloadResume = async () => {
    if (!app) return;
    setIsDownloadingResume(true);
    try {
      const rawBlob = await api.download(
        `/admin/recruitment/applications/${app.id}/resume?disposition=attachment`,
      );
      const pdfBlob = ensurePdfBlob(rawBlob);
      triggerBlobDownload(pdfBlob, app.resumeOriginalName || 'resume.pdf');
    } catch (err) {
      toast.error('Download Failed', {
        description: errorMessage(err),
      });
    } finally {
      setIsDownloadingResume(false);
    }
  };

  const handleStatusSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!statusDialog) return;
    setIsUpdatingStatus(true);
    try {
      await api.post(`/admin/recruitment/applications/${id}/status`, {
        status: statusDialog.targetStatus,
        reason: statusReason.trim() || undefined,
        customMessage: statusCustomMessage.trim() || undefined,
        followUpDate: statusFollowUpDate ? new Date(statusFollowUpDate).toISOString() : undefined,
        sendEmail: statusSendEmail,
      });

      toast.success('Status Updated', {
        description: `Application moved to ${statusDialog.targetStatus.replace(/_/g, ' ')}.`,
      });

      setStatusDialog(null);
      setStatusReason('');
      setStatusCustomMessage('');
      setStatusFollowUpDate('');
      reload();
    } catch (err) {
      toast.error('Update Failed', {
        description: errorMessage(err),
      });
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const handleScheduleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsScheduling(true);
    try {
      const scheduledAt = new Date(`${interviewDate}T${interviewTime}:00`).toISOString();
      await api.post(`/admin/recruitment/applications/${id}/interviews`, {
        scheduledAt,
        durationMinutes: parseInt(interviewDuration, 10),
        interviewType: interviewType.trim(),
        meetingUrl: interviewMeetUrl.trim(),
        instructions: interviewInstructions.trim() || undefined,
        customMessage: interviewMessage.trim() || undefined,
        sendEmail: true,
      });

      toast.success('Interview Scheduled', {
        description: `Interview invitation sent with Google Meet link.`,
      });

      setIsScheduleOpen(false);
      reload();
    } catch (err) {
      toast.error('Scheduling Failed', {
        description: errorMessage(err),
      });
    } finally {
      setIsScheduling(false);
    }
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNote.trim()) return;
    setIsSavingNote(true);
    try {
      await api.post(`/admin/recruitment/applications/${id}/notes`, {
        note: newNote.trim(),
      });
      toast.success('Note Added', { description: 'Internal note saved successfully.' });
      setNewNote('');
      reload();
    } catch (err) {
      toast.error('Could Not Save Note', {
        description: errorMessage(err),
      });
    } finally {
      setIsSavingNote(false);
    }
  };

  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailSubject.trim() || !emailMessage.trim()) return;
    setIsSendingEmail(true);
    try {
      await api.post(`/admin/recruitment/applications/${id}/email`, {
        template: emailTemplate,
        subject: emailSubject.trim(),
        adminMessage: emailMessage.trim(),
      });
      toast.success('Email Dispatched', { description: 'Message sent to candidate.' });
      setIsEmailComposerOpen(false);
      setEmailSubject('');
      setEmailMessage('');
      reload();
    } catch (err) {
      toast.error('Email Failed', {
        description: errorMessage(err),
      });
    } finally {
      setIsSendingEmail(false);
    }
  };

  if (loading) return <LoadingPanel label="Loading application details…" />;
  if (error || !app) {
    return (
      <ErrorPanel
        title="Could not load application"
        message={error?.message || 'Failed to load application details.'}
        onRetry={reload}
      />
    );
  }

  return (
    <div className="grid gap-6">
      {/* Top Bar */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon">
            <Link href="/admin/recruitment/applications">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="type-h2 text-heading">{app.fullName}</h1>
              <StatusBadge status={app.status} />
            </div>
            <p className="font-mono type-caption text-muted-foreground">
              Ref: {app.referenceId} · Applied for {app.jobTitle} ({app.jobPublicId})
            </p>
          </div>
        </div>

        {/* Status Workflow Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {app.status === 'RECEIVED' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setStatusDialog({
                  targetStatus: 'UNDER_REVIEW',
                  title: 'Move to Under Review',
                  description:
                    'Mark this application as actively being reviewed by the screening team.',
                })
              }
            >
              <Clock className="mr-1.5 size-4" /> Mark Under Review
            </Button>
          )}

          {app.status !== 'SHORTLISTED' && app.status !== 'ACCEPTED' && (
            <Button
              variant="outline"
              size="sm"
              className="text-amber-700 hover:text-amber-800"
              onClick={() =>
                setStatusDialog({
                  targetStatus: 'SHORTLISTED',
                  title: 'Shortlist Candidate',
                  description:
                    'Shortlist this applicant for interview rounds. An email notification will be generated.',
                })
              }
            >
              <FileCheck className="mr-1.5 size-4" /> Shortlist
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setIsScheduleOpen(true);
              setInterviewMessage(
                `Dear ${app.fullName},\n\nWe are pleased to invite you for an interview regarding the ${app.jobTitle} position at ASRA Academy.`,
              );
            }}
          >
            <Video className="mr-1.5 size-4 text-purple-600" /> Schedule Interview
          </Button>

          {app.status !== 'ON_HOLD' && app.status !== 'ACCEPTED' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setStatusDialog({
                  targetStatus: 'ON_HOLD',
                  title: 'Put Application On Hold',
                  description:
                    'Hold this application pending departmental capacity or additional candidate pipeline comparison.',
                })
              }
            >
              <PauseCircle className="mr-1.5 size-4" /> On Hold
            </Button>
          )}

          {app.status !== 'ACCEPTED' && (
            <Button
              variant="outline"
              size="sm"
              className="border-emerald-300 text-emerald-700 hover:text-emerald-800"
              onClick={() =>
                setStatusDialog({
                  targetStatus: 'ACCEPTED',
                  title: 'Accept / Select Candidate',
                  description:
                    'Confirm final acceptance/selection of this candidate. An official acceptance email will be sent.',
                })
              }
            >
              <CheckCircle2 className="mr-1.5 size-4" /> Accept
            </Button>
          )}

          {app.status !== 'REJECTED' && (
            <Button
              variant="outline"
              size="sm"
              className="border-destructive/30 text-destructive hover:text-destructive"
              onClick={() =>
                setStatusDialog({
                  targetStatus: 'REJECTED',
                  title: 'Reject Application',
                  description:
                    'Mark this application as rejected. A polite, respectful rejection email will be dispatched.',
                })
              }
            >
              <XCircle className="mr-1.5 size-4" /> Reject
            </Button>
          )}

          <Button
            variant="default"
            size="sm"
            onClick={() => {
              setEmailSubject(`Update on your application for ${app.jobTitle} — ASRA Academy`);
              setEmailMessage(`Dear ${app.fullName},\n\n`);
              setIsEmailComposerOpen(true);
            }}
          >
            <Mail className="mr-1.5 size-4" /> Send Email
          </Button>
        </div>
      </div>

      {/* Main Grid: Candidate Profile & Resume */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left Column: Candidate Info & Resume (1 col) */}
        <div className="grid content-start gap-6">
          {/* Candidate Card */}
          <Card className="grid gap-4 p-5">
            <h2 className="type-h4 text-heading">Candidate Contact</h2>
            <div className="grid gap-3">
              <div className="flex items-center gap-3">
                <User className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium text-heading">{app.fullName}</span>
              </div>
              <div className="flex items-center gap-3">
                <Mail className="size-4 shrink-0 text-muted-foreground" />
                <a href={`mailto:${app.email}`} className="truncate text-primary hover:underline">
                  {app.email}
                </a>
              </div>
              <div className="flex items-center gap-3">
                <Phone className="size-4 shrink-0 text-muted-foreground" />
                <a href={`tel:${app.phone}`} className="font-mono text-heading">
                  +91 {app.phone}
                </a>
              </div>
              <div className="flex items-center gap-3">
                <MapPin className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-heading">{app.currentLocation}</span>
              </div>
              <div className="flex items-center gap-3">
                <Calendar className="size-4 shrink-0 text-muted-foreground" />
                <span className="type-caption text-muted-foreground">
                  Applied on{' '}
                  {new Date(app.createdAt).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </span>
              </div>
            </div>
          </Card>

          {/* Resume Card */}
          <ApplicantResumeCard
            resumeOriginalName={app.resumeOriginalName}
            resumeFileSize={app.resumeFileSize}
            isPreviewLoading={isLoadingPreview}
            isDownloading={isDownloadingResume}
            onPreview={handleOpenPreview}
            onDownload={handleDownloadResume}
          />

          {/* Applied Role Summary */}
          <Card className="grid gap-3 p-5">
            <h2 className="type-h4 text-heading">Position Details</h2>
            <div className="grid gap-2">
              <div className="type-caption text-muted-foreground">Title</div>
              <div className="font-medium text-heading">
                <Link
                  href={`/admin/recruitment/jobs/${app.jobId}/edit`}
                  className="text-primary hover:underline"
                >
                  {app.jobTitle}
                </Link>
              </div>
              <div className="type-caption text-muted-foreground">Department / Category</div>
              <div className="font-medium text-heading">
                {app.department} · {app.category}
              </div>
              <div className="type-caption text-muted-foreground">Job Public Code</div>
              <div className="font-mono text-heading">{app.jobPublicId}</div>
            </div>
          </Card>
        </div>

        {/* Right Column: Answers, Interviews, Notes, Communications (2 cols) */}
        <div className="grid content-start gap-6 lg:col-span-2">
          {/* Dynamic Questions & Answers */}
          <Section
            title="Screening Questions & Answers"
            description="Submitted answers with snapshot question labels preserved from submission time."
          >
            {app.answers.length === 0 ? (
              <p className="type-caption text-muted-foreground">
                No custom job questions were configured for this posting. Standard resume submission
                only.
              </p>
            ) : (
              <div className="grid gap-4">
                {app.answers.map((ans, idx) => (
                  <div key={ans.id} className="rounded-lg border bg-card p-4">
                    <div className="flex items-start justify-between gap-2">
                      <span className="type-caption text-muted-foreground">
                        Question #{idx + 1} ({ans.fieldType.replace(/_/g, ' ')})
                      </span>
                    </div>
                    <div className="mt-1 font-medium text-heading">{ans.questionLabel}</div>
                    <div className="mt-2 rounded-md bg-muted/30 p-2.5 text-sm whitespace-pre-wrap text-foreground">
                      {ans.answerJson ? (
                        Array.isArray(ans.answerJson) ? (
                          <div className="flex flex-wrap gap-1.5">
                            {(ans.answerJson as string[]).map((val, i) => (
                              <Badge key={i} variant="secondary">
                                {val}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          JSON.stringify(ans.answerJson)
                        )
                      ) : (
                        ans.answerText || (
                          <span className="text-muted-foreground italic">No answer provided</span>
                        )
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Scheduled Interviews */}
          <Section
            title="Interview Rounds"
            description="Virtual meetings and Google Meet video sessions."
          >
            {app.interviews.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center">
                <p className="type-caption text-muted-foreground">
                  No interview scheduled yet for this applicant.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => setIsScheduleOpen(true)}
                >
                  <Video className="mr-1.5 size-4" /> Schedule Interview
                </Button>
              </div>
            ) : (
              <div className="grid gap-3">
                {app.interviews.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="grid gap-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-heading">{item.interviewType}</span>
                        <InterviewStatusBadge status={item.status} />
                      </div>
                      <div className="type-caption text-muted-foreground">
                        {new Date(item.scheduledAt).toLocaleDateString('en-IN', {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        ({item.durationMinutes} mins, {item.timezone})
                      </div>
                      {item.instructions ? (
                        <div className="text-xs text-muted-foreground">
                          Instructions: {item.instructions}
                        </div>
                      ) : null}
                      {item.cancellationReason ? (
                        <div className="text-xs text-destructive">
                          Cancelled: {item.cancellationReason}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-2">
                      <Button asChild size="sm">
                        <a href={item.meetingUrl} target="_blank" rel="noopener noreferrer">
                          <Video className="mr-1.5 size-4" /> Join Google Meet
                        </a>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Internal Notes (Private to Admin) */}
          <Section
            title="Internal Staff Notes"
            description="Confidential notes between administrators and department heads. NEVER visible to applicants."
          >
            <form onSubmit={handleAddNote} className="grid gap-3">
              <Textarea
                rows={3}
                placeholder="Write an internal evaluation note, salary negotiation remark, or reference check feedback…"
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
              />
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={isSavingNote || !newNote.trim()}>
                  <MessageSquare className="mr-1.5 size-4" />
                  {isSavingNote ? 'Saving…' : 'Add Note'}
                </Button>
              </div>
            </form>

            <div className="mt-4 grid gap-3">
              {app.notes.length === 0 ? (
                <p className="type-caption text-muted-foreground">No notes recorded yet.</p>
              ) : (
                app.notes.map((note) => (
                  <div key={note.id} className="rounded-lg border bg-muted/20 p-3.5">
                    <div className="mb-2 flex items-center justify-between border-b pb-1.5 text-xs text-muted-foreground">
                      <span className="font-medium text-heading">{note.admin.fullName}</span>
                      <span>
                        {new Date(note.createdAt).toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap text-foreground">{note.note}</p>
                  </div>
                ))
              )}
            </div>
          </Section>

          {/* Candidate Email Communications */}
          <Section
            title="Candidate Email Communications"
            description="Audited history of transactional emails, status updates and notifications dispatched to this candidate."
          >
            {app.communications.length === 0 ? (
              <p className="type-caption text-muted-foreground">No communication records.</p>
            ) : (
              <div className="grid gap-3">
                {app.communications.map((comm) => (
                  <div key={comm.id} className="rounded-lg border bg-card p-3.5">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-heading">{comm.subject}</span>
                        <Badge
                          variant={comm.status === 'SENT' ? 'outline' : 'destructive'}
                          className="text-xs"
                        >
                          {comm.status}
                        </Badge>
                      </div>
                      <span className="type-caption text-muted-foreground">
                        {new Date(comm.sentAt).toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <div className="mb-2 font-mono text-xs text-muted-foreground">
                      Template: {comm.template} · To: {comm.recipientEmail}
                      {comm.providerMessageId ? ` · Provider ID: ${comm.providerMessageId}` : ''}
                    </div>
                    {comm.error ? (
                      <div className="mb-2 text-xs text-destructive">Error: {comm.error}</div>
                    ) : null}
                    <div className="max-h-32 overflow-y-auto rounded bg-muted/20 p-2 text-xs whitespace-pre-wrap text-foreground">
                      {comm.messageText}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Status History Timeline */}
          <Section
            title="Application Audit Timeline"
            description="Complete historical audit trail of status transitions."
          >
            <div className="relative grid gap-4 border-l border-border/80 pl-6">
              {app.statusHistory.map((h) => (
                <div key={h.id} className="relative grid gap-1">
                  <div className="absolute top-1.5 -left-[31px] size-3 rounded-full bg-primary" />
                  <div className="flex items-center gap-2">
                    <StatusBadge status={h.toStatus} />
                    <span className="type-caption text-muted-foreground">
                      {new Date(h.createdAt).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  {h.reason ? <p className="text-xs text-muted-foreground">{h.reason}</p> : null}
                  {h.changedBy ? (
                    <div className="text-xs text-muted-foreground">
                      Changed by: {h.changedBy.fullName} ({h.changedBy.email})
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>

      {/* Status Transition Dialog */}
      <Dialog open={statusDialog !== null} onOpenChange={(open) => !open && setStatusDialog(null)}>
        <DialogContent>
          <form onSubmit={handleStatusSubmit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{statusDialog?.title}</DialogTitle>
              <DialogDescription>{statusDialog?.description}</DialogDescription>
            </DialogHeader>

            <Field label="Reason / Internal Remark">
              <Input
                placeholder="Optional internal reason for this status change…"
                value={statusReason}
                onChange={(e) => setStatusReason(e.target.value)}
              />
            </Field>

            {statusDialog?.targetStatus === 'ON_HOLD' && (
              <Field label="Expected Follow-Up Date (Optional)">
                <Input
                  type="date"
                  value={statusFollowUpDate}
                  onChange={(e) => setStatusFollowUpDate(e.target.value)}
                />
              </Field>
            )}

            <Field label="Custom Email Message to Candidate (Optional)">
              <Textarea
                rows={3}
                placeholder="Custom text added to the automated applicant notification email…"
                value={statusCustomMessage}
                onChange={(e) => setStatusCustomMessage(e.target.value)}
              />
            </Field>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="sendEmailCheck"
                checked={statusSendEmail}
                onChange={(e) => setStatusSendEmail(e.target.checked)}
                className="rounded border-input text-primary"
              />
              <label htmlFor="sendEmailCheck" className="cursor-pointer text-sm">
                Notify applicant via email
              </label>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStatusDialog(null)}
                disabled={isUpdatingStatus}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isUpdatingStatus}>
                {isUpdatingStatus ? 'Updating…' : 'Confirm Status Change'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Schedule Interview Dialog */}
      <Dialog open={isScheduleOpen} onOpenChange={setIsScheduleOpen}>
        <DialogContent className="max-w-lg">
          <form onSubmit={handleScheduleSubmit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Schedule Candidate Interview</DialogTitle>
              <DialogDescription>
                Invite candidate to a Google Meet interview session. The meeting link and schedule
                will be delivered to their email.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Interview Date">
                <Input
                  type="date"
                  required
                  value={interviewDate}
                  onChange={(e) => setInterviewDate(e.target.value)}
                />
              </Field>
              <Field label="Start Time">
                <Input
                  type="time"
                  required
                  value={interviewTime}
                  onChange={(e) => setInterviewTime(e.target.value)}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Duration (Minutes)">
                <select
                  value={interviewDuration}
                  onChange={(e) => setInterviewDuration(e.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="30">30 minutes</option>
                  <option value="45">45 minutes</option>
                  <option value="60">60 minutes (1 hour)</option>
                  <option value="90">90 minutes</option>
                </select>
              </Field>
              <Field label="Interview Type">
                <Input
                  value={interviewType}
                  onChange={(e) => setInterviewType(e.target.value)}
                  placeholder="e.g. Technical Round / Academic Panel"
                  required
                />
              </Field>
            </div>

            <Field label="Google Meet Link" hint="Paste the Google Meet space URL">
              <Input
                type="url"
                required
                value={interviewMeetUrl}
                onChange={(e) => setInterviewMeetUrl(e.target.value)}
                placeholder="https://meet.google.com/xxx-yyyy-zzz"
              />
            </Field>

            <Field label="Preparation Instructions (Optional)">
              <Input
                value={interviewInstructions}
                onChange={(e) => setInterviewInstructions(e.target.value)}
                placeholder="e.g. Please be prepared to present a 15-minute sample lesson on Calculus."
              />
            </Field>

            <Field label="Personal Note to Candidate">
              <Textarea
                rows={3}
                value={interviewMessage}
                onChange={(e) => setInterviewMessage(e.target.value)}
              />
            </Field>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsScheduleOpen(false)}
                disabled={isScheduling}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isScheduling}>
                {isScheduling ? 'Sending Invitation…' : 'Schedule & Send Invitation'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Custom Email Composer Dialog */}
      <Dialog open={isEmailComposerOpen} onOpenChange={setIsEmailComposerOpen}>
        <DialogContent className="max-w-lg">
          <form onSubmit={handleSendEmail} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Send Candidate Email</DialogTitle>
              <DialogDescription>
                Compose a personalized recruitment email. Supported variables:
                &#123;&#123;applicant_name&#125;&#125;, &#123;&#123;job_title&#125;&#125;,
                &#123;&#123;job_id&#125;&#125;.
              </DialogDescription>
            </DialogHeader>

            <Field label="Subject">
              <Input
                required
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
              />
            </Field>

            <Field label="Message Content">
              <Textarea
                rows={6}
                required
                value={emailMessage}
                onChange={(e) => setEmailMessage(e.target.value)}
              />
            </Field>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsEmailComposerOpen(false)}
                disabled={isSendingEmail}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSendingEmail}>
                <Send className="mr-1.5 size-4" />
                {isSendingEmail ? 'Dispatching…' : 'Send Email'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ResumePreviewDialog
        open={isPreviewOpen}
        onOpenChange={handlePreviewOpenChange}
        fileName={app.resumeOriginalName}
        fileSize={app.resumeFileSize}
        loading={isLoadingPreview}
        error={previewError}
        previewUrl={previewUrl}
        onRetry={() => void loadResumePreview()}
      />
    </div>
  );
}

function InterviewStatusBadge({ status }: { status: InterviewStatus }) {
  switch (status) {
    case 'SCHEDULED':
      return <Badge className="bg-purple-600 text-white">Scheduled</Badge>;
    case 'RESCHEDULED':
      return <Badge className="bg-amber-600 text-white">Rescheduled</Badge>;
    case 'COMPLETED':
      return <Badge className="bg-emerald-600 text-white">Completed</Badge>;
    case 'CANCELLED':
      return <Badge variant="destructive">Cancelled</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}
