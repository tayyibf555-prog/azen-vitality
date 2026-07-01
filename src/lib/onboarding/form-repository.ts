import { serviceClient } from "@/lib/supabase/server";
import type { OnboardingConfig } from "./types";
import {
  normaliseFormConfig,
  type OnboardingForm,
  type OnboardingFormStatus,
} from "./form";

// Server-only CRUD for onboarding_form (service-role). The public landing reads via
// getActiveFormBySlug; the internal management UI is requireUser + client-scoped.

// Thrown when a (client, slug) already exists so the API can answer 409 and the owner
// can pick a different URL. Mirrors the campaign SlugTakenError.
export class FormSlugTakenError extends Error {
  constructor(slug: string) {
    super(`The URL "${slug}" is already in use for this practice.`);
    this.name = "FormSlugTakenError";
  }
}

interface FormRow {
  id: string;
  client_id: string;
  site_id: string;
  slug: string;
  name: string;
  headline: string | null;
  intro: string | null;
  config: unknown;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function rowToForm(r: FormRow): OnboardingForm {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    slug: r.slug,
    name: r.name,
    headline: r.headline,
    intro: r.intro,
    config: normaliseFormConfig(r.config),
    status: (r.status as OnboardingFormStatus) ?? "active",
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface InsertFormInput {
  clientId: string;
  siteId: string;
  slug: string;
  name: string;
  headline?: string | null;
  intro?: string | null;
  config: OnboardingConfig;
  createdBy?: string | null;
}

export async function insertForm(input: InsertFormInput): Promise<OnboardingForm> {
  const db = serviceClient();
  const { data, error } = await db
    .from("onboarding_form")
    .insert({
      client_id: input.clientId,
      site_id: input.siteId,
      slug: input.slug,
      name: input.name,
      headline: input.headline ?? null,
      intro: input.intro ?? null,
      config: input.config,
      created_by: input.createdBy ?? null,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") throw new FormSlugTakenError(input.slug); // unique (client_id, slug)
    throw error;
  }
  return rowToForm(data as FormRow);
}

/** All of a client's forms, newest first. */
export async function listForms(clientId: string): Promise<OnboardingForm[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("onboarding_form")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as FormRow[]).map(rowToForm);
}

/** A single form by (client, slug), any status. */
export async function getFormBySlug(clientId: string, slug: string): Promise<OnboardingForm | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("onboarding_form")
    .select("*")
    .eq("client_id", clientId)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToForm(data as FormRow) : null;
}

/** The active form for a (client, slug); null if missing or paused. Used by the public page. */
export async function getActiveFormBySlug(
  clientId: string,
  slug: string,
): Promise<OnboardingForm | null> {
  const form = await getFormBySlug(clientId, slug);
  return form && form.status === "active" ? form : null;
}

export interface UpdateFormPatch {
  name?: string;
  headline?: string | null;
  intro?: string | null;
  config?: OnboardingConfig;
  status?: OnboardingFormStatus;
}

/**
 * Update a form's editable fields, scoped to its client. Returns true if a row matched;
 * false for an unknown id or an id owned by another client (so the API can answer 404
 * instead of a misleading success — the lesson from the rota review).
 */
export async function updateForm(
  id: string,
  clientId: string,
  patch: UpdateFormPatch,
): Promise<boolean> {
  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) fields.name = patch.name;
  if (patch.headline !== undefined) fields.headline = patch.headline;
  if (patch.intro !== undefined) fields.intro = patch.intro;
  if (patch.config !== undefined) fields.config = patch.config;
  if (patch.status !== undefined) fields.status = patch.status;

  const db = serviceClient();
  const { data, error } = await db
    .from("onboarding_form")
    .update(fields)
    .eq("id", id)
    .eq("client_id", clientId)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** How many submissions each form has, for the management list. */
export async function countSubmissionsByForm(
  formIds: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (formIds.length === 0) return out;
  const db = serviceClient();
  const { data, error } = await db
    .from("onboarding_submission")
    .select("form_id")
    .in("form_id", formIds);
  if (error) throw error;
  for (const row of (data as { form_id: string | null }[]) ?? []) {
    if (row.form_id) out[row.form_id] = (out[row.form_id] ?? 0) + 1;
  }
  return out;
}
