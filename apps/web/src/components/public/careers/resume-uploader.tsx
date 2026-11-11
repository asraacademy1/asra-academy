'use client';

import { CheckCircle2, FileText, Loader2, UploadCloud, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { buildApiUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface UploadedResumeInfo {
  assetId: string;
  fileName: string;
  fileSize: number;
}

interface ResumeUploaderProps {
  onUploadSuccess: (info: UploadedResumeInfo) => void;
  onClear: () => void;
  currentResume?: UploadedResumeInfo | null;
  disabled?: boolean;
}

export function ResumeUploader({
  onUploadSuccess,
  onClear,
  currentResume,
  disabled = false,
}: ResumeUploaderProps) {
  const [isUploading, setIsUploading] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const handleFile = async (file: File) => {
    setErrorMessage(null);

    // Client-side MIME check
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setErrorMessage('Please upload a valid PDF document. Only PDF files are accepted.');
      return;
    }

    // Client-side size check (5 MB limit)
    const MAX_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      setErrorMessage('File size exceeds the 5 MB limit. Please compress your PDF and try again.');
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('resume', file);

      const response = await fetch(buildApiUrl('/careers/upload-resume'), {
        method: 'POST',
        body: formData,
        headers: {
          Accept: 'application/json',
        },
      });

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.message || 'Failed to upload resume. Please try again.');
      }

      onUploadSuccess({
        assetId: json.data.resumeAssetId,
        fileName: json.data.resumeFileName,
        fileSize: json.data.resumeFileSize,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : 'Upload failed. Please check your network and try again.';
      setErrorMessage(message);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled && !isUploading) setIsDragging(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled || isUploading) return;
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  if (currentResume) {
    return (
      <div className="rounded-lg border bg-card p-4 transition-all">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="dark:bg-asra-gold-950 dark:text-asra-gold-300 flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-asra-gold-50 text-asra-gold-700">
              <FileText className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {currentResume.fileName}
              </p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{formatFileSize(currentResume.fileSize)}</span>
                <span>•</span>
                <span className="flex items-center gap-1 font-medium text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Ready for submission
                </span>
              </div>
            </div>
          </div>
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClear}
              className="shrink-0 text-muted-foreground hover:text-destructive"
              title="Remove resume"
            >
              <X className="mr-1 h-4 w-4" />
              Remove
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => !disabled && !isUploading && fileInputRef.current?.click()}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-colors',
          isDragging
            ? 'border-primary bg-primary/5'
            : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30',
          (disabled || isUploading) && 'pointer-events-none cursor-not-allowed opacity-60',
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={onFileSelect}
          disabled={disabled || isUploading}
        />

        {isUploading ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm font-medium">Uploading and verifying resume...</p>
            <p className="text-xs text-muted-foreground">
              Validating PDF header and encrypting securely
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UploadCloud className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-medium">
                <span className="text-primary hover:underline">Click to upload</span> or drag and
                drop
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">PDF only (Max 5 MB)</p>
            </div>
          </div>
        )}
      </div>

      {errorMessage && (
        <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-destructive">
          <span>⚠️</span> {errorMessage}
        </p>
      )}
    </div>
  );
}
