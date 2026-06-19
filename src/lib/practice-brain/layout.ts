import type { Tier } from "./types";

export interface HubInput {
  id: string;
  title: string;
  tier: Tier;
  leaves: { id: string; title: string; tier: Tier }[];
}

export interface PlacedHub {
  id: string;
  title: string;
  tier: Tier;
  x: number;
  y: number;
  angle: number;
  leafCount: number;
}

export interface PlacedLeaf {
  id: string;
  hubId: string;
  title: string;
  tier: Tier;
  x: number;
  y: number;
}

export interface Constellation {
  center: { x: number; y: number };
  hubs: PlacedHub[];
  leaves: PlacedLeaf[];
}

const MAX_LEAVES = 10;

/** Deterministic radial layout: hubs on a ring, leaves fanned outward from each hub. */
export function layoutConstellation(
  hubsIn: HubInput[],
  opts: { width: number; height: number },
): Constellation {
  const { width, height } = opts;
  const center = { x: width / 2, y: height / 2 };
  const ringRadius = Math.min(width, height) * 0.3;
  const leafRadius = Math.min(width, height) * 0.18;
  const n = Math.max(hubsIn.length, 1);

  const clampX = (x: number) => Math.max(0, Math.min(width, x));
  const clampY = (y: number) => Math.max(0, Math.min(height, y));

  const hubs: PlacedHub[] = [];
  const leaves: PlacedLeaf[] = [];

  hubsIn.forEach((hub, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const hx = clampX(center.x + Math.cos(angle) * ringRadius);
    const hy = clampY(center.y + Math.sin(angle) * ringRadius);
    hubs.push({ id: hub.id, title: hub.title, tier: hub.tier, x: hx, y: hy, angle, leafCount: hub.leaves.length });

    const shown = hub.leaves.slice(0, MAX_LEAVES);
    const spread = Math.PI / 3;
    const m = shown.length;
    shown.forEach((leaf, j) => {
      const offset = m > 1 ? spread * (j / (m - 1) - 0.5) : 0;
      const la = angle + offset;
      const lx = clampX(hx + Math.cos(la) * leafRadius);
      const ly = clampY(hy + Math.sin(la) * leafRadius);
      leaves.push({ id: leaf.id, hubId: hub.id, title: leaf.title, tier: leaf.tier, x: lx, y: ly });
    });
  });

  return { center, hubs, leaves };
}
