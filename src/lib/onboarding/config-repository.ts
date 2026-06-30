import { serviceClient } from "@/lib/supabase/server";
import type { OnboardingConfig } from "./types";

// Server-only CRUD for onboarding_config (one row per client). The public onboarding
// page reads the config server-side to resolve its steps; the management API
// (requireUser + client-scoped) writes it. Access is via the service-role client only,
// like every other table in the locked posture.

interface ConfigRow {
  client_id: string;
  config: OnboardingConfig;
  updated_at: string;
}

/**
 * The saved config for a client, or null if none has been saved yet (the public form
 * then resolves to the default flow). Defensive about the stored jsonb shape so a bad
 * row never crashes the public page.
 */
export async function getConfig(clientId: string): Promise<OnboardingConfig | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("onboarding_config")
    .select("config, updated_at")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as Pick<ConfigRow, "config" | "updated_at">;
  const raw = (row.config ?? {}) as Partial<OnboardingConfig>;
  return {
    enabledKeys: Array.isArray(raw.enabledKeys) ? raw.enabledKeys : [],
    required:
      raw.required && typeof raw.required === "object" ? raw.required : {},
    custom: Array.isArray(raw.custom) ? raw.custom : [],
    updatedAt: row.updated_at,
  };
}

/** Upsert the config for a client (one row per client_id), stamping updated_at. */
export async function saveConfig(
  clientId: string,
  config: OnboardingConfig,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("onboarding_config")
    .upsert(
      {
        client_id: clientId,
        config: {
          enabledKeys: config.enabledKeys,
          required: config.required,
          custom: config.custom,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id" },
    );
  if (error) throw error;
}
