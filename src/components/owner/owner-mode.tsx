"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type OwnerMode = "operations" | "management";

interface OwnerModeContextValue {
  mode: OwnerMode;
  setMode: (mode: OwnerMode) => void;
}

const OwnerModeContext = createContext<OwnerModeContextValue | null>(null);
const STORAGE_KEY = "azen.owner.mode";
const DEFAULT_MODE: OwnerMode = "management";

function isOwnerMode(value: string | null): value is OwnerMode {
  return value === "operations" || value === "management";
}

export function OwnerModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<OwnerMode>(DEFAULT_MODE);

  // Rehydrate the chosen mode on mount (guard for SSR).
  useEffect(() => {
    const stored =
      typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (isOwnerMode(stored)) {
      setModeState(stored);
    }
  }, []);

  const setMode = useCallback((next: OwnerMode) => {
    setModeState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  }, []);

  const value = useMemo<OwnerModeContextValue>(() => ({ mode, setMode }), [mode, setMode]);

  return <OwnerModeContext.Provider value={value}>{children}</OwnerModeContext.Provider>;
}

export function useOwnerMode() {
  const ctx = useContext(OwnerModeContext);
  if (!ctx) throw new Error("useOwnerMode must be used within OwnerModeProvider");
  return ctx;
}
