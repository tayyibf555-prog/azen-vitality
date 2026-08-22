// THE ADJECTIVE FOR A REPORT PERIOD. One word, in one place.
//
// It was written out four times as `period === "week" ? "weekly" : "monthly"` --
// once in the prompt builder, once in the reports page's unavailable copy, and
// twice more in the workspace (the panel heading and the two waiting sentences) --
// which is three chances for the screen and the review the model writes to describe
// the same period with different words.
//
// WHY IT IS ITS OWN FILE AND NOT SIMPLY AN EXPORT FROM ai.ts. Two of the four call
// sites are inside `components/client/reports/reports-workspace.tsx`, which is a
// "use client" component. ai.ts pulls SNAPSHOT_LEAD_LIMIT out of snapshot.ts as a
// VALUE, and snapshot.ts imports @/lib/speed-to-lead/repository, which imports the
// Supabase SERVICE client. Importing this one pure word from ai.ts would therefore
// drag the whole enquiry repository -- and the service-role client with it -- into
// the browser bundle, and nothing in that chain carries `server-only` to stop it.
// So the word lives here, importing NOTHING at runtime, and ai.ts re-exports it for
// callers that already sit on the server. The type import below is erased.
//
// SINGULAR AND PLURAL ARE NOT THE SAME WORD. `periodWord` is the adjective a review
// is described with ("weekly review", "monthly figures"); the noun for the window
// itself is the ReportPeriod value ("this week", "this month") and is deliberately
// not derived from here.

import type { ReportPeriod } from "./snapshot";

/** The adjective for a report period: "weekly" / "monthly". */
export function periodWord(period: ReportPeriod): string {
  return period === "week" ? "weekly" : "monthly";
}
