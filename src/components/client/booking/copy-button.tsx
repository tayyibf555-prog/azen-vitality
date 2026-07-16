"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

// Copy-to-clipboard button with a transient "Copied" confirmation. Mirrors the
// onboarding Forms tab's CopyLink (src/components/client/onboarding/forms-panel.tsx),
// generalised to copy any string (a link or the pre-written share message).

export function CopyButton({
  value,
  label = "Copy link",
  copiedLabel = "Copied",
  variant = "primary",
  className,
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can be blocked (no permission / insecure context); fail quietly.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
        variant === "primary"
          ? "bg-blue-royal text-white hover:bg-[#17579c]"
          : "border border-line-strong bg-card text-navy hover:bg-card-muted",
        className,
      )}
    >
      {copied ? (
        <Check size={13} className={variant === "secondary" ? "text-success" : undefined} />
      ) : (
        <Copy size={13} />
      )}
      {copied ? copiedLabel : label}
    </button>
  );
}
