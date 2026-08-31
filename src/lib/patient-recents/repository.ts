import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { RECENTS_LIMIT, selectRecents, type RecentPatientRow, type RecentsRead } from "./cap";

// Persistence for patient_recent_view (migration 0095). Service-role only
// (RLS-on, no anon/authenticated grants), like patient_note / patient_status_override.

interface Row {
  dentally_patient_id: string;
  patient_name: string;
  site_id: string;
  viewed_at: string;
}

const COLS = "dentally_patient_id, patient_name, site_id, viewed_at";

/**
 * HOW MANY ROWS THE READ ASKS FOR, and why it is not simply RECENTS_LIMIT.
 *
 * Two reasons, and the second is the one that matters:
 *   - The dedupe in selectRecents is belt-and-braces over the unique constraint.
 *     Reading exactly eight rows would leave it with nothing to work with if the
 *     constraint were ever dropped: eight rows, three of them the same patient,
 *     is a six-item strip that no amount of pure-function correctness can fix.
 *   - The site filter is applied in the query AND in selectRecents (see below).
 *     Any row the query lets through that the pure rule then rejects has spent a
 *     slot, so the window has to be wider than the answer.
 * Three windows' worth of rows is 24 narrow rows. It costs nothing.
 */
const READ_WINDOW = RECENTS_LIMIT * 3;

/**
 * Record that this user opened this patient. Upsert, so a re-open MOVES the
 * patient to the top of their list instead of adding a second row — the unique
 * constraint in 0095 is what makes that a bump rather than an insert.
 *
 * FAIL-SOFT AT THIS BOUNDARY, AND THAT IS THE POINT OF THE FUNCTION.
 *
 * Its only caller is the patient record shell, which renders every time anyone in
 * the practice opens a patient. A recents log is a navigation convenience; the
 * page it hangs off is a clinical record. There is no failure of THIS write that
 * is worth failing THAT read for, so every error is caught here and warned about
 * rather than being handed to a caller who would have to remember to catch it.
 *
 * It follows that this function never rejects, which is what makes it safe for
 * the shell to `void` the promise. A floating promise that CAN reject is an
 * unhandled rejection at the process level; this one cannot, by construction, and
 * the try/catch lives here rather than at the call site precisely so that property
 * belongs to the function instead of to whoever calls it next.
 *
 * console.warn, not console.error: nothing is broken for the user, and this must
 * not read like an incident in the logs.
 */
export async function recordPatientView(input: {
  clientId: string;
  userId: string;
  patientId: string;
  patientName: string;
  siteId: string;
}): Promise<void> {
  try {
    const db = serviceClient();
    const { error } = await db.from("patient_recent_view").upsert(
      {
        client_id: input.clientId,
        user_id: input.userId,
        dentally_patient_id: input.patientId,
        patient_name: input.patientName,
        site_id: input.siteId,
        // Written explicitly rather than left to the column default: a default
        // only applies to an INSERT, and the whole purpose of this call on a
        // patient already in the list is to move viewed_at forward.
        viewed_at: new Date().toISOString(),
      },
      { onConflict: "user_id,client_id,dentally_patient_id" },
    );
    if (error) throw error;
  } catch (err) {
    // Never the patient name and never the patient id: this line goes to a log
    // that is not the clinical record. The user id is enough to chase it.
    console.warn(`[patient-recents] could not record a view for user ${input.userId}; strip may be stale`, err);
  }
}

/**
 * This user's recently-opened patients at this practice, already scoped, deduped,
 * newest first and capped.
 *
 * THE SITE FILTER APPEARS TWICE, WHICH IS DELIBERATE. Here it narrows the window
 * so the LIMIT is not spent on rows the display rule will discard — a user who
 * opened twenty patients at one site would otherwise see an empty strip after
 * switching to another. In selectRecents it is re-applied because a rule that
 * decides whether one site's patient names are shown to somebody scoped to a
 * different site has to be provable, and a PostgREST `.in()` cannot be put under
 * test. If they ever disagree the pure one wins: it is the one with a test.
 *
 * `ok: false` on a failed read rather than an empty list. The caller renders
 * nothing either way, but the two are still different facts and the flag keeps
 * them apart — see RecentsRead.
 */
export async function listRecentPatients(args: {
  clientId: string;
  userId: string;
  siteIds: string[];
}): Promise<RecentsRead> {
  // No scope means nothing to show, and asking the database for `site_id in ()`
  // is both a wasted round trip and a query some drivers widen to "no filter".
  if (args.siteIds.length === 0) return { ok: true, patients: [] };
  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("patient_recent_view")
      .select(COLS)
      .eq("user_id", args.userId)
      .eq("client_id", args.clientId)
      .in("site_id", args.siteIds)
      .order("viewed_at", { ascending: false })
      .limit(READ_WINDOW);
    if (error) throw error;
    const rows: RecentPatientRow[] = (data as Row[]).map((r) => ({
      patientId: r.dentally_patient_id,
      name: r.patient_name,
      siteId: r.site_id,
      viewedAt: r.viewed_at,
    }));
    return { ok: true, patients: selectRecents(rows, args.siteIds) };
  } catch (err) {
    console.warn(`[patient-recents] could not read recents for user ${args.userId}; the strip is hidden`, err);
    return { ok: false, patients: [] };
  }
}
