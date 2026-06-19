import { createClient } from "@supabase/supabase-js";

/**
 * Server-side write/read client.
 *
 * Prefers the service-role key (full access, bypasses RLS) when set. Falls back
 * to the public/publishable key for the pilot, where temporary permissive RLS
 * policies (migration 0002) allow access. Once the service-role key is provided,
 * this automatically upgrades to bypassing RLS with no code change.
 *
 * Server-only. Never import this into client components.
 */
export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase not configured: set NEXT_PUBLIC_SUPABASE_URL and a key",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

/** Anon client for server-side reads that should respect RLS (once real auth lands). */
export function anonServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
}
