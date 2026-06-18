"use client";

/**
 * Mock auth for the foundation build.
 *
 * This stands in for Supabase auth + RLS. It is deliberately shaped so the real
 * thing is a drop-in later: components consume `useAuth()` and never care whether
 * the session came from a mock or from Supabase. Roles map 1:1 to future RLS policy.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
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
  login: (role: Role) => void;
  logout: () => void;
  /** Quick role switch for previewing every view without re-login. */
  switchRole: (role: Role) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const STORAGE_KEY = "azen.mockauth.role";

export function MockAuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);

  // Rehydrate the chosen role on load (keeps the session across navigation).
  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (stored && stored in MOCK_USERS) {
      setUser(MOCK_USERS[stored as Role]);
    }
  }, []);

  const apply = useCallback((role: Role | null) => {
    if (role) {
      setUser(MOCK_USERS[role]);
      window.localStorage.setItem(STORAGE_KEY, role);
    } else {
      setUser(null);
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      login: (role) => apply(role),
      logout: () => apply(null),
      switchRole: (role) => apply(role),
    }),
    [user, apply],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within MockAuthProvider");
  return ctx;
}
