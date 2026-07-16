import { cn } from "@/lib/utils";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "whatsapp";

// Flat tinted status TAGS (the locked language): 6px radius, a whisper tint
// fill + tint hairline, and the saturated status ink for the text. Reserved for
// rows that need action — quiet rows carry a dot and muted meta instead.
const tones: Record<Tone, string> = {
  neutral: "bg-[#f5f7fa] text-muted border-[#e5e9f0]",
  success: "bg-tint-green text-status-green border-tint-green-line",
  warning: "bg-tint-amber text-status-amber border-tint-amber-line",
  danger: "bg-tint-red text-status-red border-tint-red-line",
  info: "bg-tint-blue text-status-blue border-tint-blue-line",
  whatsapp: "bg-whatsapp/8 text-[#107c40] border-whatsapp/20",
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
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-[2.5px] text-[11.5px] font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
