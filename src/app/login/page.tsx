"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/auth-browser";
import { Button } from "@/components/ui/button";

/** Simple tooth mark so the sign-in reads as the practice's own, not a generic tool. */
function ToothMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 2.4c-2.1 0-3.5.9-4.6.9-1 0-1.7-.5-2.6-.5C3.3 2.8 2.4 4.3 2.4 6.6c0 2 .7 3.4 1.2 5.3.3 1.2.4 2.1.6 3.6.3 2.4.5 4.4.9 5.6.3.9.8 1.5 1.5 1.5.9 0 1.2-1 1.5-2.6.3-1.6.5-3.3 1.4-3.3s1.1 1.7 1.4 3.3c.3 1.6.6 2.6 1.5 2.6.7 0 1.2-.6 1.5-1.5.4-1.2.6-3.2.9-5.6.2-1.5.3-2.4.6-3.6.5-1.9 1.2-3.3 1.2-5.3 0-2.3-.9-3.8-2.4-3.8-.9 0-1.6.5-2.6.5-1.1 0-2.5-.9-4.6-.9z" />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(() => {
    // A successful sign-in with no matching practice profile bounces back here;
    // say so explicitly instead of looking like a bad password.
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("error") === "no_profile") {
      return "You're signed in, but this account isn't linked to a practice yet. Ask your administrator to finish setting it up.";
    }
    return null;
  });
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabaseBrowser().auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (signInError) {
      setError("That email and password did not match. Please try again.");
      setBusy(false);
      return;
    }
    // Land on the root, which redirects to the right place for this user's role.
    router.push("/");
    router.refresh();
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-[1fr_1.05fr]">
      {/* Sign-in panel */}
      <section className="flex items-center justify-center bg-cream px-6 py-12">
        <form onSubmit={submit} className="w-full max-w-sm space-y-8">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-dark text-white">
              <ToothMark className="h-5 w-5" />
            </span>
            <span className="text-lg font-extrabold tracking-tight text-navy">
              Vitality <span className="font-semibold text-muted">Dental</span>
            </span>
          </div>

          <div className="space-y-1.5">
            <h1 className="text-2xl text-navy">Sign in</h1>
            <p className="text-sm text-muted">Enter your email and password to continue.</p>
          </div>

          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Email</span>
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@vitalitydental.co.uk"
                className="w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-sm text-ink placeholder:text-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Password</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-sm text-ink placeholder:text-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
              />
            </label>
          </div>

          {error ? (
            <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
          ) : null}

          <div className="space-y-3">
            <Button type="submit" variant="primary" className="w-full" disabled={busy}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : null}
              Sign in
            </Button>
            <p className="text-center text-xs text-muted">
              Having trouble signing in? Contact your practice administrator.
            </p>
          </div>
        </form>
      </section>

      {/* Brand panel */}
      <section
        className="relative hidden flex-col justify-between overflow-hidden p-12 text-on-navy lg:flex"
        style={{ background: "linear-gradient(155deg, #0b2049 0%, #0a1c40 55%, #071634 100%)" }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -right-32 -top-32 h-[28rem] w-[28rem] rounded-full opacity-40 blur-3xl"
          style={{ background: "radial-gradient(circle, var(--blue-dark), transparent 70%)" }}
        />
        {/* Oversized, faint tooth mark bleeding off the edge. */}
        <ToothMark className="pointer-events-none absolute -bottom-24 -right-16 h-[30rem] w-[30rem] select-none text-white/[0.05]" />

        <div className="relative flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-dark text-white">
            <ToothMark className="h-6 w-6" />
          </span>
          <span className="text-xl font-extrabold tracking-tight">
            Vitality <span className="font-semibold text-on-navy-muted">Dental</span>
          </span>
        </div>

        <p className="relative text-sm text-on-navy-muted">The operating layer for Vitality Dental.</p>
      </section>
    </main>
  );
}
