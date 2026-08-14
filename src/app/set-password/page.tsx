import { SetPasswordForm } from "./set-password-form";

export const dynamic = "force-dynamic";

/**
 * PUBLIC. The page an invited person lands on from their one-time link.
 *
 * No guard, and none is possible: the visitor has no session yet — establishing one
 * from the link is the whole job of this page. The link itself is the credential,
 * it is single use, it expires, and Supabase verifies it. Nothing on this page reads
 * or writes practice data.
 *
 * Everything happens in the CLIENT component below, and it has to: the fragment form
 * of Supabase's link (`#access_token=…`) is never sent to the server by the browser,
 * so a server component cannot see it at all.
 */
export default function SetPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-cream px-6 py-12">
      <div className="w-full max-w-sm">
        <SetPasswordForm />
      </div>
    </main>
  );
}
