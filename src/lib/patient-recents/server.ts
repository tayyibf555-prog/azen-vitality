import "server-only";
import { authEnforced } from "@/lib/auth/guard";
import { getSessionUser } from "@/lib/auth/session";
import { listRecentPatients, recordPatientView } from "./repository";
import type { RecentsRead } from "./cap";

/**
 * The two session-aware wrappers the server components use, so that neither the
 * record shell nor the patients view has to know how a user is resolved and
 * neither has to remember which failures are survivable.
 *
 * Mirrors src/lib/patient-notes/server-read.ts, which does the same job for the
 * pinned-notes band.
 */

/**
 * Record that the signed-in user opened this patient.
 *
 * WHEN THERE IS NO USER, RECORD NOTHING. Auth enforcement turns on with
 * SUPABASE_SERVICE_ROLE_KEY (see authEnforced), so in the un-enforced pilot there
 * is no id to file the opening under. The tempting alternative — a placeholder id,
 * a "pilot" bucket, the client slug — is exactly the cross-user leak that the
 * cookie was rejected for in migration 0095, rebuilt in the database: every user
 * on every machine would pool into one list and each would be shown the patients
 * the others had opened. An absent recents strip is the correct behaviour for a
 * platform that does not yet know who is looking.
 *
 * NEVER THROWS, NEVER REJECTS. getSessionUser reaches the auth server and the
 * database, either of which can fail; recordPatientView is fail-soft in its own
 * right. Both are inside this try so that the caller can safely `void` the
 * promise: see the call site in patient-record-shell.tsx.
 */
export async function logPatientView(input: {
  clientId: string;
  patientId: string;
  patientName: string;
  siteId: string;
}): Promise<void> {
  try {
    const user = authEnforced() ? await getSessionUser() : null;
    if (!user) return;
    await recordPatientView({ ...input, userId: user.id });
  } catch (err) {
    console.warn("[patient-recents] could not resolve a user to record this view against", err);
  }
}

/**
 * The signed-in user's recents for this practice, scoped to the sites currently in
 * view.
 *
 * NO USER MEANS A GENUINELY EMPTY LIST, not a failed read: logPatientView writes
 * nothing without a user, so "there are none" is the complete and true answer for
 * an un-enforced pilot rather than a fact we failed to establish. A thrown session
 * lookup IS a failed read and is reported as one.
 */
export async function readRecentsForUser(args: {
  clientId: string;
  siteIds: string[];
}): Promise<RecentsRead> {
  try {
    const user = authEnforced() ? await getSessionUser() : null;
    if (!user) return { ok: true, patients: [] };
    return await listRecentPatients({ ...args, userId: user.id });
  } catch (err) {
    console.warn("[patient-recents] could not resolve a user to read recents for; the strip is hidden", err);
    return { ok: false, patients: [] };
  }
}
