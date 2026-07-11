import {
  Smile,
  Puzzle,
  Gem,
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
  Flag,
  Circle,
  CircleDot,
  Grip,
  Grid3x3,
  PencilRuler,
  Wand2,
  MapPin,
  Map,
  type LucideIcon,
} from "lucide-react";

// Maps each answer-option value (stable, from the quiz bank) to an icon. Shared by
// the live funnel (assessment-quiz) and the owner-side preview (assessment-preview)
// so the two never drift. Unknown values fall back to a neutral dot.
//
// CURATION RULES (owner ask: icons must fit their option and read as one family):
// - Everything is lucide (one stroke weight, one visual language) at one size.
// - Prefer a real-world OBJECT or gesture the patient instantly recognises over an
//   abstract UI glyph (a wallet, a calendar, a map pin - never alignment bars).
// - Within a question the icons stay distinct WHERE THE CONCEPT DIFFERS; for the
//   region options the LABEL carries the meaning, so every region gets the same
//   map pin (the standard "a place" affordance) rather than a forced pun each.
// - Scalar answers (one/few/many, slight/noticeable/significant) use a same-shaped
//   trio that visibly escalates.
export const OPTION_ICONS: Record<string, LucideIcon> = {
  // treatment
  invisalign: Smile, // a straighter smile - not an abstract alignment glyph
  implants: Puzzle, // filling the missing piece
  veneers: Gem, // a polished cosmetic finish - never the generic "AI sparkle"
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
  first_time: Flag, // starting out
  // implant scope (an escalating one -> cluster -> grid trio)
  one: CircleDot,
  few: Grip,
  many: Grid3x3,
  // alignment detail (same escalating family as implant scope)
  slight: Circle,
  noticeable: Grip,
  significant: Grid3x3,
  // cosmetic goal
  brighter: Sun,
  shape: PencilRuler,
  makeover: Wand2,
  // location: coarse region only; the booking conversation pins down the exact
  // practice. Uniform "a place" pin per region, a map for "somewhere else".
  england: MapPin,
  scotland: MapPin,
  elsewhere: Map,
};

export function iconFor(value: string): LucideIcon {
  return OPTION_ICONS[value] ?? Circle;
}
