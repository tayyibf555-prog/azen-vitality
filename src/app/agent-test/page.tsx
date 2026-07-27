"use client";

// DEV/TEST harness UI for the booking agent. Chat with the agent in the browser
// (live AI + mock Dentally diary, no Twilio/SMS). Remove or gate before prod.

import { useRef, useState } from "react";

interface Msg {
  role: "patient" | "agent";
  body: string;
}

const TREATMENTS = ["Invisalign", "Dental implant", "Porcelain veneers", "Teeth whitening", "Composite bonding", "Checkup"];

export default function AgentTestPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [treatment, setTreatment] = useState("Invisalign");
  const [status, setStatus] = useState("active");
  const [busy, setBusy] = useState(false);
  const resetNext = useRef(false);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setMessages((m) => [...m, { role: "patient", body: text }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/agent-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, treatment, reset: resetNext.current }),
      });
      resetNext.current = false;
      const data = (await res.json()) as { reply?: string; status?: string };
      setMessages((m) => [...m, { role: "agent", body: data.reply ?? "(no reply)" }]);
      setStatus(data.status ?? "active");
    } catch {
      setMessages((m) => [...m, { role: "agent", body: "(error reaching the agent)" }]);
    } finally {
      setBusy(false);
    }
  }

  function newConversation() {
    resetNext.current = true;
    setMessages([]);
    setStatus("active");
    setInput("");
  }

  const statusTone =
    status === "booked" ? "#10B981" : status === "needs_human" ? "#F59E0B" : "#5BC4F7";

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px", fontFamily: "system-ui, sans-serif", color: "#0A0E1A" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Booking agent tester</h1>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#fff", background: statusTone, borderRadius: 999, padding: "2px 10px" }}>
          {status}
        </span>
      </div>
      <p style={{ fontSize: 13, color: "#64748B", marginTop: 0 }}>
        Live AI, mock diary. Patient: Harold Pemberton. No real texts are sent.
      </p>

      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
        <label style={{ fontSize: 12, color: "#64748B" }}>Enquiry</label>
        <select
          value={treatment}
          onChange={(e) => setTreatment(e.target.value)}
          style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}
        >
          {TREATMENTS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <button onClick={newConversation} style={{ marginLeft: "auto", fontSize: 12, padding: "6px 10px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer" }}>
          New conversation
        </button>
      </div>

      <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 12, minHeight: 320, display: "flex", flexDirection: "column", gap: 8, background: "#F6F3EE" }}>
        {messages.length === 0 ? (
          <p style={{ color: "#94A3B8", fontSize: 14, margin: "auto" }}>
            Say something like &ldquo;hi yes still interested&rdquo; to start.
          </p>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              style={{
                alignSelf: m.role === "patient" ? "flex-end" : "flex-start",
                maxWidth: "80%",
                background: m.role === "patient" ? "#2B8AC0" : "#fff",
                color: m.role === "patient" ? "#fff" : "#0A0E1A",
                border: m.role === "patient" ? "none" : "1px solid #e2e8f0",
                borderRadius: 12,
                padding: "8px 12px",
                fontSize: 14,
                whiteSpace: "pre-wrap",
              }}
            >
              {m.body}
            </div>
          ))
        )}
        {busy ? <div style={{ alignSelf: "flex-start", color: "#94A3B8", fontSize: 13 }}>agent is typing...</div> : null}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          placeholder="Type a message as the patient..."
          style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 14 }}
        />
        <button
          onClick={send}
          disabled={busy}
          style={{ padding: "10px 18px", borderRadius: 8, border: "none", background: "#2B8AC0", color: "#fff", fontWeight: 700, cursor: "pointer", opacity: busy ? 0.6 : 1 }}
        >
          Send
        </button>
      </div>
    </main>
  );
}
