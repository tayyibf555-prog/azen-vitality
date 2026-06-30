// Meta Ads domain types for the practice dashboard. This is a PURE-DATA layer:
// no React, no network. The shapes here describe campaign templates, a launch
// guide, UK advertising compliance rules, creative patterns, live-ish campaigns
// with analytics, and a curated library of winning ads. Everything is structured
// to be swapped later for the real Meta Marketing API (campaigns / analytics)
// and the Meta Ad Library API (winning ads) without changing consumers.
//
// Money is always GBP (the £ symbol is used in human-readable strings only).
// Single practice: Vitality Dental, three sites (City Centre, Riverside, Northgate).

// The Meta campaign objective, mapped to how we talk about it in the dashboard.
// "retargeting" is not a native Meta objective but a structural pattern we treat
// as its own type because it warrants different audiences and copy.
export type CampaignObjective =
  | "awareness"
  | "leads"
  | "traffic"
  | "engagement"
  | "retargeting";

// The creative format of an ad. "reel" is 9:16 vertical video for Reels / Stories;
// "image" is a single still (typically 1:1 feed); "carousel" is a swipeable set;
// "video" is in-feed video (typically 1:1 or 4:5).
export type AdFormat = "reel" | "image" | "carousel" | "video";

// A reusable, ready-to-launch campaign blueprint for one treatment / offer.
// The copy block is what a marketer would paste into Meta Ads Manager, written
// to be UK-compliant out of the box. complianceNote names the specific rule the
// marketer must honour for this template.
export interface CampaignTemplate {
  id: string;
  name: string;
  treatment: string;
  objective: CampaignObjective;
  goal: string; // one line: what this campaign is trying to achieve
  audience: string; // the targeting in plain English (radius, broad, qualifiers, lookalikes)
  dailyBudgetGbp: { min: number; max: number };
  offer: string; // the hook offer (free consultation, £ saving, quiz, etc.)
  angle: string; // the emotional / messaging angle
  formats: AdFormat[];
  cta: string; // the single call to action
  copy: {
    headline: string;
    primaryText: string;
    description: string;
  };
  complianceNote: string; // the specific UK rule to apply to this template
}

// One step of the step-by-step "how to launch a Meta campaign" guide.
export interface GuideStep {
  n: number;
  title: string;
  body: string;
  tips: string[];
}

// One UK advertising compliance rule. severity drives how the UI should treat it:
// "must" = a hard requirement, "avoid" = a high-risk pattern to stay away from,
// "note" = good-practice guidance.
export interface ComplianceRule {
  title: string;
  detail: string;
  severity: "must" | "avoid" | "note";
}

// A reusable creative pattern (a proven way to structure a hook or offer), with a
// short, UK-compliant example line a marketer can adapt.
export interface CreativePattern {
  name: string;
  whatItIs: string;
  example: string;
}

// The analytics for a single campaign. All money fields are GBP. Derived fields
// (ctr, cpmGbp, cplGbp, costPerBookingGbp, roughReturnX) are kept on the object
// so consumers do not have to recompute them, but they are internally consistent
// with the raw counts (spend, impressions, clicks, leads, bookings).
export interface CampaignMetrics {
  spendGbp: number;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number; // clicks / impressions, as a fraction (e.g. 0.012 = 1.2%)
  cpmGbp: number; // cost per 1,000 impressions
  leads: number;
  cplGbp: number; // cost per lead = spend / leads
  bookings: number;
  costPerBookingGbp: number; // spend / bookings
  roughReturnX: number; // rough return multiple on ad spend (e.g. 4.2 = 4.2x)
}

// A campaign as it would appear in the dashboard. status mirrors Meta's lifecycle
// plus our own "draft". dailyBudgetGbp is the configured daily cap; metrics are
// the (last-30-days) performance. startedAt is an ISO date, or null if a draft.
export interface Campaign {
  id: string;
  name: string;
  treatment: string;
  objective: CampaignObjective;
  status: "active" | "learning" | "paused" | "draft";
  dailyBudgetGbp: number;
  startedAt: string | null;
  metrics: CampaignMetrics;
}

// One curated "winning" ad from the (mock) Meta Ad Library. aiAnalysis explains
// WHY the creative works (2-3 sentences). complianceFlag is a short warning when
// the pattern would be risky for a UK dental practice to copy, else null.
export interface AdLibraryItem {
  id: string;
  advertiser: string;
  location: string;
  treatment: string;
  format: AdFormat;
  objective: string;
  headline: string;
  primaryText: string;
  offer: string;
  hookType: string;
  daysRunning: number;
  estPerformance: "strong" | "steady" | "new";
  aiAnalysis: string;
  complianceFlag: string | null;
}
