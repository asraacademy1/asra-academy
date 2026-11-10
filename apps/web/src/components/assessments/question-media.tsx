'use client';

import type { MediaDto } from '@asra/types';
import { Maximize2 } from 'lucide-react';
import * as React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * Question and option images, shared by the student player, the student review, the faculty
 * attempt review and the question editor. Files are already optimized (≤ 100 KB, served from
 * Cloudinary), so they are shown with a plain <img> on purpose: re-optimizing them through
 * `next/image` would only spend Vercel image-optimization quota, and it cannot render under the
 * plain-Node test runner. The stored width/height still reserve the layout space.
 */
export function MediaImg({
  image,
  alt,
  className,
  eager = false,
}: {
  image: MediaDto;
  alt: string;
  className?: string;
  eager?: boolean;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- pre-optimized Cloudinary file (see above)
    <img
      src={image.url}
      alt={alt}
      width={image.width}
      height={image.height}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      className={className}
    />
  );
}

function Zoomable({
  image,
  alt,
  className,
  priority,
}: {
  image: MediaDto;
  alt: string;
  className?: string;
  priority?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          // Inside an option <label>, opening the image must not also select the option.
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        className={cn(
          'group relative overflow-hidden rounded-lg border bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          className,
        )}
        aria-label={`${alt} — open larger`}
      >
        <MediaImg
          image={image}
          alt={alt}
          eager={priority}
          className="h-auto max-h-80 w-full object-contain"
        />
        <Maximize2
          aria-hidden
          className="absolute top-2 right-2 size-6 rounded bg-background/80 p-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </button>
      {open ? (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent className="max-w-4xl">
            <DialogHeader>
              <DialogTitle>{alt}</DialogTitle>
              <DialogDescription className="sr-only">Enlarged image</DialogDescription>
            </DialogHeader>
            <MediaImg
              image={image}
              alt={alt}
              eager
              className="h-auto max-h-[75vh] w-full object-contain"
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

/** Up to 3 images shown with a question's text. `priority` = the question on screen now. */
export function QuestionImages({
  images,
  priority = false,
}: {
  images: MediaDto[];
  priority?: boolean;
}) {
  if (images.length === 0) return null;
  return (
    <div
      className={cn(
        'grid gap-2',
        images.length > 1 && 'sm:grid-cols-2',
        images.length > 2 && 'lg:grid-cols-3',
      )}
      data-testid="question-images"
    >
      {images.map((image, index) => (
        <Zoomable
          key={image.id}
          image={image}
          alt={`Question image ${index + 1}`}
          priority={priority}
        />
      ))}
    </div>
  );
}

/** The image of one option (A, B, …); `null` renders nothing. */
export function OptionImage({
  image,
  index,
  className,
}: {
  image: MediaDto | null | undefined;
  index: number;
  className?: string;
}) {
  if (!image) return null;
  return (
    <Zoomable
      image={image}
      alt={`Image for option ${optionLetter(index)}`}
      className={cn('w-full max-w-xs', className)}
    />
  );
}

export const optionLetter = (index: number) => String.fromCharCode(65 + index);
