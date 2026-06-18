import { cn } from "@/lib/utils";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "whatsapp";

const tones: Record<Tone, string> = {
  neutral: "bg-card-muted text-ink border-line-strong",
  success: "bg-success/10 text-success border-success/20",
  warning: "bg-warning/10 text-[#9a6700] border-warning/25",
  danger: "bg-danger/10 text-danger border-danger/20",
  info: "bg-blue-dark/10 text-blue-dark border-blue-dark/20",
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
