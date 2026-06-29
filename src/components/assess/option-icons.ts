import {
  AlignHorizontalJustifyCenter,
  Replace,
  Sparkles,
  Sparkle,
  Sun,
  Brush,
  MoreHorizontal,
  Zap,
  CalendarDays,
  CalendarRange,
  Search,
  Wallet,
  CreditCard,
  ShieldCheck,
  HelpCircle,
  CalendarCheck,
  Clock,
  Info,
  PartyPopper,
  Hourglass,
  ThumbsUp,
  Compass,
  ClipboardCheck,
  Scale,
  Circle,
  Grip,
  Grid3x3,
  SignalLow,
  SignalMedium,
  SignalHigh,
  PencilRuler,
  Wand2,
  Building2,
  Waves,
  Landmark,
  Map,
  type LucideIcon,
} from "lucide-react";

// Maps each answer-option value (stable, from the quiz bank) to an icon, so every
// option renders as a box with a relevant glyph. Within any one question the icons
// are distinct, so the icon column carries meaning rather than repeating. Shared by
// the live funnel (assessment-quiz) and the owner-side preview (assessment-preview)
// so the two never drift. Unknown values fall back to a neutral dot.
export const OPTION_ICONS: Record<string, LucideIcon> = {
  // treatment
  invisalign: AlignHorizontalJustifyCenter,
  implants: Replace,
  veneers: Sparkles,
  whitening: Sun,
  hygiene: Brush,
  other: MoreHorizontal,
  // timeline
  asap: Zap,
  "1_2_months": CalendarDays,
  "3_6_months": CalendarRange,
  researching: Search,
  // budget
  ready: Wallet,
  finance: CreditCard,
  covered: ShieldCheck,
  unsure: HelpCircle,
  // readiness
  book_now: CalendarCheck,
  soon: Clock,
  info: Info,
  // motivation
  event: PartyPopper,
  long_time: Hourglass,
  recommended: ThumbsUp,
  exploring: Compass,
  // experience
  consulted_deciding: ClipboardCheck,
  comparing: Scale,
  first_time: Sparkle,
  // implant scope (a clear one -> cluster -> grid escalation)
  one: Circle,
  few: Grip,
  many: Grid3x3,
  // alignment detail
  slight: SignalLow,
  noticeable: SignalMedium,
  significant: SignalHigh,
  // cosmetic goal
  brighter: Sun,
  shape: PencilRuler,
  makeover: Wand2,
  // location (a distinct glyph per practice)
  "site-cc": Building2,
  "site-rv": Waves,
  "site-ng": Landmark,
  any: Map,
};

export function iconFor(value: string): LucideIcon {
  return OPTION_ICONS[value] ?? Circle;
}
