import type { DentallyClient } from "./client";
import { dentallyAgentClient, isDentallyWriteEnabled, targetsRealDentally } from "./write";
import { getSite } from "@/lib/mock/clients";
import { SYSTEM_BY_SLUG } from "@/lib/systems/catalog";
import { isSystemEnabled, isSystemEnabledStrict, isSystemExplicitlyDisabled } from "@/lib/systems/repository";
import { recordWriteIntent, sanitiseWriteError } from "./sync-ledger";
import {
  DENTALLY_WRITE_MASTER_SLUG,
  DENTALLY_WRITE_SOURCES,
  sanitiseActor,
  summariseWritePayload,
  type BlockedReason,
  type DentallyWriteKind,
  type DentallyWriteMode,
  type DentallyWriteSource,
  type WriteIntentStatus,
} from "./write-vocabulary";

// The registry of who writes, the payload summariser and the kind/status
// vocabulary live in the PURE LEAF ./write-vocabulary (no imports, so a browser
// component can read the same words the server wrote). Re-exported here because
// the gate is the door every caller and every test already knows about.
export {
  DENTALLY_WRITE_MASTER_SLUG,
  DENTALLY_WRITE_SOURCES,
  isLiveDentallyHost,
  sanitiseActor,
  summariseWritePayload,
  targetLabel,
  writeSlugFor,
  type DentallyWriteMode,
  type DentallyWriteSource,
  type WritePayloadSummary,
} from "./write-vocabulary";

// ===========================================================================
// THE WRITE GATE. Every outbound Dentally write in this platform goes through
// this file, and the source crawl in write-gate-sites.test.ts is what keeps that
// true: the five write METHODS on DentallyClient may be named here and nowhere
// else in src/.
//
// It does four things, in this order, for every write:
//
//   1. RESOLVES THE MODE from the environment. Live only when
//      isDentallyWriteEnabled() — which needs DENTALLY_WRITE_ENABLED to be the
//      exact string "true" AND a dedicated write key AND an explicit write base
//      URL. Anything else is a DRY RUN. "TRUE", "1", "yes" and " true" are all
//      dry runs, the same exact-string posture MESSAGING_DRY_RUN has, and for
//      the same reason: a config typo must fail safe, not go live.
//   2. HONOURS THE KILL SWITCH for the module that asked. Each source declares
//      its system_toggle slug (DENTALLY_WRITE_SOURCES below), so switching a
//      system off in the owner's control panel stops its Dentally writes too,
//      not only its messages.
//   3. RECORDS AN INTENT for every single call — including the ones it refuses
//      and the ones it only simulates. That ledger is what lets the practice see
//      what WOULD flow back while the write key does not exist.
//   4. PERFORMS the write, or refuses it, and never lets those two look alike.
//
// ---------------------------------------------------------------------------
// THE ONE INVARIANT WORTH STATING IN ONE SENTENCE:
//
//   a gate call RETURNS a response only when a write actually happened; every
//   other outcome THROWS.
//
// It throws rather than returning a "nothing happened" value because every
// existing call site in this tree is written around a client method that either
// returns a response or throws, and a silent zero-value would be read by all of
// them as a completed booking. Refusing loudly is the only shape that cannot be
// mistaken for success by code that was not rewritten.
// ---------------------------------------------------------------------------
//
// WHAT THIS GATE DOES NOT DO: it does not invent a write path. Dentally supports
// exactly five (patient create/update, appointment create/update/cancel) and
// this file exposes exactly those five. Notes, correspondence, charting and
// consent have NO supported Dentally write, and the reasons are set out in
// ./sync-surface.ts, which is what the Sync Status page renders. Nothing here
// may grow a sixth method without the owner's written decision.
// ===========================================================================

/** The five write methods, as the gate exposes them. */
export type DentallyWriteMethods = Pick<
  DentallyClient,
  "createPatient" | "updatePatient" | "createAppointment" | "updateAppointment" | "cancelAppointment"
>;

/**
 * A client handed to the gate by a caller that already has one.
 *
 * PARTIAL, deliberately. The booking agent's ToolDeps.dentally is a Pick of the
 * seven methods that agent actually uses — five reads and writes it makes, and
 * not updatePatient, which it never calls. Demanding all five here would force
 * that dependency type to claim a capability the agent does not want, which is
 * the wrong direction: a dependency should name what it needs. So the gate asks
 * for the ONE method the write it is making requires, and says so loudly if the
 * injected client does not carry it.
 */
export type InjectableWriteClient = Partial<DentallyWriteMethods>;

/**
 * The method this write needs, bound to the client that carries it.
 *
 * Throws a plain Error rather than recording an intent: an injected client that
 * cannot make the write it was handed is a WIRING mistake, not a runtime
 * condition a practice can act on, and filing it in the practice's sync ledger
 * would put a developer's bug in front of an owner as if it were a fact about
 * their Dentally connection.
 */
function methodOf<K extends keyof DentallyWriteMethods>(
  client: InjectableWriteClient,
  name: K,
): DentallyWriteMethods[K] {
  const fn = client[name];
  if (typeof fn !== "function") {
    throw new Error(
      `[dentally-write-gate] the client handed to this write carries no ${String(name)}. ` +
        "A caller that injects its own client must inject one that can make the write it is asking for.",
    );
  }
  return fn.bind(client) as DentallyWriteMethods[K];
}

/**
 * A write that did not happen. Carries WHY, so the caller and the ledger row it
 * has already produced tell the same story.
 *
 * EVERY refusal is a `blocked` row with a BlockedReason, including the ordinary
 * one — the deployment is not armed (`writes_disabled`). It used to be filed as
 * `dry_run`, which was wrong in a way that mattered: a practice reading the
 * ledger could not tell a write that RAN against the local mock from one that
 * never happened at all. `dry_run` now means exactly one thing — it ran, and not
 * against the real book.
 */
export class DentallyWriteRefused extends Error {
  constructor(
    public reason: BlockedReason,
    message: string,
  ) {
    super(message);
    this.name = "DentallyWriteRefused";
  }
}

// ---------------------------------------------------------------------------
// MODE AND TARGET.
// ---------------------------------------------------------------------------

/**
 * Live only when the deployment has deliberately armed the write path. Delegates
 * to isDentallyWriteEnabled() rather than reading the flag itself, so there is
 * ONE definition of "writes are on" in the tree and this gate cannot drift from
 * the client factory it shares an environment with.
 */
export function dentallyWriteMode(): DentallyWriteMode {
  return isDentallyWriteEnabled() ? "live" : "dry_run";
}

/**
 * WHERE a write would be aimed, resolved from exactly the environment variables
 * dentallyAgentClient() resolves ITS base URL from — so the ledger's `target`
 * is the host the write really used, not a guess.
 *
 * `live` reuses targetsRealDentally, which matches on the HOSTNAME and treats an
 * unparseable URL as real: the safe answer to "I cannot tell where this points"
 * is "assume the live patient book".
 */
export function dentallyWriteTarget(): { host: string; live: boolean } {
  const baseUrl = isDentallyWriteEnabled()
    ? (process.env.DENTALLY_WRITE_BASE_URL ?? "https://api.dentally.co")
    : (process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co");
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = "unknown";
  }
  return { host, live: targetsRealDentally(baseUrl) };
}

// ---------------------------------------------------------------------------
// THE RUNNER.
// ---------------------------------------------------------------------------

export interface DentallyWriteContext {
  /** Which surface is writing. Decides the kill switch. */
  source: DentallyWriteSource;
  /** The internal site id ("site-ng"). The client id is resolved from it. */
  siteId?: string | null;
  /** Overrides the site lookup where the caller already knows the practice. */
  clientId?: string | null;
  /** A user's email/id, or an agent slug. Null where there is no session. */
  actor?: string | null;
  /** The Dentally patient the write is about, where the kind does not carry it. */
  patientId?: string | null;
  /**
   * A pre-built client to use INSTEAD of dentallyAgentClient().
   *
   * It exists for the two paths that must share ONE client with their own reads:
   * the booking agent (its availability read and its booking have to hit the same
   * Dentally instance, or it can offer a slot that does not exist where it books)
   * and the no-show inbound handler, which is handed the webhook's client. Both
   * are given `dentallyAgentClient()` in production, so the client's own
   * read-only latch still applies; what the override buys is that the read and
   * the write cannot disagree about which instance they are talking to.
   *
   * The gate cannot see an injected client's base URL, so it cannot pre-empt a
   * refusal for one; it performs and lets that client's latch throw, which is
   * recorded as blocked/client_read_only rather than as a Dentally failure.
   */
  client?: InjectableWriteClient;
}

interface RunSpec<T> {
  ctx: DentallyWriteContext;
  kind: DentallyWriteKind;
  /** The Dentally id this write targets, where the kind has one. */
  appointmentId?: string | null;
  patientId?: string | null;
  /** The id that MUST be present, named for the refusal message. */
  requires?: { id: string; label: string };
  payload: Record<string, unknown>;
  perform: (client: InjectableWriteClient) => Promise<T>;
  responseId: (result: T) => string | null;
}

/**
 * The Dentally id out of a write's response, defensively.
 *
 * DEFENSIVE ON PURPOSE. A successful PUT or DELETE can come back as 204 with no
 * body, a client double can return nothing at all, and a future Dentally
 * response could nest its id somewhere else. None of those is a failed write,
 * and the ledger must never be the thing that turns a completed booking into a
 * reported failure: an id it cannot find is recorded as absent, not as an error.
 */
function idFrom(value: unknown, key: "patient" | "appointment"): string | null {
  const wrapper = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null;
  const id = wrapper && typeof wrapper === "object" ? (wrapper as Record<string, unknown>).id : null;
  return id === null || id === undefined || id === "" ? null : String(id);
}

/** A DentallyError raised by the client's own read-only latch, not by Dentally. */
function isReadOnlyLatch(err: unknown): boolean {
  return err instanceof Error && /this DentallyClient is read-only/.test(err.message);
}

/**
 * IS THE OWNER'S MASTER DENTALLY WRITE-BACK SWITCH OFF?
 *
 * Exported because the Sync Status screen has to answer the same question, and a
 * screen that told an owner their switch was on while the gate was refusing on
 * the strength of it would be worse than no screen.
 *
 * The question asked depends on what is at stake, and that asymmetry is the whole
 * design:
 *
 *   LIVE       isSystemEnabledStrict — the slug's catalog default (OFF) applies
 *              to a missing row, and an unreadable toggle table fails CLOSED.
 *              Nobody's absent row may arm writes against 51,000 real records.
 *   SIMULATED  isSystemExplicitlyDisabled — only a row that says false counts.
 *              The deployment is not armed, nothing can reach a real book, and
 *              reading the absent row as off would merely stop the local mock
 *              working on every developer's machine and in the whole test suite.
 */
export async function isDentallyWriteMasterOff(
  clientId: string,
  mode: DentallyWriteMode = dentallyWriteMode(),
): Promise<boolean> {
  return mode === "live"
    ? !(await isSystemEnabledStrict(clientId, DENTALLY_WRITE_MASTER_SLUG))
    : isSystemExplicitlyDisabled(clientId, DENTALLY_WRITE_MASTER_SLUG);
}

/** Everything the ledger records about one attempt, before its outcome is known. */
interface IntentBase {
  clientId: string;
  siteId: string | null;
  kind: DentallyWriteKind;
  source: string;
  moduleSlug: string | null;
  dentallyPatientId: string | null;
  dentallyAppointmentId: string | null;
  target: string;
  payloadSummary: Record<string, unknown>;
  actor: string | null;
}

interface GateDecision {
  base: IntentBase;
  mode: DentallyWriteMode;
  target: { host: string; live: boolean };
  /** Null when the gate is open. */
  refusal: { reason: BlockedReason; message: string } | null;
}

/**
 * THE POLICY, IN ONE PLACE.
 *
 * Both doors into the gate run this and nothing else: `runWrite`, which is about
 * to make the write, and `precheckDentallyWrite`, which routes call to refuse
 * BEFORE they spend a Dentally availability read on a booking that cannot happen.
 * Two implementations of "may this write go?" is how the two answers eventually
 * disagree, so there is one.
 *
 * It records nothing and throws nothing — the caller decides what to do with the
 * verdict, which is what keeps exactly ONE ledger row per action rather than one
 * per check.
 *
 * ORDER MATTERS, and it is the order of who is responsible:
 *   1. the request itself (is there a record to write to at all?)
 *   2. the OWNER's master switch over everything Dentally
 *   3. the owner's switch on the module that asked
 *   4. the AGENCY's deployment arming (DENTALLY_WRITE_*)
 * so the reason a practice reads is the one nearest to them and the one they can
 * act on. With the deployment unarmed today, rows read `writes_disabled` — the
 * honest answer, rather than blaming a switch the owner has not been given a
 * reason to touch yet.
 */
async function evaluateGate(
  ctx: DentallyWriteContext,
  kind: DentallyWriteKind,
  ids: { appointmentId?: string | null; patientId?: string | null; requires?: { id: string; label: string } },
  payload: Record<string, unknown>,
): Promise<GateDecision> {
  const def = DENTALLY_WRITE_SOURCES[ctx.source];
  const siteId = ctx.siteId ?? null;
  const clientId = ctx.clientId ?? (siteId ? (getSite(siteId)?.clientId ?? null) : null);
  const mode = dentallyWriteMode();
  const target = dentallyWriteTarget();

  const base: IntentBase = {
    clientId: clientId ?? "unknown",
    siteId,
    kind,
    source: ctx.source as string,
    moduleSlug: def.slug,
    dentallyPatientId: ids.patientId ?? ctx.patientId ?? null,
    dentallyAppointmentId: ids.appointmentId ?? null,
    target: target.host,
    payloadSummary: summariseWritePayload(payload) as unknown as Record<string, unknown>,
    // An opaque id or an agent slug. sanitiseActor is the braces on the belt:
    // the call sites pass auth?.id and a source crawl fails if one ever passes
    // an email, and anything address-shaped that got through anyway is redacted
    // here rather than stored.
    actor: sanitiseActor(ctx.actor),
  };
  const open: GateDecision = { base, mode, target, refusal: null };
  const refuse = (reason: BlockedReason, message: string): GateDecision => ({ ...open, refusal: { reason, message } });

  // 1. A write with no target is refused HERE rather than sent as a request to
  //    `/v1/appointments/` — a path that means something else entirely.
  if (ids.requires && !ids.requires.id) {
    return refuse(
      "invalid_target",
      `Refusing ${kind}: no ${ids.requires.label} was given, so there is no Dentally record to write to.`,
    );
  }

  // 2. THE MASTER SWITCH over everything this platform writes to Dentally.
  //
  //    The question asked depends on what is at stake. LIVE: isSystemEnabledStrict,
  //    where the slug's catalog default (OFF) applies to a missing row and an
  //    unreadable table fails closed — nobody's absent row may arm writes against
  //    51,000 real patient records. SIMULATED: only an EXPLICIT disable counts,
  //    because the deployment is not armed, nothing can reach a real book, and
  //    reading the absent row as off would merely stop the local mock working.
  if (await isDentallyWriteMasterOff(base.clientId, mode)) {
    return refuse(
      "master_off",
      `Refusing ${kind}: Dentally write-back is switched off in System controls.`,
    );
  }

  // 3. THE KILL SWITCH, for the module that asked.
  //
  //    The fail direction follows the mode, exactly as isSystemEnabledForSend
  //    ties its own to the messaging dry-run flag: while writes are simulated a
  //    toggle-read blip must not halt local development, and the moment they are
  //    LIVE an unreadable switch counts as OFF — a skipped write self-heals on
  //    the next click, a write made against an owner's explicit instruction does
  //    not.
  if (def.slug) {
    const enabled =
      mode === "live"
        ? await isSystemEnabledStrict(base.clientId, def.slug)
        : await isSystemEnabled(base.clientId, def.slug);
    if (!enabled) {
      return refuse(
        "system_off",
        `Refusing ${kind}: ${SYSTEM_BY_SLUG.get(def.slug)?.label ?? def.slug} is switched off in System controls.`,
      );
    }
  }

  // 4. THE DEPLOYMENT ARMING. With writes off and the target being the live
  //    practice book, NOTHING is constructed and nothing is called. The attempt
  //    is recorded as BLOCKED / writes_disabled — this is what staff tried to
  //    send to Dentally while write-back was off — and it is deliberately NOT
  //    `queued`: nothing here will ever be replayed, automatically or otherwise,
  //    and a status that implies a pending delivery would be a promise the
  //    platform has not made. `queued` keeps its meaning (a write the gate WILL
  //    perform once the key exists) and has no producer, which is honest.
  //
  //    An injected client is the one case the gate cannot pre-empt (it cannot see
  //    that client's base URL), so it falls through to the perform and the
  //    client's own read-only latch does the refusing.
  if (mode !== "live" && target.live && !ctx.client) {
    return refuse(
      "writes_disabled",
      `Writing back to Dentally is switched off. The ${kind} was recorded as an intent and nothing was sent.`,
    );
  }

  return open;
}

/** File the refusal, then raise it. Record first, refuse second — always. */
async function recordAndRefuse(decision: GateDecision): Promise<DentallyWriteRefused> {
  const { reason, message } = decision.refusal!;
  await recordWriteIntent({ ...decision.base, status: "blocked", blockedReason: reason });
  return new DentallyWriteRefused(reason, message);
}

/**
 * ASK THE GATE WHETHER IT WOULD WRITE, AND RECORD THE REFUSAL IF IT WOULD NOT.
 *
 * Returns null when the gate is open, so the caller carries on; returns the
 * refusal (already filed in the ledger) when it is shut.
 *
 * WHY THE ROUTES NEED THIS AND CANNOT SIMPLY CALL THE WRITE. Six staff paths
 * refuse a booking BEFORE they build a payload and spend a live Dentally
 * availability read on it, and that ordering is deliberate and worth keeping.
 * But refusing early used to mean the attempt vanished — a receptionist clicked
 * "Book", got a polite 503 and nothing anywhere recorded that the practice had
 * tried to put an appointment into Dentally. Now the attempt is filed first and
 * the route returns the same message it always did.
 *
 * It shares evaluateGate with the write itself, so a precheck can never say yes
 * to something the write would refuse. It records at most ONE row: if it passes,
 * the write that follows files the row for the actual attempt.
 */
export async function precheckDentallyWrite(input: {
  ctx: DentallyWriteContext;
  kind: DentallyWriteKind;
  /** What the write would carry, for the ledger summary. Optional. */
  payload?: Record<string, unknown>;
  appointmentId?: string | null;
  patientId?: string | null;
}): Promise<DentallyWriteRefused | null> {
  const decision = await evaluateGate(
    input.ctx,
    input.kind,
    { appointmentId: input.appointmentId, patientId: input.patientId },
    input.payload ?? {},
  );
  if (!decision.refusal) return null;
  return recordAndRefuse(decision);
}

async function runWrite<T>(spec: RunSpec<T>): Promise<T> {
  const decision = await evaluateGate(
    spec.ctx,
    spec.kind,
    { appointmentId: spec.appointmentId, patientId: spec.patientId, requires: spec.requires },
    spec.payload,
  );
  const { base, mode } = decision;
  if (decision.refusal) throw await recordAndRefuse(decision);

  // Perform. `sent` means it went to the live practice book; a write that only
  // reached the local mock is a `dry_run` with a response, never a `sent`.
  const client = spec.ctx.client ?? dentallyAgentClient();
  const status: WriteIntentStatus = mode === "live" ? "sent" : "dry_run";
  try {
    const result = await spec.perform(client);
    await recordWriteIntent({ ...base, status, responseId: spec.responseId(result) });
    return result;
  } catch (err) {
    if (isReadOnlyLatch(err)) {
      // Not a Dentally failure: our own latch refused before any request. Recorded
      // as blocked so a practice reading the ledger is not told Dentally rejected
      // something Dentally never saw. The ORIGINAL error is rethrown, so every
      // existing catch block behaves exactly as it did before the gate existed.
      await recordWriteIntent({ ...base, status: "blocked", blockedReason: "client_read_only" });
      throw err;
    }
    await recordWriteIntent({ ...base, status: "failed", error: sanitiseWriteError(err) });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// THE FIVE DOORS.
//
// Each returns EXACTLY what the client method returns, so a call site is a
// one-line substitution and every existing `const { appointment } = await ...`
// keeps working. Each throws when no write happened.
// ---------------------------------------------------------------------------

export const dentallyWrite = {
  createPatient(
    ctx: DentallyWriteContext,
    payload: Record<string, unknown>,
  ): Promise<{ patient: { id: string } }> {
    return runWrite({
      ctx,
      kind: "patient.create",
      payload,
      perform: (c) => methodOf(c, "createPatient")(payload),
      responseId: (r) => idFrom(r, "patient"),
    });
  },

  updatePatient(
    ctx: DentallyWriteContext,
    patientId: string,
    fields: Record<string, unknown>,
  ): Promise<{ patient: { id: string; active?: boolean } }> {
    return runWrite({
      ctx,
      kind: "patient.update",
      patientId,
      requires: { id: patientId, label: "patient id" },
      payload: fields,
      perform: (c) => methodOf(c, "updatePatient")(patientId, fields),
      responseId: (r) => idFrom(r, "patient"),
    });
  },

  createAppointment(
    ctx: DentallyWriteContext,
    payload: Record<string, unknown>,
  ): Promise<{ appointment: { id: string } }> {
    return runWrite({
      ctx,
      kind: "appointment.create",
      patientId: typeof payload.patient_id === "string" ? payload.patient_id : null,
      payload,
      perform: (c) => methodOf(c, "createAppointment")(payload),
      responseId: (r) => idFrom(r, "appointment"),
    });
  },

  updateAppointment(
    ctx: DentallyWriteContext,
    appointmentId: string,
    payload: Record<string, unknown>,
  ): Promise<{ appointment: { id: string; start_time?: string; state?: string } }> {
    return runWrite({
      ctx,
      kind: "appointment.update",
      appointmentId,
      requires: { id: appointmentId, label: "appointment id" },
      payload,
      perform: (c) => methodOf(c, "updateAppointment")(appointmentId, payload),
      responseId: (r) => idFrom(r, "appointment"),
    });
  },

  cancelAppointment(
    ctx: DentallyWriteContext,
    appointmentId: string,
  ): Promise<{ appointment: { id: string; state?: string } }> {
    return runWrite({
      ctx,
      kind: "appointment.cancel",
      appointmentId,
      requires: { id: appointmentId, label: "appointment id" },
      payload: {},
      perform: (c) => methodOf(c, "cancelAppointment")(appointmentId),
      responseId: (r) => idFrom(r, "appointment"),
    });
  },
};
