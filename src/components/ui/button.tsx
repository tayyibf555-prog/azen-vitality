import { cn } from "@/lib/utils";
import { Slot } from "./slot";

type Variant = "primary" | "secondary" | "ghost" | "navy";
type Size = "sm" | "md" | "lg";

// NOTE: the shared Button is used by the public patient surfaces (login, /assess,
// /book, /onboard) which are OUT of the aesthetic-shell re-skin, so its base
// radius is left as rounded-lg to keep those surfaces byte-for-byte unchanged. The
// study's pill language is carried instead by the segmented Tabs, the tinted
// status pills, and the sidebar/topbar/filter chips.
// .pressable adds the quiet press-down scale (transform-only, reduced-motion
// guarded in globals.css). It changes nothing at rest, so the public surfaces'
// resting appearance stays identical.
const base =
  "pressable inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap";

const variants: Record<Variant, string> = {
  primary: "bg-blue-royal text-white hover:bg-[#17579c] shadow-[0_4px_12px_rgba(28,102,184,0.28)]",
  secondary: "bg-card text-navy border border-line-strong hover:bg-card-muted",
  ghost: "text-ink hover:bg-black/[0.05]",
  navy: "bg-navy text-on-navy hover:bg-navy-soft",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
}

export function Button({
  className,
  variant = "primary",
  size = "md",
  asChild,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(base, variants[variant], sizes[size], className)} {...props} />;
}
