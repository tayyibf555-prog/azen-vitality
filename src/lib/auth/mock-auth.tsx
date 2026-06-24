"use client";

/**
 * Auth provider, now backed by real Supabase Auth (cookie sessions).
 *
 * The verified user is resolved on the server (root layout -> getSessionUser)
 * and handed in as `initialUser`, then exposed through useAuth() — the same hook
 * the chrome already consumes, so no consumer changed. Sign-in happens on the
 * /login page; sign-out clears the Supabase session.
 *
 * MOCK_USERS is retained only for the dev-only RoleSwitcher (not mounted under
 * real auth) and the legacy login/switchRole methods are no-ops here.
 */

import { createContext, useCallback, useContext, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/auth-browser";
import type { Role, SessionUser } from "@/lib/types";

/** One representative user per role. clientId is the Vitality client slug-id. */
export const MOCK_USERS: Record<Role, SessionUser> = {
  agency_admin: {
    id: "u-azen-1",
    name: "Tayyib Arbab",
    email: "tayyib@azen.ai",
    role: "agency_admin",
    clientId: null,
  },
  client_owner: {
    id: "u-vitality-owner",
    name: "Jawad Khursheed",
    email: "jawad@vitalitydental.co.uk",
    role: "client_owner",
    clientId: "vitality",
  },
  client_coordinator: {
    id: "u-vitality-coord",
    name: "Aisha Rahman",
    email: "aisha@vitalitydental.co.uk",
    role: "client_coordinator",
    clientId: "vitality",
  },
};

interface AuthContextValue {
  user: SessionUser | null;
  login: (role: Role) => void; // legacy shape; real sign-in is the /login page
  logout: () => void;
  switchRole: (role: Role) => void; // legacy dev affordance (no-op under real auth)
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  initialUser,
}: {
  children: React.ReactNode;
  initialUser: SessionUser | null;
}) {
  const router = useRouter();

  const logout = useCallback(() => {
    void supabaseBrowser()
      .auth.signOut()
      .finally(() => {
        router.push("/login");
        router.refresh();
      });
  }, [router]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: initialUser,
      login: () => router.push("/login"),
      logout,
      switchRole: () => {},
    }),
    [initialUser, logout, router],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
