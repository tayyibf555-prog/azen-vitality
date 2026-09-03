import { listAbandonedHolds, markHoldExpired, type BookingHold } from "./holds";
import { findOpenLeadByAddress, insertLead } from "@/lib/speed-to-lead/repository";
import type { LeadConsent } from "@/lib/speed-to-lead/types";
import { londonDateTimeLabel } from "@/lib/time/london";
import { isSystemEnabledForSend } from "@/lib/systems/repository";

/** The single pilot client, matching every other sweep in this tree. */
const CLIENT_ID = "vitality";

// Lazy conversion of abandoned booking holds into speed-to-lead leads.
//
// A hold still 'held' past the abandonment window is someone who started booking
// and did not finish: exactly the person the practice wants to win back. Rather
// than a new cron (cron registration is locked down here), the existing per-minute
// speed-to-lead sweep calls this as a small BOUNDED, BEST-EFFORT step. Each
// converted hold becomes a normal speed-to-lead lead (source 'abandoned-booking'),
// which then flows through the EXISTING machinery — its own toggle, consent gate,
// suppression list and instant first contact. This step sends nothing itself.
//
// GDPR posture: the patient gave their mobile at booking step 1 under explicit
// microcopy that the practice may text them about this booking, so a follow-up on
// that exact booking is within the basis they were shown. Consent is recorded as
// sms (and email when supplied) on the lead; the shared machinery still honours
// STOP/suppression before anything is sent.

const ABANDON_AFTER_MS = 20 * 60 * 1000; // a hold 'held' this long is abandoned
const MAX_HOLD_AGE_MS = 48 * 60 * 60 * 1000; // staleness floor (mirrors the SLA sweep's 48h)
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000; // reuse an open lead for the same contact within a day
const BATCH_LIMIT = 25; // never let one tick do unbounded work

export interface AbandonedConversionResult {
  checked: number;
  converted: number;
  deduped: number;
}

/**
 * Convert abandoned holds to leads. Bounded (at most BATCH_LIMIT per call) and
 * per-hold best-effort: one hold's failure is swallowed so the rest still convert
 * and, crucially, so this can never throw into the sweep that hosts it. Returns a
 * small summary for the sweep's response.
 */
export async function convertAbandonedHolds(now: Date = new Date()): Promise<AbandonedConversionResult> {
  // ===========================================================================
  // TWO SWITCHES, BOTH REQUIRED (ruling W1-B/4, 3 Sep 2026).
  //
  // The rescue used to be stopped by `speed-to-lead` alone, because that is the
  // sweep that hosts it and the machinery it feeds. But what it rescues is an
  // abandoned ONLINE BOOKING, and an owner who has switched online booking off
  // has switched off the very flow this text invites the patient back into. The
  // message would read as "come and finish the booking you started" about a page
  // that now refuses bookings.
  //
  // So it needs BOTH. The guard lives here rather than in the sweep for the same
  // reason the waitlist-fill guard lives in fill.ts: this function is the only
  // thing that turns a hold into a lead, and a guard written in the caller is a
  // guard the next caller will not have.
  //
  // FAIL DIRECTION: isSystemEnabledForSend for both — fail-open under dry-run so
  // development keeps working, fail-CLOSED once messaging is live.
  // ===========================================================================
  const [leadsOn, bookingOn] = await Promise.all([
    isSystemEnabledForSend(CLIENT_ID, "speed-to-lead"),
    isSystemEnabledForSend(CLIENT_ID, "online-booking"),
  ]);
  if (!leadsOn || !bookingOn) {
    console.warn(
      `[booking] abandoned-hold rescue skipped: speed-to-lead=${leadsOn ? "on" : "off"}, ` +
        `online-booking=${bookingOn ? "on" : "off"}. Both are required.`,
    );
    return { checked: 0, converted: 0, deduped: 0 };
  }

  const nowMs = now.getTime();
  const olderThanIso = new Date(nowMs - ABANDON_AFTER_MS).toISOString();
  const freshestIso = new Date(nowMs - MAX_HOLD_AGE_MS).toISOString();

  const holds = await listAbandonedHolds(olderThanIso, freshestIso, BATCH_LIMIT);

  let converted = 0;
  let deduped = 0;
  for (const hold of holds) {
    try {
      const outcome = await convertOne(hold, now);
      if (outcome === "converted") converted += 1;
      else if (outcome === "deduped") deduped += 1;
    } catch {
      // Leave this hold 'held' for the next tick rather than failing the batch.
    }
  }
  return { checked: holds.length, converted, deduped };
}

async function convertOne(hold: BookingHold, now: Date): Promise<"converted" | "deduped"> {
  const sinceIso = new Date(now.getTime() - DEDUPE_WINDOW_MS).toISOString();

  // Dedupe on the contact (phone, then email) per the campaign-less lead rules: if
  // an open lead for this person already exists — e.g. they also did the smile
  // assessment, or abandoned twice — reuse it and just retire this hold, so the
  // patient is never double-contacted.
  const existing = await findOpenLeadByAddress(hold.siteId, hold.phone, hold.email, sinceIso);
  if (existing) {
    await markHoldExpired(hold.id);
    return "deduped";
  }

  // The wanted slot rides along in treatment_interest (the lead has no free-text
  // notes column) so the worklist shows what they were trying to book.
  const slotLabel = londonDateTimeLabel(hold.slotStart);
  const treatmentInterest = `${hold.treatment} — wanted ${slotLabel}`;

  // THE BASIS IS NARROW AND IT IS WRITTEN DOWN (ruling W1-B/4, 3 Sep 2026).
  // `marketing: false` is not a default here, it is the point: the patient typed
  // their number into our booking form under microcopy about THAT booking, which
  // covers one transactional follow-up and nothing else. `source: "booking-form"`
  // records which basis this is, so a later reader does not have to infer it from
  // the lead's source column. The 3-touch nurture cadence excludes this source at
  // both of its selection queries (see listNurtureDue), so "at most one rescue
  // message" is enforced by the query, not by a comment.
  const consent: LeadConsent = {
    sms: true,
    email: !!hold.email,
    whatsapp: false,
    marketing: false,
    source: "booking-form",
  };

  await insertLead({
    siteId: hold.siteId,
    name: hold.name,
    email: hold.email,
    phone: hold.phone,
    channel: "sms",
    treatmentInterest,
    source: "abandoned-booking",
    consent,
  });

  // Retire the hold so the next tick does not reconvert it. Deliberately AFTER the
  // insert: if the mark fails, a duplicate lead is caught by the dedupe above on
  // the next tick, so worst case is one retry, never a double first-contact.
  await markHoldExpired(hold.id);
  return "converted";
}
