"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, PenLine, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ESIGN_COPY,
  SIGNATURE_IMAGE_CAP,
  SIGNATURE_TYPED_CAP,
  type StaffSignatureMethod,
} from "@/lib/hr/esign";

// ===========================================================================
// THE SIGNATURE PAD. The first canvas in this codebase.
//
// The data model has been waiting for it since migration 0070: `signature jsonb` has
// stored `{method:'typed'|'drawn'|'ipad', value, signedAt}` all along, and
// lib/fp17/validate.ts has capped a drawn data-URL at 250,000 bytes all along, but
// every capture surface in the repo was a plain text input and `grep` for `<canvas`,
// `getContext` and `toDataURL` returned nothing. 'drawn' was forward declared with
// no producer. This is the producer.
//
// A DUMB COMPONENT. Every rule it obeys lives in lib/hr/esign.ts, where it is unit
// tested: the method union, the two size caps, and what counts as a valid signature.
// Nothing is decided in this file that a test could not otherwise reach — vitest
// collects src/**\/*.test.ts in a node environment, so a rule written into a React
// closure here would be untestable by construction.
//
// WHY IT SHRINKS THE IMAGE. The cap is 250 KB and a naive full-resolution PNG of a
// retina canvas blows through that easily, so the export is taken at a fixed logical
// size and stepped down through lower-quality WebP/JPEG encodings until it fits. It
// reports the failure honestly rather than silently posting something oversized for
// the server to reject with a message the person cannot act on.
//
// TYPED IS A FIRST-CLASS FALLBACK, not a consolation. A trackpad signature from
// somebody with a tremor is worse evidence than their typed name, and the record
// stores WHICH method was used, so the practice can see the difference.
//
// ACCESSIBILITY: pointer events cover mouse, pen and touch in one path;
// `touch-action: none` stops the page scrolling under a finger mid-stroke; the
// typed field is a real input with a real label; and the whole control is reachable
// without ever drawing.
// ===========================================================================

/** The logical drawing surface. Exported at this size regardless of device pixels. */
const CANVAS_WIDTH = 520;
const CANVAS_HEIGHT = 160;

/** Encodings tried in order until one fits under the cap. */
const ENCODINGS: { type: string; quality?: number }[] = [
  { type: "image/png" },
  { type: "image/webp", quality: 0.9 },
  { type: "image/webp", quality: 0.7 },
  { type: "image/jpeg", quality: 0.7 },
  { type: "image/jpeg", quality: 0.5 },
];

export interface SignatureValue {
  method: StaffSignatureMethod;
  value: string;
}

export function SignaturePad({
  onChange,
  disabled,
  signerName,
  className,
}: {
  /** Emits the current signature, or null when there is nothing to submit. */
  onChange: (value: SignatureValue | null) => void;
  disabled?: boolean;
  /** Prefills the typed field with the signer's own name. Editable. */
  signerName?: string;
  className?: string;
}) {
  const [mode, setMode] = useState<StaffSignatureMethod>("drawn");
  const [typed, setTyped] = useState(signerName ?? "");
  const [hasInk, setHasInk] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);

  // ---- canvas plumbing ----------------------------------------------------

  const prepareCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = CANVAS_WIDTH * ratio;
    canvas.height = CANVAS_HEIGHT * ratio;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    // A white ground, not transparency: a transparent PNG rendered on a dark
    // background later would show as an invisible signature, which is the worst
    // possible failure for a document meant to be read years from now.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
  }, []);

  useEffect(() => {
    prepareCanvas();
  }, [prepareCanvas]);

  const pointFrom = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    // The element is laid out responsively, so map client coordinates back onto the
    // fixed logical surface rather than assuming they are the same.
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
    };
  };

  /**
   * Export the drawing, stepping the encoding down until it fits under the shared
   * cap. Returns null when even the smallest encoding is too big, which the caller
   * surfaces as an honest message rather than a silent failure.
   */
  const exportDrawing = useCallback((): string | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    for (const enc of ENCODINGS) {
      let url: string;
      try {
        url = canvas.toDataURL(enc.type, enc.quality);
      } catch {
        continue;
      }
      // A browser that cannot produce the requested type silently returns a PNG, so
      // check what came back rather than what was asked for.
      if (!url.startsWith("data:image/")) continue;
      if (url.length <= SIGNATURE_IMAGE_CAP) return url;
    }
    return null;
  }, []);

  const emitDrawn = useCallback(() => {
    const url = exportDrawing();
    if (!url) {
      setTooLarge(true);
      onChange(null);
      return;
    }
    setTooLarge(false);
    onChange({ method: "drawn", value: url });
  }, [exportDrawing, onChange]);

  const startStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const point = pointFrom(e);
    if (!point) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastRef.current = point;
    // A tap with no drag is still a mark: draw a dot so a full stop registers.
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 1, 0, Math.PI * 2);
      ctx.fillStyle = "#0f172a";
      ctx.fill();
    }
    setHasInk(true);
  };

  const continueStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || disabled) return;
    const point = pointFrom(e);
    const last = lastRef.current;
    const ctx = canvasRef.current?.getContext("2d");
    if (!point || !last || !ctx) return;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastRef.current = point;
  };

  const endStroke = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastRef.current = null;
    emitDrawn();
  };

  const clear = () => {
    prepareCanvas();
    setHasInk(false);
    setTooLarge(false);
    onChange(null);
  };

  // ---- typed --------------------------------------------------------------

  const onTyped = (value: string) => {
    const next = value.slice(0, SIGNATURE_TYPED_CAP);
    setTyped(next);
    onChange(next.trim() === "" ? null : { method: "typed", value: next });
  };

  const switchMode = (next: StaffSignatureMethod) => {
    setMode(next);
    // Switching method invalidates whatever was staged: the record stores WHICH
    // method was used, so leaving a stale drawing armed while the typed tab is
    // showing would store the wrong one.
    if (next === "typed") onChange(typed.trim() === "" ? null : { method: "typed", value: typed });
    else if (hasInk) emitDrawn();
    else onChange(null);
  };

  return (
    <div className={cn("space-y-3", className)}>
      <div
        role="tablist"
        aria-label="How to sign"
        className="inline-flex gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]"
      >
        {(
          [
            { key: "drawn" as const, label: "Draw", icon: PenLine },
            { key: "typed" as const, label: "Type your name", icon: Type },
          ]
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={mode === key}
            disabled={disabled}
            onClick={() => switchMode(key)}
            className={cn(
              "pressable inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:opacity-50",
              mode === key ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
            )}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {mode === "drawn" ? (
        <div className="space-y-2">
          <canvas
            ref={canvasRef}
            aria-label="Signature area. Draw your signature here, or switch to typing your name."
            style={{ aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}`, touchAction: "none" }}
            className={cn(
              "w-full max-w-[520px] cursor-crosshair rounded-[10px] border border-line-strong bg-white",
              disabled && "cursor-not-allowed opacity-60",
            )}
            onPointerDown={startStroke}
            onPointerMove={continueStroke}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onPointerLeave={endStroke}
          />
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={clear}
              disabled={disabled || !hasInk}
            >
              <Eraser size={14} />
              Clear
            </Button>
            <p className="text-[12px] text-muted">
              {hasInk ? "Signed. Clear it to start again." : "Draw your signature in the box."}
            </p>
          </div>
          {tooLarge ? (
            <p className="text-[12px] font-medium text-status-red">
              That signature is too large to store. Please clear it and sign a little more simply,
              or type your name instead.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="max-w-[520px] space-y-2">
          <label htmlFor="signature-typed" className="block text-[12px] font-medium text-muted">
            Type your full name
          </label>
          <input
            id="signature-typed"
            type="text"
            value={typed}
            disabled={disabled}
            maxLength={SIGNATURE_TYPED_CAP}
            onChange={(e) => onTyped(e.target.value)}
            placeholder="Your full name"
            className="h-10 w-full rounded-lg border border-line-strong bg-card px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:opacity-60"
          />
        </div>
      )}

      <p className="max-w-prose text-[12px] leading-relaxed text-muted">{ESIGN_COPY.whatThisIs}</p>
      <p className="max-w-prose text-[12px] leading-relaxed text-faint">
        {ESIGN_COPY.whatThisIsNot}
      </p>
    </div>
  );
}
