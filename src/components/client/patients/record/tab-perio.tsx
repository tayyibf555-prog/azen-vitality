import { requireUser } from "@/lib/auth/guard";
import { isPerioEnabled, canSavePerio, PERIO_COPY } from "@/lib/perio/gate";
import { latestBpeExam, latestPerioCharts } from "@/lib/perio/repository";
import type { StoredBpeExam, StoredPerioChart } from "@/lib/perio/repository";
import { buildPocketChart, PerioValidationError } from "@/lib/perio/pocket-chart";
import type { PocketChartView } from "@/lib/perio/pocket-chart";
import type { ClinicianRef } from "@/lib/perio/types";
import { PerioShell } from "./perio/perio-shell";

/**
 * The Perio tab's data seam: an async SERVER component, and the only place the
 * reads behind this screen are made. Modelled on tab-chart.tsx, and different
 * from it in exactly one way that changes everything.
 *
 * THE CHART TAB IS A MIRROR. THIS IS NOT. Dentally's API exposes no periodontal
 * resource of any kind — verified, "perio" appears in their documentation only
 * inside the word "period" — so there is nothing here to mirror and no Dentally
 * read to fail soft. Every row this tab shows was AUTHORED in this platform, and
 * the moment PERIO_ENABLED is set this platform becomes the system of record for
 * it while Dentally's own Perio tab still exists and still works. That is why the
 * gate is read first, why nothing below it is reached when the gate is shut, and
 * why the screen still renders in full either way.
 *
 * WITH THE GATE SHUT, NO READ IS MADE AT ALL. Not a read that returns nothing —
 * no read. src/lib/perio/repository.ts THROWS PerioDisabledError rather than
 * returning [], deliberately, because an empty periodontal result renders as
 * "this patient has no periodontal findings", which is indistinguishable from a
 * healthy BPE 0. Catching that throw and passing the empty result on would defeat
 * the one decision the repository exists to enforce, so this component does not
 * call it. The screen renders as a preview and says so.
 *
 * EACH STREAM FAILS SOFT ON ITS OWN, and reports. The BPE and the six-point
 * charts are separate reads against separate tables; one being down must not
 * blank the other, and neither may degrade into an empty result. `bpeFailed` and
 * `chartsFailed` travel to the shell, which prints PERIO_COPY.readFailed —
 * "a failure to read them, not a finding that there are none".
 *
 * A CHART THAT WILL NOT BUILD IS NAMED, NOT DROPPED. buildPocketChart validates
 * and throws rather than returning a half-built chart; a chart quietly missing
 * from this screen is the false-completeness failure again, one level down. The
 * issues come back as sentences the shell prints.
 *
 * IT TAKES nowIso RATHER THAN READING A CLOCK. The entry grid stamps a local
 * preview with the instant the screen was opened; the record itself is stamped by
 * the server on save. Nothing in this feature calls Date.now() in a render path.
 *
 * NO CLINICAL RULE IS IMPLEMENTED HERE. Sextant membership, the highest-code
 * roll-up, what a code 3 or a code 4 demands, coverage, CAL and every comparison
 * come from src/lib/perio/, which is pure and tested. This file reads, reports
 * what failed, and hands plain data to one server-safe shell.
 */
export async function TabPerio({
  clientSlug,
  siteId,
  patientId,
  nowIso,
}: {
  clientSlug: string;
  siteId: string;
  patientId: string;
  nowIso: string;
}) {
  const enabled = isPerioEnabled();
  const canSave = canSavePerio();

  const scope = { siteId, patientId };

  // THE GATE DECIDES WHETHER THERE IS ANYTHING TO READ. See the header: with it
  // shut the repository throws by design, and there is no query worth issuing.
  const [bpe, charts, clinician] = await Promise.all([
    enabled
      ? latestBpeExam(scope).then(
          (exam) => ({ ok: true, exam }),
          (err) => {
            console.error(`[perio] the BPE read threw for patient ${patientId}`, err);
            return { ok: false, exam: null as StoredBpeExam | null };
          },
        )
      : Promise.resolve({ ok: true, exam: null as StoredBpeExam | null }),
    enabled
      ? latestPerioCharts(scope, 2).then(
          (rows) => ({ ok: true, rows }),
          (err) => {
            console.error(`[perio] the chart read threw for patient ${patientId}`, err);
            return { ok: false, rows: [] as StoredPerioChart[] };
          },
        )
      : Promise.resolve({ ok: true, rows: [] as StoredPerioChart[] }),
    resolveClinician(),
  ]);

  // latestPerioCharts orders newest first, so [0] is the standing chart and [1]
  // is what it is compared against.
  const built = charts.rows.map(toView);
  const views = built.filter((b): b is { view: PocketChartView } => "view" in b).map((b) => b.view);
  const chartIssues = built.filter((b): b is { issue: string } => "issue" in b).map((b) => b.issue);

  return (
    <PerioShell
      clientSlug={clientSlug}
      siteId={siteId}
      patientId={patientId}
      enabled={enabled}
      canSave={canSave}
      copy={{
        preview: PERIO_COPY.preview,
        bothRecords: PERIO_COPY.bothRecords,
        disabled: PERIO_COPY.disabled,
        doubleEntry: PERIO_COPY.doubleEntry,
        readFailed: PERIO_COPY.readFailed,
        noAuthor: PERIO_COPY.noAuthor,
        bpeEntryReadOnly: PERIO_COPY.bpeEntryReadOnly,
        saveFailed: PERIO_COPY.saveFailed,
      }}
      // A StoredBpeExam satisfies BpeExamView directly. That is why BpeExamView is
      // the intersection of a stored row and a freshly scored one: mapping between
      // them would be a place for a reading to change on the way past.
      bpeExam={bpe.exam}
      bpeExamId={bpe.exam?.id ?? null}
      bpeFailed={!bpe.ok}
      latestChart={views[0] ?? null}
      previousChart={views[1] ?? null}
      chartsFailed={!charts.ok}
      chartIssues={chartIssues}
      // EMPTY, AND NOT BECAUSE THERE IS NOTHING TO SAY. The engine's notices come
      // out of scoreBpeExam(), which needs a BpeContext — which teeth are present,
      // which carry implants, whether this patient is under periodontal care. None
      // of that is readable from Dentally, and inventing a context to manufacture
      // notices would produce clinical statements from data we do not hold. The
      // standing limits of the instrument are in the legend instead, where they
      // hold regardless of the patient.
      notices={[]}
      // NO presentTeeth, AND THERE IS NONE TO PASS. PerioShell accepts an FDI set
      // for the teeth in the mouth; this tab does not supply one, deliberately,
      // because Dentally exposes no tooth status to read it from — the FDI chart
      // in this same record says so on its own face: "we cannot read tooth
      // status. This chart draws the treatment items Dentally returns, not the
      // dentition itself." Deriving a dentition from treatment items would be a
      // fabricated mouth on a clinical screen, and the fabrication would be
      // invisible.
      //
      // The prop stays for the day the data exists. Until then the shell renders
      // DentitionUnknown, which says out loud that a tooth with no readings may
      // be absent rather than unexamined. An undefined prop with no sentence
      // beside it is how "we do not know" quietly becomes "we checked".
      clinician={clinician}
      openedAt={nowIso}
    />
  );
}

/**
 * The clinician the record would be attributed to, resolved exactly as
 * /api/perio/[action] resolves it — same source, same construction, same null.
 *
 * gdcNumber is null because app_user does not hold one. ClinicianRef allows a
 * null and forbids a fabricated one (GDC 4.1.4), so nothing is invented here. A
 * null clinician does not hide the screen: it refuses authorship, and the shell
 * says why in PERIO_COPY.noAuthor's words.
 */
async function resolveClinician(): Promise<ClinicianRef | null> {
  try {
    const auth = await requireUser();
    if (!auth || auth instanceof Response) return null;
    return { id: auth.id, name: auth.name, gdcNumber: null };
  } catch {
    return null;
  }
}

/**
 * A stored chart as the screen consumes it, or the sentence explaining why it
 * could not be built.
 *
 * buildPocketChart VALIDATES: it throws PerioValidationError rather than
 * returning a chart with the readings it did not understand silently missing. A
 * chart that fails here is therefore a real problem with a stored clinical
 * record, and the one thing that must not happen is for it to vanish off the
 * screen leaving a shorter history that looks complete.
 */
function toView(chart: StoredPerioChart): { view: PocketChartView } | { issue: string } {
  try {
    return {
      view: buildPocketChart({
        id: chart.id,
        siteId: chart.siteId,
        patientId: chart.patientId,
        sextants: chart.sextants,
        teeth: chart.teeth,
        recorded: chart.recorded,
        probe: chart.probe,
        supersedesId: chart.supersedesId,
        amendmentReason: chart.amendmentReason,
      }),
    };
  } catch (error) {
    const detail =
      error instanceof PerioValidationError ? ` ${error.issues.join(" ")}` : "";
    return {
      issue:
        `A six-point chart recorded on ${chart.recorded.at} could not be read and is not shown below. ` +
        `It has not been deleted and it is still on the record.${detail}`,
    };
  }
}
