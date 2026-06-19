"use client";

import { useState, type FormEvent } from "react";

interface Props {
  onUnlocked: (label: string, maxTier: number) => void;
}

export function PasswordGate({ onUnlocked }: Props) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/practice-brain/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      }).then((r) => r.json());
      if (!res.success) throw new Error(res.error);
      onUnlocked(res.data.label as string, res.data.maxTier as number);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unlock failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        minHeight: 420, background: "#0A0E1A", borderRadius: 12,
        border: "0.5px solid rgba(150,170,210,0.18)",
      }}
    >
      <form onSubmit={submit} style={{ width: 300, textAlign: "center" }}>
        <div style={{ color: "#5BC4F7", fontSize: 13, letterSpacing: 3, textTransform: "uppercase", marginBottom: 8 }}>
          Practice brain
        </div>
        <p style={{ color: "#C8D4F0", fontSize: 14, margin: "0 0 16px" }}>Enter your password to unlock.</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          style={{
            width: "100%", padding: "10px 12px", borderRadius: 8,
            border: "0.5px solid rgba(150,170,210,0.35)", background: "#12224A",
            color: "#FFFFFF", fontSize: 14,
          }}
        />
        {error && <p style={{ color: "#F09595", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
        <button
          type="submit"
          disabled={busy || password.length === 0}
          style={{
            marginTop: 12, width: "100%", padding: "10px 12px", borderRadius: 8,
            border: "none", background: "#2B8AC0", color: "#FFFFFF", fontSize: 14,
            fontWeight: 500, cursor: "pointer", opacity: busy || !password ? 0.5 : 1,
          }}
        >
          {busy ? "Unlocking..." : "Unlock"}
        </button>
      </form>
    </div>
  );
}
