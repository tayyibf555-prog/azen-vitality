"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/auth-browser";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
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
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* Brand panel */}
      <section className="relative hidden flex-col justify-between overflow-hidden bg-navy p-12 text-on-navy lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full opacity-30 blur-3xl"
          style={{ background: "radial-gradient(circle, var(--blue-dark), transparent 70%)" }}
        />
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-dark text-lg font-extrabold text-white">A</span>
          <span className="text-xl font-extrabold tracking-tight">Azen</span>
        </div>
        <div className="relative max-w-md space-y-4">
          <h1 className="text-4xl leading-tight text-on-navy">The operating layer for Vitality Dental.</h1>
          <p className="text-on-navy-muted">
            Built on Dentally. Catches leads in seconds, books them, and wins back the patients and unfinished
            treatment that quietly leak out the back of the practice.
          </p>
        </div>
        <p className="relative text-xs text-on-navy-muted">Azen AI Ltd. Single tenant, client owns the IP.</p>
      </section>

      {/* Sign-in panel */}
      <section className="flex items-center justify-center bg-cream px-6 py-12">
        <form onSubmit={submit} className="w-full max-w-sm space-y-6">
          <div className="space-y-1">
            <span className="lg:hidden mb-3 inline-flex items-center gap-2 font-extrabold text-navy">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-dark text-white">A</span>
              Azen
            </span>
            <h2 className="text-2xl text-navy">Sign in</h2>
            <p className="text-sm text-muted">Use the email and password for your practice account.</p>
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
                className="w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
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
                className="w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
              />
            </label>
          </div>

          {error ? (
            <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
          ) : null}

          <Button type="submit" variant="primary" className="w-full" disabled={busy}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : null}
            Sign in
          </Button>
        </form>
      </section>
    </main>
  );
}
