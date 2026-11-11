'use client';

import { AlertCircle, Download, Eye, FileText, Loader2, RotateCcw } from 'lucide-react';
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

export function formatResumeSizeMb(fileSize: number): string {
  const safeBytes = Number.isFinite(fileSize) && fileSize > 0 ? fileSize : 0;
  return `${(safeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Validates a non-empty response blob and ensures its MIME type is application/pdf. */
export function ensurePdfBlob(blob: Blob): Blob {
  if (blob.size === 0) {
    throw new Error('The resume PDF appears to be empty.');
  }
  return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
}

export interface ApplicantResumeCardProps {
  resumeOriginalName: string;
  resumeFileSize: number;
  isPreviewLoading: boolean;
  isDownloading: boolean;
  onPreview: () => void;
  onDownload: () => void;
}

/**
 * Resume metadata card on Applicant Details with independent Preview and Download actions.
 */
export function ApplicantResumeCard({
  resumeOriginalName,
  resumeFileSize,
  isPreviewLoading,
  isDownloading,
  onPreview,
  onDownload,
}: ApplicantResumeCardProps) {
  const displayName = resumeOriginalName || 'resume.pdf';

  return (
    <Card className="grid gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="type-h4 text-heading">Resume PDF</h2>
        <Badge variant="outline">Verified PDF</Badge>
      </div>
      <div className="flex items-center gap-3 rounded-lg border bg-muted/20 p-3">
        <FileText className="size-8 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="truncate font-medium text-heading" title={displayName}>
            {displayName}
          </div>
          <div className="type-caption text-muted-foreground">
            {formatResumeSizeMb(resumeFileSize)} · application/pdf
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <Button
          type="button"
          variant="outline"
          onClick={onPreview}
          disabled={isPreviewLoading}
          className="w-full"
        >
          {isPreviewLoading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Eye className="size-4" aria-hidden />
          )}
          {isPreviewLoading ? 'Loading…' : 'Preview Resume'}
        </Button>
        <Button type="button" onClick={onDownload} disabled={isDownloading} className="w-full">
          {isDownloading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Download className="size-4" aria-hidden />
          )}
          {isDownloading ? 'Downloading…' : 'Download Resume'}
        </Button>
      </div>
    </Card>
  );
}

export interface ResumePreviewBodyProps {
  fileName: string;
  loading: boolean;
  error: string | null;
  previewUrl: string | null;
  onRetry: () => void;
}

/**
 * Renders the PDF preview states (loading, meaningful error with retry, or embedded iframe viewer).
 */
export function ResumePreviewBody({
  fileName,
  loading,
  error,
  previewUrl,
  onRetry,
}: ResumePreviewBodyProps) {
  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <Loader2 className="size-8 animate-spin text-primary" aria-hidden />
        <div className="grid gap-1">
          <p className="font-medium text-heading">Loading resume preview…</p>
          <p className="type-caption text-muted-foreground">
            Securely streaming {fileName || 'resume.pdf'}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="flex h-full min-h-[280px] flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertCircle className="size-6" aria-hidden />
        </div>
        <div className="grid max-w-md gap-1.5">
          <p className="font-medium text-heading">Unable to load resume preview</p>
          <p className="type-caption text-muted-foreground">{error}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw className="size-4" aria-hidden />
          Retry Preview
        </Button>
      </div>
    );
  }

  if (!previewUrl) {
    return null;
  }

  return (
    <iframe
      src={previewUrl}
      title={`Resume preview: ${fileName || 'resume.pdf'}`}
      className="h-full w-full border-0 bg-white"
    />
  );
}

export interface ResumePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  fileSize: number;
  loading: boolean;
  error: string | null;
  previewUrl: string | null;
  onRetry: () => void;
}

/**
 * Responsive modal dialog for viewing an applicant's PDF resume in-page without downloading it.
 */
export function ResumePreviewDialog({
  open,
  onOpenChange,
  fileName,
  fileSize,
  loading,
  error,
  previewUrl,
  onRetry,
}: ResumePreviewDialogProps) {
  const displayName = fileName || 'resume.pdf';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85dvh] max-h-[85dvh] w-[calc(100%-1.5rem)] max-w-4xl flex-col gap-4 overflow-hidden p-4 sm:p-6">
        <DialogHeader className="shrink-0">
          <DialogTitle>Resume Preview</DialogTitle>
          <DialogDescription className="truncate">
            {displayName} · {formatResumeSizeMb(fileSize)} · application/pdf
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-muted/20">
          <ResumePreviewBody
            fileName={displayName}
            loading={loading}
            error={error}
            previewUrl={previewUrl}
            onRetry={onRetry}
          />
        </div>

        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
