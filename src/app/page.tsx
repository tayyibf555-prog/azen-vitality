import { redirect } from "next/navigation";

export default function Home() {
  // The entry point is the (mock) login screen; routing onward is role-based.
  redirect("/login");
}
