import type { DentallyClient } from "@/lib/dentally/client";
import { toE164 } from "@/lib/messaging/phone";
import { getSite, siteIdFromDentally } from "@/lib/mock/clients";
import { lookupPhoneIdentity, upsertPhoneIdentity } from "./repository";
import type { PhoneIdentity } from "./types";

/**
 * Map a Dentally site UUID (what the live API returns on a patient) to OUR
 * internal site id. An unmapped site means the patient belongs to a practice in
 * the group we do not serve — treat as unrecognised rather than threading their
 * conversation into a site nobody can see. Accepts an already-internal id (the
 * local mock) unchanged.
 */
function toInternalSiteId(raw: string | undefined | null): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const mapped = siteIdFromDentally(value);
  if (mapped) return mapped;
  return getSite(value) ? value : null;
}

interface DentallyPatient {
  id: string | number;
  first_name?: string;
  last_name?: string;
  site_id?: string;
  mobile_phone?: string;
  dentist_recall_date?: string | null;
  recall_due_at?: string | null;
  last_visit_at?: string | null;
}

function nameOf(p: DentallyPatient): string {
  return [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || "there";
}

/**
 * Resolve an inbound phone number to a patient on record.
 *
 * Order:
 *   1. directory cache (agent_phone_identity)
 *   2. Dentally phone search (cached into the directory on hit)
 *
 * Returns null when the number is not recognised. Reactivation linkage is
 * handled separately by the webhook so cadence side-effects stay together.
 */
export async function identifyByPhone(
  phone: string,
  deps: { dentally: Pick<DentallyClient, "findPatientsByPhone"> },
): Promise<PhoneIdentity | null> {
  // 1) Directory cache. Normalise the cached siteId too: rows written before the
  // UUID-mapping fix may carry a raw Dentally site UUID, which would bypass the
  // kill switch and hide the conversation from the staff inbox.
  try {
    const cached = await lookupPhoneIdentity(phone);
    if (cached) {
      const site = toInternalSiteId(cached.siteId);
      if (site) return cached.siteId === site ? cached : { ...cached, siteId: site };
      // Unmappable cached site: ignore the stale row and re-resolve below.
    }
  } catch {
    // fall through to a live lookup
  }

  // 2) Dentally phone search.
  try {
    const res = await deps.dentally.findPatientsByPhone(phone);
    const list = Array.isArray(res.patients) ? (res.patients as DentallyPatient[]) : [];
    // Defensive match: the server-side phone filter is not yet calibrated against the
    // live Dentally sandbox, so NEVER trust list[0]. Accept a candidate ONLY when its
    // own mobile number normalises to the SAME E.164 as the inbound number. If the
    // endpoint returned an unfiltered list (bad param), list[0] would be a random
    // patient and we would thread this reply into the WRONG patient's record. No
    // exact match -> treat as unrecognised.
    const target = toE164(phone);
    const p = target
      ? list.find((c) => c.mobile_phone && toE164(c.mobile_phone) === target)
      : undefined;
    if (p && p.id !== undefined && p.id !== null && String(p.id).length > 0) {
      const identity: PhoneIdentity = {
        patientId: String(p.id),
        siteId: toInternalSiteId(p.site_id) ?? "",
        patientName: nameOf(p),
        treatment: null,
        fundingType: null,
        lastVisitAt: p.last_visit_at ?? null,
        recallDueAt: p.dentist_recall_date ?? p.recall_due_at ?? null,
        source: "dentally",
      };
      if (identity.siteId) {
        try {
          await upsertPhoneIdentity(phone, identity);
        } catch {
          // caching is best-effort
        }
      }
      return identity;
    }
  } catch {
    // Dentally not reachable / no key: treat as unrecognised.
  }

  return null;
}
