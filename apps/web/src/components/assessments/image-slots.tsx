'use client';

import type { MediaDto, MediaUploadDto } from '@asra/types';
import { ImagePlus, Loader2, RefreshCw, X } from 'lucide-react';
import * as React from 'react';

import { MediaImg } from '@/components/assessments/question-media';

import { useAuth } from '@/components/auth/auth-provider';
import { Button } from '@/components/ui/button';
import { ApiClientError } from '@/lib/api';
import { compressImageFile, formatKilobytes } from '@/lib/media/compress-image';
import { cn } from '@/lib/utils';

/**
 * Image controls of the shared question editor (faculty course quizzes/exams and admin academy
 * quizzes — only the upload endpoint differs). A picked file is optimized in the browser (≤ 100 KB,
 * WebP/JPEG), uploaded, and shown as a preview. Replace/Remove only change the DRAFT: nothing is
 * deleted until the question is saved, and the server then removes images that are no longer
 * used anywhere.
 */

export type ImageUploader = (file: File) => Promise<MediaUploadDto>;

export class ImageUploadError extends Error {}

/** compress → POST raw bytes to `uploadPath` (with the usual token refresh). */
export function useImageUploader(uploadPath: string): ImageUploader {
  const { authorizedRequest } = useAuth();
  return React.useCallback(
    async (file: File) => {
      const compressed = await compressImageFile(file);
      if (!compressed.ok) throw new ImageUploadError(compressed.message);
      try {
        return await authorizedRequest<MediaUploadDto>(uploadPath, {
          method: 'POST',
          body: compressed.blob,
          timeoutMs: 30_000,
        });
      } catch (error) {
        throw new ImageUploadError(
          error instanceof ApiClientError ? error.message : 'The image could not be uploaded.',
        );
      }
    },
    [authorizedRequest, uploadPath],
  );
}

/** Upload result → slots: `index` < length replaces that image, otherwise appends (capped). */
export function placeImage(images: MediaDto[], index: number, media: MediaDto, max: number) {
  const next = [...images];
  if (index < next.length) next[index] = media;
  else next.push(media);
  return next.slice(0, max);
}

export function removeImage(images: MediaDto[], index: number) {
  return images.filter((_, i) => i !== index);
}

type SlotState =
  { kind: 'idle' } | { kind: 'busy'; index: number } | { kind: 'error'; message: string };

export function ImageSlots({
  images,
  max,
  onChange,
  upload,
  label,
  onBusyChange,
  disabled,
  compact = false,
}: {
  images: MediaDto[];
  max: number;
  onChange: (next: MediaDto[]) => void;
  upload: ImageUploader;
  /** Accessible name, e.g. "Question images" or "Image for option B". */
  label: string;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const target = React.useRef<number>(0);
  const [state, setState] = React.useState<SlotState>({ kind: 'idle' });
  const [note, setNote] = React.useState<string | null>(null);
  const busy = state.kind === 'busy';

  React.useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  // If the control disappears mid-upload (option removed, type changed), it is no longer busy —
  // otherwise saving would stay blocked by an upload nobody can see.
  const latestBusy = React.useRef(onBusyChange);
  React.useEffect(() => {
    latestBusy.current = onBusyChange;
  }, [onBusyChange]);
  React.useEffect(() => () => latestBusy.current?.(false), []);

  function pick(index: number) {
    target.current = index;
    inputRef.current?.click();
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    const index = target.current;
    setState({ kind: 'busy', index });
    setNote(null);
    try {
      const uploaded = await upload(file);
      const media: MediaDto = {
        id: uploaded.id,
        url: uploaded.url,
        width: uploaded.width,
        height: uploaded.height,
      };
      onChange(placeImage(images, index, media, max));
      setNote(`Optimized to ${formatKilobytes(uploaded.bytes)}`);
      setState({ kind: 'idle' });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'The image could not be uploaded.',
      });
    }
  }

  const thumb = compact ? 'size-16' : 'size-24';

  return (
    <div className="grid gap-2" role="group" aria-label={label}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ''; // picking the same file again must still fire
          void handleFile(file);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {images.map((image, index) => (
          <figure key={`${image.id}-${index}`} className="grid gap-1">
            <span className={cn('relative overflow-hidden rounded-md border bg-background', thumb)}>
              <MediaImg
                image={image}
                alt={`${label} ${max > 1 ? index + 1 : ''}`.trim()}
                eager
                className="size-full object-contain"
              />
              {busy && state.index === index ? (
                <span className="absolute inset-0 flex items-center justify-center bg-background/70">
                  <Loader2 className="size-5 animate-spin" aria-label="Uploading" />
                </span>
              ) : null}
            </span>
            <span className="flex gap-1">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`Replace ${label.toLowerCase()} ${max > 1 ? index + 1 : ''}`.trim()}
                disabled={disabled || busy}
                onClick={() => pick(index)}
              >
                <RefreshCw aria-hidden />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${label.toLowerCase()} ${max > 1 ? index + 1 : ''}`.trim()}
                disabled={disabled || busy}
                onClick={() => {
                  setNote(null);
                  onChange(removeImage(images, index));
                }}
              >
                <X aria-hidden />
              </Button>
            </span>
          </figure>
        ))}
        {images.length < max ? (
          <Button
            type="button"
            variant="outline"
            size={compact ? 'sm' : 'default'}
            disabled={disabled || busy}
            onClick={() => pick(images.length)}
            aria-label={`Add ${label.toLowerCase()}`}
          >
            {busy && state.index === images.length ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <ImagePlus aria-hidden />
            )}
            {compact ? 'Image' : `Add image${max > 1 ? ` (${images.length}/${max})` : ''}`}
          </Button>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">
        {busy ? 'Optimizing and uploading the image…' : (note ?? '')}
      </p>
      {state.kind === 'error' ? (
        <p className="type-caption text-destructive" role="alert">
          {state.message}
        </p>
      ) : note && !compact ? (
        <p className="type-caption text-muted-foreground">{note}</p>
      ) : null}
    </div>
  );
}
