import { getClient, getSites, getSite, dentallySiteId } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getSubmission, setStatus } from "@/lib/onboarding/repository";
import { searchPatients, type PatientRecord } from "@/lib/dentally/read";
import { dentallyAgentClient, isDentallyWriteEnabled } from "@/lib/dentally/write";
import { DentallyError } from "@/lib/dentally/client";
import { REGISTER_WRITES_OFF } from "@/lib/onboarding/register-result";
import { toE164, normaliseEmail } from "@/lib/messaging/phone";
import { ageFromDob } from "@/lib/patient/demographics";
// The ONE live-calibrated derivation of a new Dentally patient, shared with the
// booking funnel, the 24/7 agent and the owner co-pilot. See patient-payload.ts.
import {
  TITLES,
  knownTitle,
  canonicalDob,
  knownPaymentPlanId,
  buildPatientRegistration,
} from "@/lib/dentally/patient-payload";

export const dynamic = "force-dynamic";

// POST /api/onboarding/register  body { submissionId, force? }
//
// The ONE-CLICK, human-approved action that takes a reviewed onboarding submission and
// creates the patient for real in Dentally. This is the ONLY path that creates a
// Dentally patient from an onboarding submission: the public submit endpoint
// (/api/onboarding/submit) never does, and the plain status flip (/api/onboarding/status)
// never does either. A staff member clicking "Register in Dentally" in the worklist
// (after the UI's own confirm dialogue, which summarises every field that will be
// created) IS the approval — so, unlike the co-pilot's MODEL-invoked create_patient tool
// (which needs its own server-side preview/confirm gate because an LLM calls it), there
// is no separate preview step here: the first call either finds a likely duplicate (and
// creates nothing) or creates immediately.
//
// Mirrors the co-pilot's create_patient discipline exactly (src/lib/copilot/tools.ts,
// left UNTOUCHED — its helpers are not exported, so the same primitives are wired up
// directly here): dedupe-first with the SAME strict match test (exact E.164 mobile,
// exact normalised email, or identical name + date of birth), the SAME gated write
// client (dentallyAgentClient + isDentallyWriteEnabled), the SAME honest 403/422
// mapping, a single write, never auto-retried.
//
// Auth mirrors /api/onboarding/status: requireUser + requireClientAccess. The body here
// carries only a submissionId (no clientSlug), so the client is resolved from the
// LOADED submission rather than up front; requireClientAccess is still the same guard,
// called the same way, once we know which client owns the row.

interface LikelyMatch {
  id: string;
  name: string;
  dateOfBirth: string | null;
  siteId: string;
  matchedOn: string;
}

/**
 * DEDUPE. The SAME server-side Dentally search the co-pilot's create_patient uses
 * (searchPatients -> Dentally `query=`), fanned out over the phone, the email and the
 * name, then the SAME strict match test so a broad text hit never wrongly blocks a
 * genuinely new patient:
 *   - exact mobile (normalised both sides), OR
 *   - exact email (normalised both sides), OR
 *   - identical full name AND identical date of birth.
 * `dob` may be "" when this practice's form never captured one; the name+dob branch is
 * then naturally inert (no real Dentally record has an empty date of birth).
 */
async function findLikelyExistingPatient(
  siteIds: string[],
  cand: { name: string; dob: string; phone: string | null; email: string | null },
): Promise<LikelyMatch | null> {
  const seen = new Map<string, PatientRecord>();
  const queries: string[] = [];
  if (cand.phone) queries.push(cand.phone);
  if (cand.email) queries.push(cand.email);
  queries.push(cand.name);
  for (const q of queries) {
    // searchPatients returns [] for a query under 2 chars, so short/blank ones are inert.
    const rows = await searchPatients(siteIds, q);
    for (const r of rows) seen.set(r.id, r);
  }
  const nameLc = cand.name.toLowerCase();
  for (const p of seen.values()) {
    if (cand.phone && p.phone && toE164(p.phone) === cand.phone) {
      return { id: p.id, name: p.name, dateOfBirth: p.dateOfBirth, siteId: p.siteId, matchedOn: "the same mobile number" };
    }
    if (cand.email && p.email && normaliseEmail(p.email) === cand.email) {
      return { id: p.id, name: p.name, dateOfBirth: p.dateOfBirth, siteId: p.siteId, matchedOn: "the same email address" };
    }
    if (p.name.toLowerCase() === nameLc && p.dateOfBirth && p.dateOfBirth.slice(0, 10) === cand.dob) {
      return { id: p.id, name: p.name, dateOfBirth: p.dateOfBirth, siteId: p.siteId, matchedOn: "the same name and date of birth" };
    }
  }
  return null;
}

const siteName = (id: string) => getSite(id)?.name ?? id;

export async function POST(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return Response.json({ ok: false, error: "Request body must be valid JSON" }, { status: 400 });
  }

  const submissionId = typeof body.submissionId === "string" ? body.submissionId.trim() : "";
  const force = body.force === true;
  if (!submissionId) {
    return Response.json({ ok: false, error: "Missing submission id" }, { status: 400 });
  }

  const submission = await getSubmission(submissionId);
  if (!submission) return Response.json({ ok: false, error: "Not found" }, { status: 404 });

  const client = getClient(submission.clientId);
  if (!client) return Response.json({ ok: false, error: "Unknown client" }, { status: 404 });

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // Onboarding is outside CLINICIAN_SLUGS: reviewing and registering new-patient
  // submissions (contact details, medical intake, uploaded documents, consent) is
  // reception work, and requireClientAccess admits every role attached to the client.
  const moduleDenied = requireModuleApiAccess(auth, "onboarding");
  if (moduleDenied) return moduleDenied;
  // THE PER-PERSON GATE. Registering a submission CREATES A PATIENT IN DENTALLY —
  // a record in the practice's clinical system that cannot be unmade from here.
  // Reaching the Onboarding module is reception work; creating the record is a
  // decision the practice may want to keep with named people.
  const capabilityDenied = await requireCapability(auth, "patient.create");
  if (capabilityDenied) return capabilityDenied;

  // Idempotency: a submission already registered is never re-created (a stray double
  // click or a replayed request must not create a second Dentally patient).
  if (submission.status === "registered") {
    return Response.json(
      { ok: false, error: "This submission has already been registered." },
      { status: 409 },
    );
  }

  // ---- Minimums. NEVER invent a missing detail: an absent/bad field returns an honest
  // error naming exactly what is missing, so staff can go back to the patient for it.
  const firstName = (submission.firstName ?? "").trim();
  const lastName = (submission.lastName ?? "").trim();
  if (!firstName || !lastName) {
    return Response.json(
      {
        ok: false,
        error:
          "This submission is missing a first or last name, so a patient cannot be created. Ask the patient to complete their name first.",
      },
      { status: 400 },
    );
  }

  const phoneRaw = (submission.phone ?? "").trim();
  const emailRaw = (submission.email ?? "").trim();
  const phone = phoneRaw ? toE164(phoneRaw) : null;
  const email = emailRaw ? normaliseEmail(emailRaw) : null;
  if (phoneRaw && !phone) {
    return Response.json(
      {
        ok: false,
        error: `The mobile number on file ("${phoneRaw}") does not look valid. Check it with the patient before registering them.`,
      },
      { status: 400 },
    );
  }
  if (emailRaw && !email) {
    return Response.json(
      {
        ok: false,
        error: `The email address on file ("${emailRaw}") does not look valid. Check it with the patient before registering them.`,
      },
      { status: 400 },
    );
  }
  if (!phone && !email) {
    return Response.json(
      {
        ok: false,
        error:
          "This submission has no valid mobile number or email address, so a patient cannot be created. Ask the patient for a way to contact them.",
      },
      { status: 400 },
    );
  }

  // ---- Date of birth. REQUIRED, and the comment that used to sit here was wrong.
  //
  // It read: "Dentally does not require one to create a patient", and pointed at
  // register_patient in src/lib/agent/tools.ts as precedent for omitting it. Live
  // Dentally refuses a registration with no date_of_birth ("seems to be missing",
  // DENTALLY.md; memory dentally-createpatient-422) — and register_patient was not
  // precedent, it was the same bug in another file. Both are fixed; this is the
  // corrected reading.
  //
  // A submission with no date of birth (a form whose question was disabled, or a
  // legacy row) can therefore never be registered as it stands. We say so plainly
  // rather than sending a doomed write: the practice goes back to the patient for it.
  const dobRaw = (submission.dateOfBirth ?? "").trim();
  const canonicalDateOfBirth = canonicalDob(dobRaw);
  const age = canonicalDateOfBirth ? ageFromDob(canonicalDateOfBirth, new Date()) : null;
  if (!dobRaw) {
    return Response.json(
      {
        ok: false,
        error:
          "This submission has no date of birth, and Dentally will not create a patient without one. Ask the patient for it, or add the date-of-birth question to this onboarding form.",
      },
      { status: 400 },
    );
  }
  if (!canonicalDateOfBirth || age === null || age > 120) {
    return Response.json(
      {
        ok: false,
        error: `The date of birth on file ("${dobRaw}") is not a valid past date. Check it with the patient before registering them.`,
      },
      { status: 400 },
    );
  }
  const dob: string = canonicalDateOfBirth;

  // ---- Title and funding: THE TWO FIELDS THE FORM DOES NOT ASK FOR, and which live
  // Dentally will not create a patient without.
  //
  // They come from the STAFF MEMBER, in the request body, not from the submission —
  // deliberately. This route is reached by a person clicking "Register in Dentally"
  // in the worklist after a confirm dialogue, and how a patient is to be seen is the
  // practice's decision, not something to infer from a marketing form or default
  // silently. The dialogue collects both and sends them here; both are re-validated
  // against the same whitelists the public funnel uses, because a body field is a
  // body field however trusted the caller.
  //
  // Sex is NOT asked for: it is derived from the title exactly as the booking funnel
  // derives it, and the dialogue shows the staff member what will be saved.
  const title = knownTitle(typeof body.title === "string" ? body.title : undefined);
  if (!title) {
    return Response.json(
      {
        ok: false,
        error: `Choose a title (${TITLES.join(", ")}) before registering this patient. Dentally will not create a patient without one.`,
      },
      { status: 400 },
    );
  }
  const paymentPlanId = knownPaymentPlanId(typeof body.funding === "string" ? body.funding : undefined);
  if (paymentPlanId === undefined) {
    return Response.json(
      {
        ok: false,
        error:
          "Choose how this patient is to be seen (NHS or Private) before registering them. Dentally will not create a patient without a payment plan.",
      },
      { status: 400 },
    );
  }

  // ---- Resolve the site: the submission's chosen site if it is genuinely one of this
  // client's sites; otherwise the client's first/primary site (mirrors the co-pilot's
  // siteIds[0] fallback for a submission that named no site, e.g. the legacy form's
  // "any" option, or a form with the site question disabled). Dedupe searches EVERY
  // site of this client (the person may already be a patient at a sister site); the
  // create targets only the one resolved site.
  const clientSites = getSites(client.id);
  const resolvedSiteId =
    submission.siteId && clientSites.some((s) => s.id === submission.siteId)
      ? submission.siteId
      : clientSites[0]?.id;
  if (!resolvedSiteId) {
    return Response.json(
      { ok: false, error: "This practice has no site configured to register the patient at." },
      { status: 400 },
    );
  }
  const allSiteIds = clientSites.map((s) => s.id);

  const name = `${firstName} ${lastName}`.trim();
  const readback = {
    firstName,
    lastName,
    title,
    dateOfBirth: dob,
    phone: phone ?? null,
    email: email ?? null,
    site: siteName(resolvedSiteId),
  };

  // ---- DEDUPE FIRST. A plausible existing record short-circuits creation entirely
  // (no write, no status flip) UNLESS the caller has explicitly confirmed (force: true)
  // that this is a different person — gated behind the UI's own secondary confirm, so
  // `force` skips straight to creation without re-searching.
  if (!force) {
    const likely = await findLikelyExistingPatient(allSiteIds, { name, dob, phone, email });
    if (likely) {
      return Response.json({
        ok: true,
        created: false,
        duplicate: true,
        match: {
          id: likely.id,
          name: likely.name,
          dateOfBirth: likely.dateOfBirth,
          site: siteName(likely.siteId),
          matchedOn: likely.matchedOn,
        },
      });
    }
  }

  // ---- THE WRITE GATE. Enforced, not merely reported.
  //
  // This used to read `const writeEnabled = isDentallyWriteEnabled()` and then use it
  // as a LABEL only: the create below ran unconditionally and the response carried
  // `dryRun: !writeEnabled`. The header comment above claimed "a real create can never
  // happen until the write key is set", but no line of code enforced it —
  // dentallyAgentClient()'s disabled branch defaults its base URL to
  // https://api.dentally.co, so with DENTALLY_BASE_URL unset a genuine patient was
  // created in the live book of ~51,000 people while the API answered `dryRun: true`
  // and the worklist showed "Recorded in test mode".
  //
  // Placed AFTER auth, validation and dedupe so the answer stays honest — a submission
  // missing a surname is still told that, and a likely duplicate is still surfaced
  // without a write — and BEFORE dentallyAgentClient(), which is the first line that
  // could reach Dentally. Same shape as recall/[action], reactivation/[action],
  // coordinator/[action] and noshow/[action].
  if (!isDentallyWriteEnabled()) {
    return Response.json({ ok: false, error: REGISTER_WRITES_OFF }, { status: 503 });
  }

  // ---- CREATE. Single write via the gated client, with the payload built by the ONE
  // live-calibrated derivation every registration path now shares
  // (lib/dentally/patient-payload.ts), and the internal site id mapped to Dentally's
  // own UUID.
  //
  // WHAT THIS USED TO SEND: names, contact, site, and a date of birth only when the
  // form happened to have asked for one. No title, no payment plan, no sex — three of
  // the four fields live Dentally names in its 422. So every "Register in Dentally"
  // click against the real practice would have failed, and the receptionist would have
  // been told "Dentally rejected the details (422). Check the date of birth and
  // contact details with the patient" — sending them to check details that were fine.
  //
  // Sex is derived from the staff member's chosen title, exactly as the booking funnel
  // derives it; the confirm dialogue shows what will be saved before they commit.
  const built = buildPatientRegistration({
    firstName,
    lastName,
    title,
    dateOfBirth: dob,
    paymentPlanId,
    email,
    phone,
    dentallySiteId: dentallySiteId(resolvedSiteId),
    useSms: Boolean(phone),
    useEmail: Boolean(email),
  });
  if (!built.ok) {
    // Unreachable while the guards above stand, and handled anyway: never send a
    // registration Dentally will refuse and then blame the patient's details for it.
    return Response.json({ ok: false, error: built.reason }, { status: 400 });
  }

  let newId: string;
  try {
    const dentally = dentallyAgentClient();
    const { patient } = await dentally.createPatient(built.payload);
    newId = String(patient.id);
  } catch (err) {
    // ANY Dentally failure is surfaced HONESTLY and NEVER auto-retried. A 403 most
    // likely means the write key is not permitted to create patients; a 422 means
    // Dentally rejected the details. The submission's status is NOT flipped, so the
    // row stays available to retry once the underlying problem is fixed.
    const status = err instanceof DentallyError ? err.status : 0;
    console.error(`[onboarding/register] Dentally create failed for submission ${submissionId}`, err);
    const message =
      status === 403
        ? `Could not register ${name}: the Dentally key does not allow creating patients (403). Nothing was created.`
        : status === 422
          ? `Could not register ${name}: Dentally rejected the details (422). Check the date of birth and contact details with the patient.`
          : `Could not register ${name}: there was an error creating them in Dentally. Nothing was created.`;
    return Response.json(
      { ok: false, error: message, status },
      { status: status === 403 ? 403 : status === 422 ? 422 : 502 },
    );
  }

  await setStatus(submissionId, "registered");
  // No dedicated onboarding audit log exists yet; console-log the action so the
  // creation is at least traceable in server logs (who, what, which submission).
  console.log(
    `[onboarding/register] created Dentally patient ${newId} for submission ${submissionId} (client ${client.id}, site ${resolvedSiteId}, actor ${auth?.email ?? "unknown"})`,
  );

  // No `dryRun` field. Past the gate above it could only ever be false, and while it
  // existed the UI read it as permission to call a create "recorded in test mode".
  return Response.json({
    ok: true,
    created: true,
    duplicate: false,
    patientId: newId,
    status: "registered",
    ...readback,
  });
}
