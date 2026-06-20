"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Briefcase, TrendingUp, Bell, Megaphone, Settings2, LineChart, FolderTree,
  ChevronLeft, ChevronRight, type LucideIcon,
} from "lucide-react";
import type { KnowledgeNode } from "@/lib/practice-brain/types";
import { childrenOf } from "@/lib/practice-brain/clearance";

/**
 * The Practice Brain constellation.
 *
 * Overview: hubs ride a slow-drifting ring around a luminous core, joined by
 * tapered branches that glow from the centre outward. Click a hub to zoom into it
 * and fan its items below; the next/prev arrows spin the ring to a neighbour. Motion
 * is rAF-driven (exponential ease-out, no bounce) and hub positions are set
 * imperatively so labels never rotate out of true.
 */

const W = 680;
const H = 560;
const CX = 340;
const CY = 282;
const RING = 152; // hub ring radius (overview)
const FOCAL = { x: CX, y: CY - RING }; // ring slot a focused hub rotates into
const ANCHOR = { x: CX, y: CY - 78 }; // where the focused hub sits on screen
const FOCUS_SCALE = 1.5;
const EASE = 0.13; // per-frame approach toward target; exponential ease-out (~0.4s settle)
const DRIFT = 0.045; // degrees/frame ambient rotation
const RAD = Math.PI / 180;
const MAX_ITEMS = 8;
const HUB_R = 16;

// Section → icon. Anything unmapped falls back to a folder glyph.
const HUB_ICONS: Record<string, LucideIcon> = {
  "back office": Briefcase,
  "sales": TrendingUp,
  "reception": Bell,
  "marketing": Megaphone,
  "operations": Settings2,
  "intelligence": LineChart,
};
const hubIcon = (title: string): LucideIcon => HUB_ICONS[title.trim().toLowerCase()] ?? FolderTree;

// Deterministic scenery, generated once at module load (not in render).
function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
const STARS = (() => {
  const rnd = seeded(9);
  return Array.from({ length: 130 }, () => ({ x: rnd() * W, y: rnd() * H, r: rnd() * 1.1 + 0.3, o: rnd() * 0.45 + 0.12 }));
})();
const FILAMENTS = (() => {
  const rnd = seeded(7);
  return Array.from({ length: 56 }, () => {
    const a = rnd() * Math.PI * 2;
    const L = rnd() * 40 + 6;
    return { x: CX + Math.cos(a) * L, y: CY + Math.sin(a) * L, r: rnd() * 1.0 + 0.5, o: 0.7 - L / 72 };
  });
})();

// A tapered, gently curved branch (filled): wide where it leaves the core, narrowing to the hub.
function branchPath(cx: number, cy: number, hx: number, hy: number): string {
  const dx = hx - cx, dy = hy - cy;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len; // perpendicular unit
  const hw = 2.4; // half width at the base; the far end comes to a point at the hub
  const bow = len * 0.1; // gentle organic curve
  const mx = cx + dx * 0.5 + nx * bow;
  const my = cy + dy * 0.5 + ny * bow;
  return (
    `M${(cx + nx * hw).toFixed(1)},${(cy + ny * hw).toFixed(1)} ` +
    `Q${(mx + nx * hw * 0.45).toFixed(1)},${(my + ny * hw * 0.45).toFixed(1)} ${hx.toFixed(1)},${hy.toFixed(1)} ` +
    `Q${(mx - nx * hw * 0.45).toFixed(1)},${(my - ny * hw * 0.45).toFixed(1)} ${(cx - nx * hw).toFixed(1)},${(cy - ny * hw).toFixed(1)} Z`
  );
}

// A few small twigs sprouting outward from a hub, for the dendritic / tree look.
const TWIGS: [number, number][] = [[-28, 0.74], [-11, 0.96], [10, 0.96], [27, 0.78]];
function twigPath(cx: number, cy: number, hx: number, hy: number, scale: number): string {
  const dx = hx - cx, dy = hy - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const sx = hx + ux * HUB_R * scale, sy = hy + uy * HUB_R * scale; // start at the hub's outer edge
  const base = Math.atan2(uy, ux);
  const L = 23 * scale;
  let d = "";
  for (const [off, lf] of TWIGS) {
    const a = base + off * RAD;
    const tl = L * lf;
    const ex = sx + Math.cos(a) * tl, ey = sy + Math.sin(a) * tl;
    const bend = tl * 0.18 * (off < 0 ? -1 : 1);
    const cxx = sx + Math.cos(a) * tl * 0.5 - Math.sin(a) * bend;
    const cyy = sy + Math.sin(a) * tl * 0.5 + Math.cos(a) * bend;
    d += `M${sx.toFixed(1)},${sy.toFixed(1)} Q${cxx.toFixed(1)},${cyy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)} `;
  }
  return d;
}

interface Props {
  nodes: KnowledgeNode[];
  focusId: string | null;
  activeHubId?: string | null;
  query: string;
  onSelectHub?: (id: string) => void;
  onSelectItem: (id: string) => void;
}

function nearestEquivalent(target: number, current: number): number {
  let t = target;
  while (t - current > 180) t -= 360;
  while (current - t > 180) t += 360;
  return t;
}

export function Constellation({ nodes, focusId, query, onSelectItem }: Props) {
  const hubs = useMemo(() => childrenOf(nodes, focusId), [nodes, focusId]);
  const n = Math.max(hubs.length, 1);
  const step = 360 / n;

  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  const rot = useRef(0);
  const targetRot = useRef(0);
  const zoom = useRef(0);
  const focusRef = useRef<number | null>(null);
  const stepRef = useRef(step);
  const coreRef = useRef<SVGGElement | null>(null);
  const hubRefs = useRef<(SVGGElement | null)[]>([]);
  const branchRefs = useRef<(SVGPathElement | null)[]>([]);
  const twigRefs = useRef<(SVGPathElement | null)[]>([]);

  // Reset focus when the underlying hub set changes (render-time, the React-blessed way).
  const resetKey = `${focusId}:${hubs.length}`;
  const [seenKey, setSeenKey] = useState(resetKey);
  if (resetKey !== seenKey) {
    setSeenKey(resetKey);
    if (focusIndex !== null) setFocusIndex(null);
  }

  // Mirror render state into refs the rAF loop reads (ref writes belong in effects, not render).
  useEffect(() => { focusRef.current = focusIndex; }, [focusIndex]);
  useEffect(() => { stepRef.current = step; }, [step]);
  useEffect(() => { zoom.current = 0; }, [resetKey]);

  // One rAF loop for the component's lifetime. It reads focus/step from refs, so a focus
  // change never restarts it (which is what caused two loops to fight over the same refs).
  useEffect(() => {
    let id = 0;
    const frame = () => {
      const focused = focusRef.current !== null;
      const stp = stepRef.current;
      if (focused) rot.current += (targetRot.current - rot.current) * EASE;
      else rot.current += DRIFT;
      zoom.current += ((focused ? 1 : 0) - zoom.current) * EASE;

      const z = zoom.current;
      const scale = 1 + z * (FOCUS_SCALE - 1);
      const camX = CX + (FOCAL.x - CX) * z;
      const camY = CY + (FOCAL.y - CY) * z;
      const cenX = CX + (ANCHOR.x - CX) * z;
      const cenY = CY + (ANCHOR.y - CY) * z;
      const px = (wx: number) => cenX + scale * (wx - camX);
      const py = (wy: number) => cenY + scale * (wy - camY);

      if (coreRef.current) {
        coreRef.current.setAttribute(
          "transform",
          `translate(${(cenX - scale * camX).toFixed(2)},${(cenY - scale * camY).toFixed(2)}) scale(${scale.toFixed(3)})`,
        );
        coreRef.current.setAttribute("opacity", (1 - z * 0.7).toFixed(3));
      }
      const coreX = px(CX);
      const coreY = py(CY);
      hubRefs.current.forEach((g, i) => {
        if (!g) return;
        const a = (-90 + i * stp + rot.current) * RAD;
        const hx = px(CX + RING * Math.cos(a));
        const hy = py(CY + RING * Math.sin(a));
        g.setAttribute("transform", `translate(${hx.toFixed(2)},${hy.toFixed(2)}) scale(${scale.toFixed(3)})`);
        const branch = branchRefs.current[i];
        if (branch) branch.setAttribute("d", branchPath(coreX, coreY, hx, hy));
        const twig = twigRefs.current[i];
        if (twig) {
          twig.setAttribute("d", twigPath(coreX, coreY, hx, hy, scale));
          twig.setAttribute("opacity", (1 - z * 0.85).toFixed(2));
        }
      });
      id = requestAnimationFrame(frame);
    };
    id = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(id);
  }, []);

  const q = query.trim().toLowerCase();
  const matches = (s: string) => q.length > 0 && s.toLowerCase().includes(q);

  function openHub(i: number) {
    targetRot.current = nearestEquivalent(-i * step, rot.current);
    setFocusIndex(i);
  }
  function spin(dir: 1 | -1) {
    if (focusIndex === null) return;
    targetRot.current -= dir * step;
    setFocusIndex((focusIndex + dir + n) % n);
  }

  const focusedHub = focusIndex !== null ? hubs[focusIndex] : null;

  return (
    <div style={{ position: "relative", width: "100%", maxWidth: `min(100%, calc(58vh * ${W} / ${H}))`, aspectRatio: `${W} / ${H}`, margin: "0 auto", background: "radial-gradient(120% 90% at 50% 46%, #0E1530 0%, #090D1A 62%, #070A14 100%)", borderRadius: 16, overflow: "hidden", border: "0.5px solid rgba(150,170,210,0.18)", boxShadow: "inset 0 1px 0 rgba(170,200,255,0.06)" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ display: "block" }} role="img" aria-label="Practice brain constellation">
        <defs>
          <radialGradient id="pbCoreGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#2A3E72" stopOpacity="0.62" />
            <stop offset="55%" stopColor="#16234A" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#090D1A" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="pbBranch" cx={CX} cy={CY} r={RING + 30} gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#9FD0FF" stopOpacity="0.42" />
            <stop offset="45%" stopColor="#5C8DD6" stopOpacity="0.20" />
            <stop offset="100%" stopColor="#3A5A90" stopOpacity="0.05" />
          </radialGradient>
          <linearGradient id="pbHubFill" x1="0" y1="-1" x2="0" y2="1">
            <stop offset="0%" stopColor="#21386B" />
            <stop offset="100%" stopColor="#0E1B3C" />
          </linearGradient>
          <radialGradient id="pbVignette" cx="50%" cy="48%" r="62%">
            <stop offset="62%" stopColor="#000000" stopOpacity="0" />
            <stop offset="100%" stopColor="#04060D" stopOpacity="0.55" />
          </radialGradient>
          <filter id="pbSoft" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
          <filter id="pbSoftSm" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.4" />
          </filter>
          <style>{`
            @keyframes pbPulse { 0%,100%{opacity:.55} 50%{opacity:.85} }
            @keyframes pbTwinkle { 0%,100%{opacity:.5} 50%{opacity:1} }
            @keyframes pbHint { 0%,100%{opacity:.45} 50%{opacity:.8} }
            .pb-hub-ring{transition:opacity .55s cubic-bezier(.16,1,.3,1)}
            .pb-items{transition:opacity .6s cubic-bezier(.16,1,.3,1)}
            .pb-label,.pb-disc,.pb-icon,.pb-glow{transition:fill .4s ease,stroke .4s ease,opacity .4s ease,color .4s ease}
            .pb-arrow{transition:background .3s ease,border-color .3s ease,box-shadow .35s ease,transform .35s cubic-bezier(.16,1,.3,1)}
            .pb-arrow:hover{background:rgba(34,56,106,0.9)!important;border-color:rgba(124,180,255,0.6)!important;box-shadow:0 0 18px rgba(80,150,255,0.4);transform:translateY(-50%) scale(1.08)}
            .pb-arrow:active{transform:translateY(-50%) scale(0.96)}
            .pb-chip{transition:background .3s ease,border-color .3s ease,color .3s ease}
            .pb-chip:hover{background:rgba(34,56,106,0.7)!important;border-color:rgba(124,180,255,0.5)!important;color:#E6EEFF!important}
          `}</style>
        </defs>

        {STARS.map((s, i) => (
          <circle key={`s${i}`} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)} fill="#CFE0FF" opacity={s.o.toFixed(2)} style={{ animation: `pbTwinkle ${4 + (i % 5)}s ease-in-out ${i % 7}s infinite` }} />
        ))}

        {/* branches: tapered curved core->hub limb + outward twigs (path d set each frame) */}
        {hubs.map((h, i) => {
          const active = i === focusIndex;
          return (
            <g key={`b${h.id}`} className="pb-hub-ring" style={{ opacity: focusIndex !== null && !active ? 0.16 : 1 }}>
              <path
                ref={(el) => { branchRefs.current[i] = el; }}
                fill={active ? "rgba(245,200,90,0.22)" : "url(#pbBranch)"}
                className="pb-disc"
              />
              <path
                ref={(el) => { twigRefs.current[i] = el; }}
                fill="none"
                stroke={active ? "rgba(245,200,90,0.5)" : "rgba(140,180,235,0.34)"}
                strokeWidth={0.8}
                strokeLinecap="round"
                className="pb-disc"
              />
            </g>
          );
        })}

        {/* core: glow + filaments + luminous nucleus, transformed by the camera */}
        <g ref={coreRef}>
          <circle cx={CX} cy={CY} r={150} fill="url(#pbCoreGlow)" style={{ animation: "pbPulse 6s ease-in-out infinite" }} />
          {FILAMENTS.map((f, i) => (
            <g key={`f${i}`}>
              <line x1={CX} y1={CY} x2={f.x.toFixed(1)} y2={f.y.toFixed(1)} stroke={`rgba(150,200,255,${f.o.toFixed(2)})`} strokeWidth={0.6} />
              <circle cx={f.x.toFixed(1)} cy={f.y.toFixed(1)} r={f.r.toFixed(2)} fill="#AFD3FF" opacity={f.o.toFixed(2)} />
            </g>
          ))}
          <circle cx={CX} cy={CY} r={15} fill="#7FB6FF" opacity={0.5} filter="url(#pbSoft)" />
          <circle cx={CX} cy={CY} r={6.5} fill="#CFE6FF" opacity={0.6} filter="url(#pbSoftSm)" />
          <circle
            cx={CX}
            cy={CY}
            r={3.4}
            fill="#FFFFFF"
            style={{ cursor: focusIndex !== null ? "pointer" : "default" }}
            onClick={() => focusIndex !== null && setFocusIndex(null)}
          />
        </g>

        {/* hubs (positioned each frame; never rotated, so labels stay upright) */}
        {hubs.map((h, i) => {
          const active = i === focusIndex;
          const dim = focusIndex !== null && !active;
          const hit = matches(h.title);
          const lit = active || i === hovered;
          const Icon = hubIcon(h.title);
          const stroke = active ? "#F4C451" : lit || hit ? "#6FCBF7" : "rgba(190,205,235,0.5)";
          const iconColor = active ? "#F6CE6A" : lit || hit ? "#BCE2FF" : "#86A6D8";
          const glowFill = active ? "rgba(244,196,81,0.5)" : lit ? "rgba(108,203,247,0.42)" : "rgba(74,124,206,0.22)";
          const all = childrenOf(nodes, h.id);
          const count = all.length;
          const items = all.slice(0, MAX_ITEMS);
          const m = items.length;
          return (
            <g
              key={h.id}
              ref={(el) => { hubRefs.current[i] = el; }}
              className="pb-hub-ring"
              style={{ cursor: "pointer", opacity: dim ? 0.2 : 1 }}
              onClick={() => (active ? null : openHub(i))}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered((v) => (v === i ? null : v))}
            >
              {/* soft luminous halo */}
              <circle cx={0} cy={0} r={20} fill={glowFill} filter="url(#pbSoft)" className="pb-glow" />
              {active && <circle cx={0} cy={0} r={HUB_R + 7} fill="none" stroke="rgba(244,196,81,0.28)" strokeWidth={1.4} />}
              <circle cx={0} cy={0} r={HUB_R} fill="url(#pbHubFill)" stroke={stroke} strokeWidth={lit ? 1.8 : 1} className="pb-disc" />
              <g transform="translate(-9,-9)" style={{ color: iconColor }} className="pb-icon">
                <Icon width={18} height={18} strokeWidth={1.7} />
              </g>
              <text x={0} y={-HUB_R - 16} textAnchor="middle" fontSize={12.5} letterSpacing={2.2} fill={active ? "#F4C451" : lit ? "#E2ECFB" : "#C2D0EE"} className="pb-label" style={{ textTransform: "uppercase", fontWeight: 600 }}>{h.title}</text>
              <text x={0} y={-HUB_R - 4} textAnchor="middle" fontSize={8.5} letterSpacing={0.5} fill="#7585B0">{count === 0 ? "empty" : `${count} item${count === 1 ? "" : "s"}`}</text>

              {/* items fan out only when this hub is focused */}
              <g className="pb-items" style={{ opacity: active ? 1 : 0, pointerEvents: active ? "auto" : "none" }}>
                {items.map((it, j) => {
                  const spread = Math.min(26 * (m - 1), 150);
                  const a = (90 + (m > 1 ? (j / (m - 1) - 0.5) * spread : 0)) * RAD;
                  const r = 76;
                  const ix = Math.cos(a) * r;
                  const iy = Math.sin(a) * r;
                  const ihit = matches(it.title);
                  return (
                    <g key={it.id} onClick={(e) => { e.stopPropagation(); onSelectItem(it.id); }} style={{ cursor: "pointer" }}>
                      <path d={`M0,9 Q${(ix * 0.5 - iy * 0.12).toFixed(1)},${(iy * 0.5 + 9).toFixed(1)} ${ix.toFixed(1)},${iy.toFixed(1)}`} fill="none" stroke="rgba(140,180,235,0.34)" strokeWidth={0.7} strokeLinecap="round" />
                      <circle cx={ix.toFixed(1)} cy={iy.toFixed(1)} r={ihit ? 5 : 3.6} fill={ihit ? "#FFFFFF" : "#8FC0F2"} opacity={0.5} filter="url(#pbSoftSm)" />
                      <circle cx={ix.toFixed(1)} cy={iy.toFixed(1)} r={ihit ? 3.4 : 2.6} fill={ihit ? "#FFFFFF" : "#9CCBFA"} />
                      <text x={ix.toFixed(1)} y={(iy + (iy > 0 ? 13 : -8)).toFixed(1)} textAnchor="middle" fontSize={8} fill="#A6B8DC">{it.title.length > 22 ? it.title.slice(0, 21) + "…" : it.title}</text>
                    </g>
                  );
                })}
              </g>
            </g>
          );
        })}

        <rect x={0} y={0} width={W} height={H} fill="url(#pbVignette)" pointerEvents="none" />
      </svg>

      {/* overlay chrome */}
      {focusIndex === null ? (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 14, textAlign: "center", fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "rgba(159,178,216,0.65)", pointerEvents: "none", animation: "pbHint 4.5s ease-in-out infinite" }}>
          tap a section to explore
        </div>
      ) : (
        <>
          <button className="pb-arrow" aria-label="Previous section" onClick={() => spin(-1)} style={arrowStyle("left")}><ChevronLeft size={20} /></button>
          <button className="pb-arrow" aria-label="Next section" onClick={() => spin(1)} style={arrowStyle("right")}><ChevronRight size={20} /></button>
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 9, pointerEvents: "none" }}>
            <span style={{ fontSize: 11.5, letterSpacing: 2.4, textTransform: "uppercase", fontWeight: 600, color: "#D4E2FF" }}>{focusedHub?.title}</span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {hubs.map((h, i) => (
                <span key={h.id} style={{ width: i === focusIndex ? 18 : 6, height: 6, borderRadius: 3, background: i === focusIndex ? "#F4C451" : "rgba(159,178,216,0.35)", boxShadow: i === focusIndex ? "0 0 10px rgba(244,196,81,0.5)" : "none", transition: "all .45s cubic-bezier(.16,1,.3,1)" }} />
              ))}
            </div>
          </div>
          <button className="pb-chip" onClick={() => setFocusIndex(null)} style={{ position: "absolute", top: 13, right: 14, display: "inline-flex", alignItems: "center", fontSize: 11, letterSpacing: 1.4, textTransform: "uppercase", color: "rgba(180,198,235,0.8)", background: "rgba(16,28,58,0.55)", border: "0.5px solid rgba(150,170,210,0.28)", borderRadius: 9, padding: "5px 12px", cursor: "pointer", backdropFilter: "blur(3px)" }}>
            overview
          </button>
        </>
      )}
    </div>
  );
}

function arrowStyle(side: "left" | "right"): CSSProperties {
  return {
    position: "absolute",
    top: "50%",
    left: side === "left" ? 16 : undefined,
    right: side === "right" ? 16 : undefined,
    transform: "translateY(-50%)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
    borderRadius: "50%",
    background: "rgba(16,28,58,0.62)",
    border: "0.5px solid rgba(150,170,210,0.32)",
    color: "#CBD8F2",
    cursor: "pointer",
    backdropFilter: "blur(3px)",
  };
}
