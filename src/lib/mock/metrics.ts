import type { ClientMetrics, SiteMetrics, MetricPoint } from "@/lib/types";

/** Per-site headline metrics (mock). Powers the cross-site Overview dashboard. */
export const SITE_METRICS: SiteMetrics[] = [
  {
    siteId: "site-cc",
    leadsIn: 184,
    consultationsBooked: 96,
    costPerBooking: 41,
    recoveredRevenue: 38400,
    recallRecoveryRate: 0.62,
    treatmentRecoveryRate: 0.34,
    noShowRate: 0.07,
    hoursSaved: 47,
  },
  {
    siteId: "site-rv",
    leadsIn: 121,
    consultationsBooked: 58,
    costPerBooking: 53,
    recoveredRevenue: 24900,
    recallRecoveryRate: 0.55,
    treatmentRecoveryRate: 0.29,
    noShowRate: 0.11,
    hoursSaved: 31,
  },
  {
    siteId: "site-ng",
    leadsIn: 88,
    consultationsBooked: 39,
    costPerBooking: 58,
    recoveredRevenue: 16100,
    recallRecoveryRate: 0.48,
    treatmentRecoveryRate: 0.22,
    noShowRate: 0.14,
    hoursSaved: 22,
  },
];

const REVENUE_TREND: MetricPoint[] = [
  { label: "Wk 1", value: 9800 },
  { label: "Wk 2", value: 12400 },
  { label: "Wk 3", value: 15600 },
  { label: "Wk 4", value: 14200 },
  { label: "Wk 5", value: 18900 },
  { label: "Wk 6", value: 21300 },
  { label: "Wk 7", value: 19700 },
  { label: "Wk 8", value: 23500 },
];

export const CLIENT_METRICS: ClientMetrics[] = [
  {
    clientId: "vitality",
    leadsIn: SITE_METRICS.reduce((a, s) => a + s.leadsIn, 0),
    consultationsBooked: SITE_METRICS.reduce((a, s) => a + s.consultationsBooked, 0),
    recoveredRevenue: SITE_METRICS.reduce((a, s) => a + s.recoveredRevenue, 0),
    hoursSaved: SITE_METRICS.reduce((a, s) => a + s.hoursSaved, 0),
    trend: REVENUE_TREND,
  },
];

export function getClientMetrics(clientId: string): ClientMetrics | undefined {
  return CLIENT_METRICS.find((m) => m.clientId === clientId);
}

export function getSiteMetrics(siteIds: string[]): SiteMetrics[] {
  return SITE_METRICS.filter((m) => siteIds.includes(m.siteId));
}
