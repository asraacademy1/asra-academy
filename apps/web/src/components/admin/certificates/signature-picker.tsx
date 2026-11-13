'use client';

import type { CertificateSignatureDto } from '@asra/types';
import {
  CERTIFICATE_SIGNATURE_LIMITS,
  type CertificateSignaturePlacementInput,
} from '@asra/validation';
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CheckboxField, SelectField } from '../admin-ui';
import { signatureImageSrc } from './certificates-shell';

const POSITION_SUGGESTIONS = [
  { value: 'Left', label: 'Left' },
  { value: 'Center-Left', label: 'Center-Left' },
  { value: 'Center', label: 'Center' },
  { value: 'Center-Right', label: 'Center-Right' },
  { value: 'Right', label: 'Right' },
];

export function defaultPositionForIndex(index: number, total: number): string {
  if (total === 2) return index === 0 ? 'Left' : 'Right';
  if (total === 3) return index === 0 ? 'Left' : index === 1 ? 'Center' : 'Right';
  return ['Left', 'Center-Left', 'Center-Right', 'Right'][index] ?? `Slot ${index + 1}`;
}

export function SignaturePicker({
  availableSignatures,
  value,
  onChange,
  disabled = false,
  slotLabels,
}: {
  availableSignatures: CertificateSignatureDto[];
  value: CertificateSignaturePlacementInput[];
  onChange: (next: CertificateSignaturePlacementInput[]) => void;
  disabled?: boolean;
  /**
   * Fixed signatory slots of an artwork template (e.g. ['Event Coordinator', 'Director']):
   * exactly this many signatures are required and position labels follow the slot order.
   */
  slotLabels?: readonly string[];
}) {
  const activeSignatures = availableSignatures.filter((s) => s.isActive);
  const byId = new Map(availableSignatures.map((s) => [s.id, s]));
  const selectedIds = new Set(value.map((v) => v.signatureId));
  const minCount = slotLabels ? slotLabels.length : CERTIFICATE_SIGNATURE_LIMITS.minSignatures;
  const maxCount = slotLabels ? slotLabels.length : CERTIFICATE_SIGNATURE_LIMITS.maxSignatures;
  const labelFor = (index: number, total: number) =>
    slotLabels ? (slotLabels[index] ?? `Slot ${index + 1}`) : defaultPositionForIndex(index, total);
  const relabel = (list: CertificateSignaturePlacementInput[]) =>
    list.map((item, idx) => ({
      ...item,
      sortOrder: idx,
      ...(slotLabels ? { positionLabel: labelFor(idx, list.length) } : {}),
    }));

  const addSignature = (sig: CertificateSignatureDto) => {
    if (!sig.isActive || selectedIds.has(sig.id)) return;
    if (value.length >= maxCount) return;
    const nextOrder = value.length;
    onChange([
      ...value,
      {
        signatureId: sig.id,
        sortOrder: nextOrder,
        positionLabel: labelFor(nextOrder, nextOrder + 1),
        showName: true,
        showDesignation: true,
      },
    ]);
  };

  const removeAt = (index: number) => {
    onChange(relabel(value.filter((_, idx) => idx !== index)));
  };

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const copy = [...value];
    const current = copy[index]!;
    copy[index] = copy[target]!;
    copy[target] = current;
    onChange(relabel(copy));
  };

  const updateAt = (index: number, patch: Partial<CertificateSignaturePlacementInput>) => {
    onChange(value.map((item, idx) => (idx === index ? { ...item, ...patch } : item)));
  };

  const countValid = value.length >= minCount && value.length <= maxCount;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="type-label text-heading">
            Digital Signatures ({value.length} / {maxCount})
          </h3>
          <p className="type-caption text-muted-foreground">
            {slotLabels
              ? `Required: exactly ${slotLabels.length} active signatures, in this order — ${slotLabels.join(' then ')}. Certificates cannot be previewed or issued without them.`
              : 'Select 2 to 4 active registered signatures, arrange order, and configure name/designation visibility.'}
          </p>
        </div>
        <Badge variant={countValid ? 'success' : 'warning'}>
          {countValid
            ? `${value.length} selected`
            : slotLabels
              ? `Select ${slotLabels.length} signatures`
              : 'Select 2–4 signatures'}
        </Badge>
      </div>

      {activeSignatures.length < 2 && (
        <Alert tone="warning" title="More active signatures needed">
          <p>
            At least 2 active signatures must be registered before saving a signature configuration.{' '}
            <Link href="/admin/certificates/signatures" className="font-medium underline">
              Manage Digital Signatures
            </Link>
          </p>
        </Alert>
      )}

      {/* Selected Signatures Order & Config */}
      {value.length > 0 && (
        <div className="grid gap-3">
          {value.map((item, index) => {
            const sig = byId.get(item.signatureId);
            const src = sig ? signatureImageSrc(sig) : null;
            return (
              <div
                key={item.signatureId}
                className="grid gap-3 rounded-xl border bg-background/60 p-3 sm:grid-cols-[120px_1fr]"
              >
                <div className="flex flex-col items-center justify-center rounded-lg border bg-[radial-gradient(#cbd5e1_1px,transparent_1px)] [background-size:10px_10px] p-2">
                  {src ? (
                    // eslint-disable-next-line @next/next/no-img-element -- transparent PNG signature preview
                    <img
                      src={src}
                      alt={sig?.fullName ?? 'Signature'}
                      className="max-h-12 max-w-full object-contain"
                    />
                  ) : (
                    <span className="type-caption text-muted-foreground">No PNG</span>
                  )}
                </div>

                <div className="grid gap-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-heading">
                        {sig?.fullName ?? 'Unknown signature'}
                        {sig && !sig.isActive && (
                          <Badge variant="destructive" className="ml-2">
                            Inactive
                          </Badge>
                        )}
                      </p>
                      <p className="type-caption text-muted-foreground">
                        {sig?.designation}
                        {sig?.department ? ` · ${sig.department}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        disabled={disabled || index === 0}
                        onClick={() => move(index, -1)}
                        aria-label="Move signature left"
                      >
                        <ArrowUp className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="outline"
                        disabled={disabled || index === value.length - 1}
                        onClick={() => move(index, 1)}
                        aria-label="Move signature right"
                      >
                        <ArrowDown className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={disabled}
                        onClick={() => removeAt(index)}
                        aria-label="Remove signature"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    {slotLabels ? (
                      <div className="grid gap-1">
                        <p className="type-caption text-muted-foreground">Signature area</p>
                        <Badge variant="outline" className="w-fit">
                          {labelFor(index, value.length)}
                        </Badge>
                      </div>
                    ) : (
                      <div className="grid gap-1">
                        <SelectField
                          id={`sig-pos-${index}`}
                          label="Position"
                          value={
                            POSITION_SUGGESTIONS.some((p) => p.value === item.positionLabel)
                              ? item.positionLabel
                              : 'CUSTOM'
                          }
                          onValueChange={(next) => {
                            if (next !== 'CUSTOM') updateAt(index, { positionLabel: next });
                          }}
                          options={[
                            ...POSITION_SUGGESTIONS,
                            { value: 'CUSTOM', label: 'Custom label…' },
                          ]}
                          disabled={disabled}
                        />
                        <Input
                          value={item.positionLabel}
                          onChange={(e) => updateAt(index, { positionLabel: e.target.value })}
                          placeholder="Custom position label"
                          maxLength={40}
                          disabled={disabled}
                          aria-label={`Custom position label for signature ${index + 1}`}
                        />
                      </div>
                    )}
                    <div className="flex flex-col justify-center gap-2 pt-1">
                      <CheckboxField
                        id={`sig-name-${index}`}
                        label="Show person's name"
                        checked={item.showName}
                        onChange={(checked) => updateAt(index, { showName: checked })}
                        disabled={disabled}
                      />
                      <CheckboxField
                        id={`sig-role-${index}`}
                        label="Show official designation"
                        checked={item.showDesignation}
                        onChange={(checked) => updateAt(index, { showDesignation: checked })}
                        disabled={disabled}
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Available Active Signatures Picker */}
      {availableSignatures.length > 0 && (
        <div className="grid gap-2">
          <p className="type-caption font-medium text-muted-foreground">
            Available registered signatures (click to add):
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {availableSignatures.map((sig) => {
              const isSelected = selectedIds.has(sig.id);
              const canAdd = sig.isActive && !isSelected && value.length < maxCount && !disabled;
              const src = signatureImageSrc(sig);
              return (
                <button
                  key={sig.id}
                  type="button"
                  disabled={!canAdd}
                  onClick={() => addSignature(sig)}
                  className="flex items-center gap-3 rounded-xl border bg-card p-2.5 text-left transition-colors hover:border-primary/50 hover:bg-secondary/30 disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <div className="flex h-10 w-16 shrink-0 items-center justify-center rounded border bg-slate-50 p-1">
                    {src ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signature thumbnail
                      <img src={src} alt="" className="max-h-full max-w-full object-contain" />
                    ) : (
                      <span className="text-[10px] text-muted-foreground">PNG</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate type-label text-heading">{sig.fullName}</p>
                    <p className="truncate type-caption text-muted-foreground">{sig.designation}</p>
                  </div>
                  {isSelected ? (
                    <Badge variant="success">
                      <Check className="mr-1 size-3" /> Selected
                    </Badge>
                  ) : !sig.isActive ? (
                    <Badge variant="secondary">Inactive</Badge>
                  ) : (
                    <Plus className="size-4 shrink-0 text-primary" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
