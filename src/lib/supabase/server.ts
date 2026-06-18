import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client: full access, bypasses RLS. Use only on the server
 * (sync job, server actions). Never expose the service-role key to the browser.
 */
export function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

/** Anon client for server-side reads that should respect RLS (once real auth lands). */
export function anonServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
}
