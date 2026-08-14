"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/auth-browser";
import { Button } from "@/components/ui/button";
import { MIN_PASSWORD_LENGTH, parseSetPasswordEntry, validateNewPassword } from "@/lib/provisioning/rules";

// ===========================================================================
// THE INVITEE'S OWN SCREEN.
//
// The one place in this platform where a password is typed, and it is typed by the
// person it belongs to, in their own browser. It goes from this form to Supabase and
// nowhere else: it is not posted to any route of ours, not logged, not stored, and
// never seen by the practice owner who sent the invite.
//
// THE URL IS READ ONCE, SYNCHRONOUSLY, BEFORE THE SUPABASE CLIENT IS CREATED. That
// is not fussiness: the browser client's `detectSessionInUrl` clears the fragment on
// initialise, so a component that read `window.location.hash` inside an async effect
// would intermittently find it already gone, and the invitee would land on a page
// telling them their link was invalid. Reading first removes the race entirely.
//
// The parsing and the password rules are pure functions in
// `@/lib/provisioning/rules` with a full test file; this component only renders what
// they return, which is the only way the fragment half of the flow gets any test
// coverage at all.
// ===========================================================================

type Phase =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "blocked"; message: string }
  | { kind: "done" };

/** Read the URL exactly once, before anything can rewrite it. */
function readEntry() {
  if (typeof window === "undefined") return { search: "", hash: "" };
  return { search: window.location.search, hash: window.location.hash };
}

export function SetPasswordForm() {
  const router = useRouter();
  const [entry] = useState(readEntry);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const parsed = parseSetPasswordEntry(entry.search, entry.hash);

    async function establish() {
      const supabase = supabaseBrowser();

      if (parsed.mode === "error") {
        if (!cancelled) setPhase({ kind: "blocked", message: parsed.error });
        return;
      }

      if (parsed.mode === "token_hash") {
        const { error: verifyError } = await supabase.auth.verifyOtp({
          type: parsed.type,
          token_hash: parsed.tokenHash,
        });
        if (cancelled) return;
        if (verifyError) {
          setPhase({
            kind: "blocked",
            message:
              "That link has expired or has already been used. Ask the practice to send you a new one.",
          });
          return;
        }
      } else if (parsed.mode === "session") {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: parsed.accessToken,
          refresh_token: parsed.refreshToken,
        });
        if (cancelled) return;
        if (sessionError) {
          setPhase({
            kind: "blocked",
            message:
              "That link has expired or has already been used. Ask the practice to send you a new one.",
          });
          return;
        }
      } else {
        // No token in the URL. A live session is still fine — somebody signed in and
        // came here to change their password on purpose — but nothing else is.
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        if (!data.session) {
          setPhase({
            kind: "blocked",
            message: "Open the link from your invitation email to set a password.",
          });
          return;
        }
      }

      // The token has done its job. Strip it out of the address bar so it is not left
      // in history, in a shared screenshot, or on a Referer header.
      if (typeof window !== "undefined" && (entry.search || entry.hash)) {
        window.history.replaceState({}, "", window.location.pathname);
      }
      if (!cancelled) setPhase({ kind: "ready" });
    }

    void establish();
    return () => {
      cancelled = true;
    };
  }, [entry]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const decision = validateNewPassword(password, confirmation);
    if (!decision.ok) {
      setError(decision.error);
      return;
    }
    setBusy(true);
    const { error: updateError } = await supabaseBrowser().auth.updateUser({ password });
    if (updateError) {
      setBusy(false);
      setError(
        updateError.message ||
          "That password could not be saved. Please try a different one, or ask the practice for a new link.",
      );
      return;
    }
    setBusy(false);
    setPhase({ kind: "done" });
  }

  if (phase.kind === "checking") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={15} className="animate-spin" /> Checking your link…
      </p>
    );
  }

  if (phase.kind === "blocked") {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl text-navy">We could not open that link</h1>
        <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
          {phase.message}
        </p>
        <p className="text-sm text-muted">
          Invitation links can only be used once and expire after a while. Your practice can send you
          a fresh one.
        </p>
        <a href="/login" className="inline-block text-sm font-semibold text-blue-dark underline">
          Go to sign in
        </a>
      </div>
    );
  }

  if (phase.kind === "done") {
    return (
      <div className="space-y-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-status-green/15 text-status-green">
          <CheckCircle2 size={20} />
        </span>
        <h1 className="text-2xl text-navy">Your password is set</h1>
        <p className="text-sm text-muted">You are signed in. Use this password next time you sign in.</p>
        <Button
          type="button"
          variant="primary"
          className="w-full"
          onClick={() => {
            router.push("/");
            router.refresh();
          }}
        >
          Continue
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-7">
      <div className="space-y-1.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-dark text-white">
          <ShieldCheck size={18} />
        </span>
        <h1 className="text-2xl text-navy">Choose your password</h1>
        <p className="text-sm text-muted">
          Set a password for your practice login. Only you will know it — nobody at the practice can
          see it.
        </p>
      </div>

      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
            New password
          </span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-sm text-ink placeholder:text-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
          />
          <span className="mt-1 block text-xs text-muted">
            At least {MIN_PASSWORD_LENGTH} characters. A short phrase you will remember beats a
            complicated word.
          </span>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
            Repeat password
          </span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            className="w-full rounded-lg border border-line-strong bg-card px-3 py-2.5 text-sm text-ink placeholder:text-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
          />
        </label>
      </div>

      {error ? (
        <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
      ) : null}

      <Button type="submit" variant="primary" className="w-full" disabled={busy}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : null}
        Save password
      </Button>
    </form>
  );
}
