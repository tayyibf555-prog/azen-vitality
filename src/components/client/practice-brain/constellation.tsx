"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { KnowledgeNode } from "@/lib/practice-brain/types";
import { childrenOf } from "@/lib/practice-brain/clearance";

/**
 * The Practice Brain constellation.
 *
 * Overview: hubs ride a slow-drifting ring around a luminous core.
 * Click a hub to zoom into it, its items fan out below. Prev/next arrows spin the
 * ring to the neighbouring section. Motion is rAF-driven (exponential ease-out, no
 * bounce) and positions are set imperatively so labels never rotate out of true.
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

// Deterministic scenery, generated once at module load (not in render).
function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
const STARS = (() => {
  const rnd = seeded(9);
  return Array.from({ length: 120 }, () => ({ x: rnd() * W, y: rnd() * H, r: rnd() * 1.1 + 0.3, o: rnd() * 0.45 + 0.12 }));
})();
const FILAMENTS = (() => {
  const rnd = seeded(7);
  return Array.from({ length: 64 }, () => {
    const a = rnd() * Math.PI * 2;
    const L = rnd() * 42 + 6;
    return { x: CX + Math.cos(a) * L, y: CY + Math.sin(a) * L, r: rnd() * 1.1 + 0.5, o: 0.7 - L / 70 };
  });
})();

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

  const rot = useRef(0);
  const targetRot = useRef(0);
  const zoom = useRef(0);
  const focusRef = useRef<number | null>(null);
  const stepRef = useRef(step);
  const coreRef = useRef<SVGGElement | null>(null);
  const hubRefs = useRef<(SVGGElement | null)[]>([]);
  const lineRefs = useRef<(SVGLineElement | null)[]>([]);

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
        const line = lineRefs.current[i];
        if (line) {
          line.setAttribute("x1", coreX.toFixed(2));
          line.setAttribute("y1", coreY.toFixed(2));
          line.setAttribute("x2", hx.toFixed(2));
          line.setAttribute("y2", hy.toFixed(2));
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
    <div style={{ position: "relative", width: "100%", background: "#0A0E1A", borderRadius: 14, overflow: "hidden", border: "0.5px solid rgba(150,170,210,0.16)" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img" aria-label="Practice brain constellation">
        <defs>
          <radialGradient id="pbCoreGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#1C2E55" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#0A0E1A" stopOpacity="0" />
          </radialGradient>
          <style>{`
            @keyframes pbPulse { 0%,100%{opacity:.22} 50%{opacity:.4} }
            @keyframes pbTwinkle { 0%,100%{opacity:.5} 50%{opacity:1} }
            .pb-hub-ring{transition:opacity .5s ease,stroke .4s ease}
            .pb-items{transition:opacity .6s cubic-bezier(.16,1,.3,1)}
            .pb-label{transition:fill .4s ease}
          `}</style>
        </defs>

        {STARS.map((s, i) => (
          <circle key={`s${i}`} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)} fill="#CFE0FF" opacity={s.o.toFixed(2)} style={{ animation: `pbTwinkle ${4 + (i % 5)}s ease-in-out ${i % 7}s infinite` }} />
        ))}

        {/* core: filaments + glow, transformed by the camera */}
        <g ref={coreRef}>
          <circle cx={CX} cy={CY} r={150} fill="url(#pbCoreGlow)" style={{ animation: "pbPulse 6s ease-in-out infinite" }} />
          {FILAMENTS.map((f, i) => (
            <g key={`f${i}`}>
              <line x1={CX} y1={CY} x2={f.x.toFixed(1)} y2={f.y.toFixed(1)} stroke={`rgba(150,200,255,${f.o.toFixed(2)})`} strokeWidth={0.6} />
              <circle cx={f.x.toFixed(1)} cy={f.y.toFixed(1)} r={f.r.toFixed(2)} fill="#AFD3FF" opacity={f.o.toFixed(2)} />
            </g>
          ))}
          <circle cx={CX} cy={CY} r={6.5} fill="#BFE0FF" opacity={0.35} />
          <circle
            cx={CX}
            cy={CY}
            r={3}
            fill="#FFFFFF"
            style={{ cursor: focusIndex !== null ? "pointer" : "default" }}
            onClick={() => focusIndex !== null && setFocusIndex(null)}
          />
        </g>

        {/* connectors (positioned each frame) */}
        {hubs.map((h, i) => (
          <line
            key={`l${h.id}`}
            ref={(el) => { lineRefs.current[i] = el; }}
            stroke={i === focusIndex ? "rgba(244,196,81,0.45)" : "rgba(124,166,226,0.2)"}
            strokeWidth={i === focusIndex ? 1.1 : 0.7}
            className="pb-hub-ring"
          />
        ))}

        {/* hubs (positioned each frame; never rotated, so labels stay upright) */}
        {hubs.map((h, i) => {
          const active = i === focusIndex;
          const dim = focusIndex !== null && !active;
          const hit = matches(h.title);
          const stroke = active ? "#F4C451" : hit ? "#5BC4F7" : "rgba(190,205,235,0.5)";
          const items = childrenOf(nodes, h.id).slice(0, MAX_ITEMS);
          const m = items.length;
          return (
            <g
              key={h.id}
              ref={(el) => { hubRefs.current[i] = el; }}
              className="pb-hub-ring"
              style={{ cursor: "pointer", opacity: dim ? 0.18 : 1 }}
              onClick={() => (active ? null : openHub(i))}
            >
              {active && <circle cx={0} cy={0} r={24} fill="none" stroke="rgba(244,196,81,0.22)" strokeWidth={6} />}
              <circle cx={0} cy={0} r={15} fill="#12224A" stroke={stroke} strokeWidth={active ? 1.6 : 1} />
              <text x={0} y={-26} textAnchor="middle" fontSize={13} letterSpacing={2} fill={active ? "#F4C451" : "#C8D4F0"} className="pb-label" style={{ textTransform: "uppercase" }}>{h.title}</text>
              <text x={0} y={-12} textAnchor="middle" fontSize={9} fill="#7081AC">{childrenOf(nodes, h.id).length} items</text>

              {/* items fan out only when this hub is focused */}
              <g className="pb-items" style={{ opacity: active ? 1 : 0, pointerEvents: active ? "auto" : "none" }}>
                {items.map((it, j) => {
                  const spread = Math.min(26 * (m - 1), 150);
                  const a = (90 + (m > 1 ? (j / (m - 1) - 0.5) * spread : 0)) * RAD;
                  const r = 74;
                  const ix = Math.cos(a) * r;
                  const iy = Math.sin(a) * r;
                  const ihit = matches(it.title);
                  return (
                    <g key={it.id} onClick={(e) => { e.stopPropagation(); onSelectItem(it.id); }} style={{ cursor: "pointer" }}>
                      <line x1={0} y1={6} x2={ix.toFixed(1)} y2={iy.toFixed(1)} stroke="rgba(124,166,226,0.25)" strokeWidth={0.5} />
                      <circle cx={ix.toFixed(1)} cy={iy.toFixed(1)} r={ihit ? 4 : 3} fill={ihit ? "#FFFFFF" : "#79ADE8"} />
                      <text x={ix.toFixed(1)} y={(iy + (iy > 0 ? 12 : -8)).toFixed(1)} textAnchor="middle" fontSize={8} fill="#9FB2D8">{it.title.length > 22 ? it.title.slice(0, 21) + "…" : it.title}</text>
                    </g>
                  );
                })}
              </g>
            </g>
          );
        })}
      </svg>

      {/* overlay chrome */}
      {focusIndex === null ? (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 12, textAlign: "center", fontSize: 11, letterSpacing: 1, color: "rgba(159,178,216,0.6)", pointerEvents: "none" }}>
          tap a section to explore
        </div>
      ) : (
        <>
          <button aria-label="Previous section" onClick={() => spin(-1)} style={arrowStyle("left")}>{"‹"}</button>
          <button aria-label="Next section" onClick={() => spin(1)} style={arrowStyle("right")}>{"›"}</button>
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 14, textAlign: "center", pointerEvents: "none" }}>
            <span style={{ fontSize: 11, letterSpacing: 1.5, color: "rgba(159,178,216,0.65)" }}>
              {focusedHub?.title} · {(focusIndex ?? 0) + 1} / {n}
            </span>
          </div>
          <button onClick={() => setFocusIndex(null)} style={{ position: "absolute", top: 12, right: 14, fontSize: 11, letterSpacing: 1, color: "rgba(159,178,216,0.75)", background: "transparent", border: "0.5px solid rgba(150,170,210,0.25)", borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>
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
    left: side === "left" ? 14 : undefined,
    right: side === "right" ? 14 : undefined,
    transform: "translateY(-50%)",
    width: 38,
    height: 38,
    borderRadius: "50%",
    background: "rgba(18,34,74,0.6)",
    border: "0.5px solid rgba(150,170,210,0.3)",
    color: "#C8D4F0",
    fontSize: 20,
    lineHeight: "34px",
    cursor: "pointer",
    backdropFilter: "blur(2px)",
  };
}
