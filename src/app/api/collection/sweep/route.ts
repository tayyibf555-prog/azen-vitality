import { DentallyBudgetExceededError } from "@/lib/dentally/client";
import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabled } from "@/lib/systems/repository";
import { SITES, getSite } from "@/lib/mock/clients";
import { listOutstandingDetailed, listPatients, type PatientRecord } from "@/lib/dentally/read";
import { loadExcludedTargetKeys, excludedTargetKey } from "@/lib/patient-status/repository";
import { isSuppressed } from "@/lib/messaging/suppression";
import {
  decideCollectionAction,
  type CollectionTargetFacts,
} from "@/lib/collection/cadence";
import {
  poundsToPence,
  refusalNeedsAPerson,
  summariseBalance,
  verifyBalance,
  type BalanceRefusal,
} from "@/lib/collection/balance";
import { readPatientInvoices } from "@/lib/collection/read";
import { draftCollectionMessage } from "@/lib/collection/draft";
import {
  listStatesByPatient,
  listInboundBodiesByPatient,
  insertDraft,
  stopTarget,
  settleTarget,
  escalate,
  coolOff,
} from "@/lib/collection/repository";
import { collectionConfig, type CollectionEscalationReason } from "@/lib/collection/types";

// ===========================================================================
// THE OUTSTANDING-BALANCE COLLECTION SWEEP.
//
// It DRAFTS. It never queues, never sends, and there is no configuration that
// could make it. Its response always reports `queued: 0`, and if that number is
// ever anything else the sweep has grown a send path it must not have.
//
// WHAT IT READS, AND WHY IT READS THE SAME MONEY TWICE.
//
// R1, the population: listOutstandingDetailed — the practice-wide unpaid-invoice
//     scan the Payments page already runs, shared with it through the same 60s
//     cache entry, so on a normal tick this costs nothing extra. It answers "who
//     might owe something", and it is not good enough to answer anything else: it
//     is cached, it is bounded by a page cap, and its money reader is deliberately
//     permissive (an unknown status counts as owed, an absent balance is inferred
//     from gross minus paid).
//
// R2, the verification: readPatientInvoices — a fresh, narrow read of ONE
//     patient's own invoices, parsed by the strict reader in lib/collection/balance,
//     which refuses rather than infers. Taken only for candidates that have already
//     passed every cheap gate, and hard-capped per run.
//
// The two must agree to the penny. When they do not, nothing is drafted. That is
// the mechanical form of the rule this whole module is built on: NEVER TELL A
// PATIENT THEY OWE MONEY THE DATA CANNOT PROVE.
//
// Both reads run at BACKGROUND priority: nobody is waiting on this, and the front
// desk is using the same 3,600/hour Dentally quota.
// ===========================================================================

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLIENT_ID = "vitality";

function vitalitySiteIds(): string[] {
  return SITES.filter((s) => s.clientId === CLIENT_ID).map((s) => s.id);
}

/**
 * The payment link a draft may offer, or null so the ask becomes "reply to this".
 *
 * Deliberately NOT falling back to the booking URL the closer uses. Sending a
 * patient to a booking page to settle an invoice is sending them somewhere that
 * cannot do the thing the message just asked them to do, and it would read as the
 * practice trying to get another appointment out of the conversation.
 */
function paymentLink(): string | null {
  const explicit = (process.env.COLLECTION_PAYMENT_URL ?? "").trim();
  return explicit.startsWith("https://") ? explicit : null;
}

function patientToRef(patientId: string): string {
  return `patient:${patientId}`;
}

/** The escalation a balance refusal raises, or null when it needs no person. */
function escalationForRefusal(refusal: BalanceRefusal): CollectionEscalationReason | null {
  switch (refusal) {
    case "credit_on_account":
      return "credit_on_account";
    case "above_ceiling":
      return "balance_above_ceiling";
    case "unreadable_invoice":
      return "unreadable_invoice";
    default:
      return null;
  }
}

async function handleWithDentallyPriority(request: Request): Promise<Response> {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  // KILL SWITCH, FIRST AND FAIL-CLOSED FOR THIS SLUG.
  //
  // 'balance-reminders' is declared defaultEnabled:false in the systems catalog,
  // so isSystemEnabled resolves the ABSENCE of a system_toggle row to DISABLED,
  // and resolves a toggle-read ERROR to disabled too. For every other module an
  // absent row means ON; a brand new surface that messages patients about money
  // must never be armed by a row nobody wrote or by a database blip.
  if (!(await isSystemEnabled(CLIENT_ID, "balance-reminders"))) {
    return Response.json({ ok: true, skipped: "system off" });
  }

  // Never overlap: two runs would see the same debtors and draft twice for the
  // same patient. The lease outlives maxDuration (300s) so a slow run cannot have
  // the next tick start underneath it; a crashed run self-heals when it expires.
  if (!(await acquireCronLock("sweep-collection", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const now = new Date();
    const config = collectionConfig();
    const siteIds = vitalitySiteIds();

    // R1. Shares the Payments page's own cache entry, so a tick that lands inside
    // the TTL costs nothing at all.
    const read = await listOutstandingDetailed(siteIds);
    if (read.truncated) {
      // Not fatal, and deliberately not treated as one: a truncated scan UNDER-lists
      // debtors, so every row it did return is still a real candidate and the only
      // cost is that some debtors are not looked at this tick. The opposite failure
      // (a row that should not be there) is what would matter, and truncation cannot
      // produce it.
      console.warn(
        "[collection] the debtors scan reported truncation; some patients will not be examined this run",
      );
    }

    const candidates = read.rows.slice(0, config.maxExaminedPerRun);
    const patientIds = candidates.map((r) => r.patientId);

    const [patients, states, inbound, excludedKeys] = await Promise.all([
      // The same cached book the debtors scan itself resolves names from, so this is
      // not a second walk of the patient index. It is the only source of the CONSENT
      // flags: an OutstandingRecord carries a name and a balance and nothing about
      // whether the patient agreed to be contacted.
      listPatients(siteIds),
      listStatesByPatient(patientIds),
      listInboundBodiesByPatient(patientIds),
      loadExcludedTargetKeys(),
    ]);
    const byId = new Map<string, PatientRecord>(patients.map((p) => [p.id, p]));

    const link = paymentLink();
    let examined = 0;
    let drafted = 0;
    let stopped = 0;
    let skipped = 0;
    let verified = 0;
    let refused = 0;
    let escalated = 0;
    let verifyReads = 0;
    const stopReasons: Record<string, number> = {};
    const skipReasons: Record<string, number> = {};
    const balanceRefusals: Record<string, number> = {};
    const draftRefusals: Record<string, number> = {};

    for (const row of candidates) {
      if (drafted >= config.maxDraftsPerRun) break;
      if (verifyReads >= config.maxVerifyReadsPerRun) break;
      examined += 1;

      const patient = byId.get(row.patientId);
      if (!patient) {
        // The debtors scan resolved this patient (it drops any it could not), so a
        // miss here means the cached book and the scan disagree. Never guess consent.
        skipped += 1;
        skipReasons.patient_unresolved = (skipReasons.patient_unresolved ?? 0) + 1;
        continue;
      }

      const state = states.get(row.patientId) ?? null;
      const target: CollectionTargetFacts = {
        patientId: row.patientId,
        siteId: patient.siteId,
        active: patient.active,
        consent: { sms: patient.smsConsent, email: patient.emailConsent },
      };
      const toRef = patientToRef(row.patientId);

      // The decider needs to know whether this patient is already opted out. A cheap
      // pre-check on BOTH channels rather than guessing the step first: an opt-out on
      // either channel is treated as an opt-out from this module entirely, which is
      // the right reading for a message about money.
      let suppressed = false;
      try {
        suppressed =
          (await isSuppressed(target.siteId, "sms", toRef)) ||
          (await isSuppressed(target.siteId, "email", toRef));
      } catch {
        // A suppression read that throws must NEVER be read as "not opted out".
        skipped += 1;
        skipReasons.suppression_unavailable = (skipReasons.suppression_unavailable ?? 0) + 1;
        continue;
      }

      const decision = decideCollectionAction({
        target,
        state,
        inboundBodies: inbound.get(row.patientId) ?? [],
        excluded: excludedKeys.has(excludedTargetKey(target.siteId, row.patientId)),
        suppressed,
        now,
        config,
      });

      if (decision.action === "stop") {
        await stopTarget(row.patientId, target.siteId, decision.reason, decision.escalate, now);
        stopped += 1;
        stopReasons[decision.reason] = (stopReasons[decision.reason] ?? 0) + 1;
        if (decision.escalate) escalated += 1;
        continue;
      }

      if (decision.action === "skip") {
        skipped += 1;
        skipReasons[decision.reason] = (skipReasons[decision.reason] ?? 0) + 1;
        continue;
      }

      // ---------------------------------------------------------------------
      // R2. Everything above was free; this is a live Dentally read, and it only
      // happens for a patient a message is genuinely due for.
      // ---------------------------------------------------------------------
      verifyReads += 1;
      let invoiceRows: Array<Record<string, unknown>>;
      let truncated: boolean;
      try {
        const invoices = await readPatientInvoices(row.patientId);
        invoiceRows = invoices.rows;
        truncated = invoices.truncated;
      } catch (err) {
        // A budget refusal ends the RUN. Continuing would ask, once per debtor, for
        // reads the platform has already declined to make, and every ask still costs
        // the practice's shared counter. Anything else is this one patient's problem.
        if (err instanceof DentallyBudgetExceededError) throw err;
        console.error(`[collection] verification read failed for ${row.patientId}; skipping`, err);
        skipped += 1;
        skipReasons.verify_failed = (skipReasons.verify_failed ?? 0) + 1;
        await coolOff(
          row.patientId,
          target.siteId,
          new Date(now.getTime() + config.cooldownHours * 3_600_000),
        );
        continue;
      }

      // A TRUNCATED HISTORY IS AN UNREADABLE ONE. We have not seen this account, so
      // any total over it is a floor, and a floor is not a fact about somebody's
      // finances. Routed through the same refusal a bad invoice takes.
      const summary = truncated
        ? { ...summariseBalance(invoiceRows), unreadableCount: 1 }
        : summariseBalance(invoiceRows);

      const verdict = verifyBalance({
        summary,
        snapshotPence: poundsToPence(row.outstanding),
        now,
        config,
      });

      if (!verdict.ok) {
        balanceRefusals[verdict.refusal] = (balanceRefusals[verdict.refusal] ?? 0) + 1;

        // The balance is gone. The conversation is over and is reset, so a future
        // invoice is a fresh conversation rather than a patient permanently excluded
        // for having paid. See settleTarget.
        if (verdict.refusal === "no_provable_debt") {
          await settleTarget(
            row.patientId,
            target.siteId,
            new Date(now.getTime() + config.cooldownHours * 3_600_000),
          );
          stopped += 1;
          stopReasons.balance_cleared = (stopReasons.balance_cleared ?? 0) + 1;
          continue;
        }

        // The practice may owe THEM. That is not a collection matter at all, and it
        // is the one refusal that ends the conversation rather than pausing it.
        if (verdict.refusal === "credit_on_account") {
          await stopTarget(row.patientId, target.siteId, "credit_on_account", "credit_on_account", now);
          stopped += 1;
          escalated += 1;
          stopReasons.credit_on_account = (stopReasons.credit_on_account ?? 0) + 1;
          continue;
        }

        // Everything else waits. Raise the work item ONCE (re-stamping every tick
        // would make "flagged since" meaningless) and cool the patient off, so a
        // patient whose account we cannot read costs one verification read a day.
        const needsPerson = refusalNeedsAPerson(verdict.refusal);
        if (needsPerson && !state?.escalatedAt) {
          const reason = escalationForRefusal(verdict.refusal);
          if (reason) {
            await escalate(row.patientId, target.siteId, reason, now);
            escalated += 1;
          }
        }
        await coolOff(
          row.patientId,
          target.siteId,
          new Date(now.getTime() + config.cooldownHours * 3_600_000),
        );
        continue;
      }

      verified += 1;

      const result = await draftCollectionMessage(
        { siteId: target.siteId, patientName: patient.name, balance: verdict.balance },
        decision.step,
        { paymentLink: link, practiceName: getSite(target.siteId)?.name ?? "" },
      );

      if (!result.ok) {
        // A refused draft is NOT stored. Nothing about a message that broke a rule
        // should exist anywhere a human could approve it from. Cool the patient off
        // so a systematically-refusing account cannot burn AI budget every tick.
        refused += 1;
        draftRefusals[result.category] = (draftRefusals[result.category] ?? 0) + 1;
        console.warn(
          `[collection] refused a draft for ${row.patientId} (${result.category}: ${result.detail}); nothing stored`,
        );
        await coolOff(
          row.patientId,
          target.siteId,
          new Date(now.getTime() + config.cooldownHours * 3_600_000),
        );
        continue;
      }

      // DRAFT ONLY. insertDraft writes collection_touch and moves the state to
      // awaiting_approval. It does not write collection_outbox, and no other path
      // in this route does either.
      await insertDraft({
        patientId: row.patientId,
        siteId: target.siteId,
        step: decision.step.step,
        channel: decision.step.channel,
        body: result.body,
        amountPence: result.amountPence,
      });
      drafted += 1;
    }

    return Response.json({
      ok: true,
      examined,
      verifyReads,
      verified,
      drafted,
      stopped,
      skipped,
      refused,
      escalated,
      queued: 0, // this module never queues: approval is the only route to the outbox
      truncatedScan: read.truncated,
      stopReasons,
      skipReasons,
      balanceRefusals,
      draftRefusals,
    });
  } finally {
    await releaseCronLock("sweep-collection");
  }
}

// Scheduled work: nobody is waiting on this run, so it takes the practice's shared
// Dentally quota at BACKGROUND priority and is starved first. Unlike the closer's
// sweep, this one genuinely does read Dentally (the per-patient verification), so
// the classification is load-bearing rather than declarative.
export async function POST(request: Request): Promise<Response> {
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}

// pg_cron / Vercel Cron trigger with GET; same handler.
export const GET = POST;
