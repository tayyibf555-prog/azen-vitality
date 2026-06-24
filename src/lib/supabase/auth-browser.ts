import { createBrowserClient } from "@supabase/ssr";

/** Supabase client for the browser (login form). Uses the public anon key. */
export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
