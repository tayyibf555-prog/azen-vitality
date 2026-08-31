import Link from "next/link";
import { RECENTS_LIMIT, type RecentsRead } from "@/lib/patient-recents/cap";

/**
 * The last few patients THIS USER opened, above the patients list.
 *
 * The practice owner, on the 27 Aug call, about the equivalent tab in Dentally:
 * "that is a really useful tab... we'll get that in". It exists because the job on
 * this page is rarely "find a patient I have never seen"; it is "get back to the
 * one I was on before the phone rang".
 *
 * ---------------------------------------------------------------------------
 * WHY A FAILED READ RENDERS NOTHING, WHICH IS NOT THE SAME AS TREATING FAILURE
 * AND EMPTINESS AS THE SAME THING.
 *
 * The house rule on the patient record is that PanelEmpty ("this patient has
 * none") and PanelFailed ("we could not read it") are different components,
 * because a reader who is shown an outage as a fact will act on it. That rule
 * applies here and produces an unusual-looking answer: BOTH cases render null.
 *
 * That is not the rule being ignored, it is the rule being applied to something
 * that is not a panel. The strip is a shortcut, not a report. Nobody reasons from
 * its absence — a user who cannot see it types the name, which is what they did
 * before this feature existed. So the honest options are "render nothing" or
 * "render an amber failure notice above the patients list", and an amber banner
 * over a working page, about a convenience that failed, is noise a practice would
 * learn to ignore within a week.
 *
 * What must NEVER happen is the third option: an empty strip, or the sentence
 * "You have not opened any patients yet", printed because a database read threw.
 * That is an outage asserting a fact about the user's own history. The `ok` flag
 * is carried all the way here from the repository, and is checked FIRST and on its
 * own line below, so that anyone adding an empty-state sentence later has to walk
 * past the reason they can only hang it off `ok === true`.
 * ---------------------------------------------------------------------------
 *
 * A plain server component: no "use client", no hooks, no handlers. Real anchors,
 * so cmd-click and "copy link address" work exactly as they do in the table below.
 */
export function RecentPatientsStrip({
  read,
  basePath,
}: {
  read: RecentsRead;
  /** "/c/<client>" or "/owner/<client>", the same prop the table takes, so an
   *  owner clicking a recent patient stays in the owner tree. */
  basePath: string;
}) {
  // A read that FAILED. Nothing is asserted about this user's history. See above.
  if (!read.ok) return null;
  // A read that SUCCEEDED and found nothing: a first-time user, or one who has
  // opened patients only at a site the switcher has scoped away. Also nothing —
  // an empty strip is furniture teaching the reader to ignore that part of the
  // screen before it ever has anything in it.
  if (read.patients.length === 0) return null;

  return (
    <section aria-label="Recently opened patients" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-[11px] font-medium text-faint">Recently opened</span>
      <ul className="flex flex-wrap items-center gap-1.5">
        {/* Capped in selectRecents, not here. The slice would be a second, silent
            copy of a rule that is already decided and tested one module away. */}
        {read.patients.slice(0, RECENTS_LIMIT).map((p) => (
          <li key={p.patientId}>
            <Link
              href={`${basePath}/patients/${encodeURIComponent(p.patientId)}`}
              className="block rounded-lg border border-line bg-card px-2.5 py-1 text-[12px] font-medium text-navy hover:border-line-strong hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            >
              {p.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
