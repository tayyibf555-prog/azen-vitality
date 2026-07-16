import { cn } from "@/lib/utils";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "whatsapp";

// Soft tinted chips (the aesthetic-shell status language): a pale tint fill, a
// matching hairline and a readable ink. Retuned from the older /10 alpha tones.
const tones: Record<Tone, string> = {
  neutral: "bg-card-muted text-ink border-line-strong",
  success: "bg-tint-green text-status-green border-tint-green-line",
  warning: "bg-tint-amber text-status-amber border-tint-amber-line",
  danger: "bg-tint-red text-status-red border-tint-red-line",
  info: "bg-tint-blue text-status-blue border-tint-blue-line",
  whatsapp: "bg-whatsapp/10 text-[#107c40] border-whatsapp/25",
};

export function StatusPill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
