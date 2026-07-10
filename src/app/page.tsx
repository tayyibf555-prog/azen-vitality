import { redirect } from "next/navigation";
import { getSessionUser, getAuthEmail } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getSessionUser();
  if (!user) {
    // Signed in but unprovisioned (no app_user row): say so on the login page
    // instead of bouncing back to a silent empty form that looks like a bad
    // password. Not signed in at all: plain login.
    const email = await getAuthEmail();
    redirect(email ? "/login?error=no_profile" : "/login");
  }
  if (user.role === "agency_admin") redirect("/agency");
  if (user.role === "client_owner") redirect(`/owner/${user.clientId ?? "vitality"}`);
  redirect(`/c/${user.clientId ?? "vitality"}`);
}
