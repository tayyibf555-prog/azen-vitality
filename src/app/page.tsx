import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role === "agency_admin") redirect("/agency");
  if (user.role === "client_owner") redirect(`/owner/${user.clientId ?? "vitality"}`);
  redirect(`/c/${user.clientId ?? "vitality"}`);
}
