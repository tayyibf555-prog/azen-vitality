"use client";

import { useMemo } from "react";
import type { KnowledgeNode } from "@/lib/practice-brain/types";
import { childrenOf } from "@/lib/practice-brain/clearance";
import { layoutConstellation, type HubInput } from "@/lib/practice-brain/layout";

const W = 680;
const H = 560;

interface Props {
  nodes: KnowledgeNode[];
  focusId: string | null;
  activeHubId: string | null;
  query: string;
  onSelectHub: (id: string) => void;
  onSelectItem: (id: string) => void;
}

export function Constellation({ nodes, focusId, activeHubId, query, onSelectHub, onSelectItem }: Props) {
  const layout = useMemo(() => {
    const hubsRaw = childrenOf(nodes, focusId);
    const hubs: HubInput[] = hubsRaw.map((h) => ({
      id: h.id,
      title: h.title,
      tier: h.tier,
      leaves: childrenOf(nodes, h.id).map((l) => ({ id: l.id, title: l.title, tier: l.tier })),
    }));
    return layoutConstellation(hubs, { width: W, height: H });
  }, [nodes, focusId]);

  const q = query.trim().toLowerCase();
  const matches = (title: string) => q.length > 0 && title.toLowerCase().includes(q);

  const core = useMemo(() => {
    const arr: { x2: number; y2: number; r: number; op: number }[] = [];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 60; i++) {
      const a = rnd() * Math.PI * 2;
      const L = rnd() * 42 + 6;
      arr.push({ x2: 340 + Math.cos(a) * L, y2: 280 + Math.sin(a) * L, r: rnd() * 1.1 + 0.5, op: 0.7 - L / 70 });
    }
    return arr;
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", background: "#0A0E1A", borderRadius: 12, overflow: "hidden", border: "0.5px solid rgba(150,170,210,0.18)" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img" aria-label="Practice brain constellation">
        {core.map((c, i) => (
          <line key={`c${i}`} x1={340} y1={280} x2={c.x2.toFixed(1)} y2={c.y2.toFixed(1)} stroke={`rgba(150,200,255,${c.op.toFixed(2)})`} strokeWidth={0.6} />
        ))}
        <circle cx={340} cy={280} r={7} fill="#BFE0FF" opacity={0.25} />
        <circle cx={340} cy={280} r={3} fill="#FFFFFF" />

        {layout.hubs.map((h) => {
          const active = h.id === activeHubId;
          const hit = matches(h.title);
          const stroke = active ? "#F4C451" : hit ? "#5BC4F7" : "rgba(190,205,235,0.55)";
          return (
            <g key={h.id} style={{ cursor: "pointer" }} onClick={() => onSelectHub(h.id)}>
              <line x1={340} y1={280} x2={h.x} y2={h.y} stroke={active ? "rgba(244,196,81,0.5)" : "rgba(124,166,226,0.22)"} strokeWidth={active ? 1.1 : 0.7} />
              {active && <circle cx={h.x} cy={h.y} r={22} fill="none" stroke="rgba(244,196,81,0.25)" strokeWidth={6} />}
              <circle cx={h.x} cy={h.y} r={15} fill="#12224A" stroke={stroke} strokeWidth={active ? 1.6 : 1} />
              <text x={h.x} y={h.y - 24} textAnchor="middle" fontSize={13} letterSpacing={2} fill={active ? "#F4C451" : "#C8D4F0"} style={{ textTransform: "uppercase" }}>{h.title}</text>
              <text x={h.x} y={h.y - 10} textAnchor="middle" fontSize={9} fill="#7081AC">{h.leafCount} items</text>
            </g>
          );
        })}

        {layout.leaves.map((l) => {
          const hit = matches(l.title);
          return (
            <g key={l.id} style={{ cursor: "pointer" }} onClick={() => onSelectItem(l.id)}>
              <circle cx={l.x} cy={l.y} r={hit ? 4 : 2.6} fill={hit ? "#FFFFFF" : "#79ADE8"} opacity={hit ? 1 : 0.85} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
