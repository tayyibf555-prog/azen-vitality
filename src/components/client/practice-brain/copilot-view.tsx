"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/primitives";
import { PasswordGate } from "./password-gate";
import { CopilotPanel } from "./copilot-panel";

export function CopilotView() {
  const [checking, setChecking] = useState(true);
  const [unlocked, setUnlocked] = useState(false);

  // Detect an existing unlock cookie on mount (returning within the session).
  useEffect(() => {
    (async () => {
      const r = await fetch("/api/practice-brain/tree", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (r.ok) {
        const j = await r.json();
        if (j.success) {
          setUnlocked(true);
        }
      }
      setChecking(false);
    })();
  }, []);

  return (
    <>
      <PageHeader
        title="Ask the brain"
        description="Ask the practice knowledge anything. Answers are drawn only from the brain and filtered to your access level."
      />

      {checking ? (
        <div className="rounded-[15px] bg-card p-8 text-center text-sm text-muted shadow-float ring-1 ring-line/60">
          Checking access...
        </div>
      ) : !unlocked ? (
        <PasswordGate onUnlocked={() => setUnlocked(true)} />
      ) : (
        <CopilotPanel onCite={() => {}} />
      )}
    </>
  );
}
