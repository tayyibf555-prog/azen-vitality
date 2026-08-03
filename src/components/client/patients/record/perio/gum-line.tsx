import {
  ARCH_LABEL,
  ASPECT_LABEL,
  DEEP_POCKET_MM,
  describeGumProfile,
  describeGumScale,
  rulerLines,
  toPointsAttribute,
} from "@/lib/perio/gum-profile";
import type { GumProfile, GumSegment, GumVertex } from "@/lib/perio/gum-profile";

// ===========================================================================
// THE GUM LINE — a thin renderer over gum-profile.ts, and nothing else.
//
// NOT ONE COORDINATE IS COMPUTED HERE. Every x, y, polygon and gridline arrives
// already placed from the pure module, because vitest collects no .tsx in this
// repo and the millimetre-to-screen mapping is the part that has to be tested. A
// second mapping living in a component is a second answer, and the one on screen
// is the one a clinician acts on.
//
// THE DRAWING IS DERIVED, NEVER AN INPUT. There is no pointer handler, no drag
// affordance and no inverse mapping anywhere in this file, deliberately. A gum
// line a clinician can nudge with a mouse is a recorded clinical finding edited
// by eye — the numbers are the record, this is a reading of them. gum-profile
// exports no screen-units-to-millimetres function for the same reason.
//
// A GAP IS DRAWN AS A GAP. Where a site holds no reading the polyline STOPS and
// a hatched strip says why. A smooth line through an unprobed site is an invented
// clinical finding, and a blank space is the "false completeness" failure
// CHARTING.md §6.3 names — a reader in twenty seconds between patients reads
// white space as health. So the strip is marked and labelled, both.
//
// NO "use client". This renders from the server perio tab. The perio client
// boundary test pins which files in this directory may be islands and this is not
// one of them; nothing here holds state, and there is nothing to hold.
// ===========================================================================

export interface GumLineProps {
  /** Already built, by the caller, from the chart. Four rows: upper and lower,
   *  buccal and lingual. */
  profiles: GumProfile[];
  /**
   * The scope sentence for the chart these rows come from — describeCoverage()'s
   * output. Not optional in substance: a partial chart drawn without it reads as
   * a whole mouth, which is the failure this module is most able to cause.
   */
  scopeNote?: string | null;
  /** Sits above the rows. Plain text; no node, so a server parent can pass it. */
  heading?: string;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Ruler({ profile }: { profile: GumProfile }) {
  return (
    <g aria-hidden="true">
      {rulerLines(profile).map((line) => (
        <g key={line.mm}>
          <line
            x1={0}
            x2={profile.width}
            y1={line.y}
            y2={line.y}
            stroke="currentColor"
            strokeWidth={line.major ? 0.7 : 0.35}
            className={line.major ? "text-line-strong" : "text-line"}
          />
          {line.label ? (
            <text
              x={2}
              y={line.y - 1.5}
              fontSize={5}
              fill="currentColor"
              className="text-faint"
            >
              {line.label}
            </text>
          ) : null}
        </g>
      ))}
    </g>
  );
}

function Teeth({ profile }: { profile: GumProfile }) {
  return (
    <g>
      {profile.teeth.map((tooth) => {
        const absent = tooth.presence === "absent";
        return (
          <g key={tooth.tooth}>
            <polygon
              points={toPointsAttribute(tooth.outline.root)}
              fill="currentColor"
              fillOpacity={absent ? 0.04 : 0.1}
              stroke="currentColor"
              strokeOpacity={absent ? 0.12 : 0.3}
              strokeWidth={0.4}
              className={absent ? "text-faint" : "text-muted"}
            />
            <rect
              x={tooth.outline.crown.x}
              y={tooth.outline.crown.y}
              width={tooth.outline.crown.width}
              height={tooth.outline.crown.height}
              rx={1.5}
              fill="currentColor"
              fillOpacity={absent ? 0.05 : 0.16}
              stroke="currentColor"
              strokeOpacity={absent ? 0.14 : 0.34}
              strokeWidth={0.4}
              className={absent ? "text-faint" : "text-muted"}
            />
            <text
              x={tooth.centreX}
              y={tooth.labelY}
              fontSize={6}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="currentColor"
              className={absent ? "text-faint" : "text-navy"}
            >
              {absent ? "—" : tooth.tooth}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** One pattern id per row. Four SVGs share this document, and two elements with
 *  the same id is a reference that resolves to whichever one loaded first. */
function hatchId(profile: GumProfile): string {
  return `gum-not-recorded-${profile.arch}-${profile.aspect}`;
}

/** The gap, drawn AS a gap. Hatched, titled, and never left as white space. */
function Breaks({ profile }: { profile: GumProfile }) {
  return (
    <g>
      {profile.breaks.map((gap) => (
        <rect
          key={gap.fromColumn}
          x={gap.x}
          y={0}
          width={gap.width}
          height={profile.height}
          fill={`url(#${hatchId(profile)})`}
        >
          <title>{gap.note}</title>
        </rect>
      ))}
    </g>
  );
}

/** Dentally underlines a depth of 4mm or more in red. Same threshold, same
 *  colour, on the same site — so a hygienist reads one habit across two screens. */
function DeepMarks({ profile }: { profile: GumProfile }) {
  if (profile.deepColumns.length === 0) return null;
  return (
    <g className="text-status-red">
      {profile.deepColumns.map((index) => (
        <rect
          key={index}
          x={profile.columns[index].left}
          y={profile.apicalSign === -1 ? profile.height - 2.4 : 0}
          width={profile.columns[index].width}
          height={2.4}
          fill="currentColor"
        >
          {/* One string, deliberately. React cannot render an <title> whose
              children are an array, and a title that fails to render is a
              tooltip a clinician silently never gets. */}
          <title>
            {`${DEEP_POCKET_MM}mm or deeper at tooth ${profile.columns[index].tooth}, ${profile.columns[index].site}.`}
          </title>
        </rect>
      ))}
    </g>
  );
}

/** The pocket itself: the area between the two lines. */
function Bands({ profile }: { profile: GumProfile }) {
  return (
    <g className="text-status-red">
      {profile.bands.map((band) => (
        <polygon
          key={band.columns[0]}
          points={toPointsAttribute(band.points)}
          fill="currentColor"
          fillOpacity={band.deepestMm >= DEEP_POCKET_MM ? 0.24 : 0.12}
          stroke="none"
        >
          <title>
            {band.deepestMm === 0
              ? "No pocket here: the probe stopped at the gingival margin."
              : `Pocket, deepest ${band.deepestMm}mm across these sites.`}
          </title>
        </polygon>
      ))}
    </g>
  );
}

/**
 * One line. A run of a single measured site is a DOT, never a line — a polyline
 * of one point draws nothing at all, and a site somebody probed must not vanish
 * because its neighbours were skipped.
 */
function Line({
  segments,
  vertices,
  className,
  strokeWidth,
  dotRadius,
}: {
  segments: GumSegment[];
  vertices: GumVertex[];
  className: string;
  strokeWidth: number;
  dotRadius: number;
}) {
  return (
    <g className={className}>
      {segments
        .filter((segment) => segment.points.length > 1)
        .map((segment) => (
          <polyline
            key={segment.points[0].column}
            points={toPointsAttribute(segment.points)}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
      {vertices.map((vertex) => (
        <circle
          key={vertex.column}
          cx={vertex.x}
          cy={vertex.y}
          r={vertex.clipped ? dotRadius + 0.8 : dotRadius}
          fill="currentColor"
          stroke={vertex.clipped ? "currentColor" : "none"}
          strokeWidth={vertex.clipped ? 1.2 : 0}
          fillOpacity={vertex.clipped ? 0.4 : 1}
        >
          <title>
            {vertex.clipped
              ? `${vertex.mm}mm — beyond the drawn range, shown at the edge.`
              : `${vertex.mm}mm`}
          </title>
        </circle>
      ))}
    </g>
  );
}

/** Bleeding on probing, at the margin. Dentally colours a bleeding surface red;
 *  this puts the same fact where the gum line already has the reader's eye. */
function Bleeding({ profile }: { profile: GumProfile }) {
  const bleeding = profile.marginVertices.filter((v) => v.bleeding);
  if (bleeding.length === 0) return null;
  return (
    <g className="text-status-red">
      {bleeding.map((vertex) => (
        <circle key={vertex.column} cx={vertex.x} cy={vertex.y} r={2.6} fill="currentColor" fillOpacity={0.85}>
          <title>Bleeding on probing.</title>
        </circle>
      ))}
    </g>
  );
}

// ---------------------------------------------------------------------------
// A row
// ---------------------------------------------------------------------------

function Row({ profile }: { profile: GumProfile }) {
  const sentence = describeGumProfile(profile);
  const deep = profile.deepColumns.length;
  return (
    <div className="rounded-lg border border-line bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line px-3 py-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-navy">
          {ARCH_LABEL[profile.arch]} · {ASPECT_LABEL[profile.aspect]}
        </div>
        {deep > 0 ? (
          <div className="text-[11px] font-semibold text-status-red">
            {deep} {deep === 1 ? "site" : "sites"} at {DEEP_POCKET_MM}mm or deeper
          </div>
        ) : null}
      </div>
      <div className="overflow-x-auto px-3 py-2">
        <svg
          viewBox={`0 0 ${profile.width} ${profile.height}`}
          width="100%"
          role="img"
          aria-label={sentence}
          className="block min-w-[560px]"
        >
          <defs>
            <pattern
              id={hatchId(profile)}
              width={4}
              height={4}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line
                x1={0}
                y1={0}
                x2={0}
                y2={4}
                stroke="currentColor"
                strokeWidth={1}
                className="text-faint"
                opacity={0.28}
              />
            </pattern>
          </defs>
          <Ruler profile={profile} />
          <Teeth profile={profile} />
          <Breaks profile={profile} />
          <line
            x1={0}
            x2={profile.width}
            y1={profile.cejY}
            y2={profile.cejY}
            stroke="currentColor"
            strokeWidth={0.9}
            className="text-navy"
          />
          <Bands profile={profile} />
          <Line
            segments={profile.base}
            vertices={profile.baseVertices}
            className="text-status-red"
            strokeWidth={1.4}
            dotRadius={1.3}
          />
          <Line
            segments={profile.margin}
            vertices={profile.marginVertices}
            className="text-status-blue"
            strokeWidth={1.4}
            dotRadius={1.3}
          />
          <Bleeding profile={profile} />
          <DeepMarks profile={profile} />
        </svg>
      </div>
      <p className="border-t border-line px-3 py-2 text-[11px] leading-tight text-muted">
        {sentence}
      </p>
      {profile.depthWithoutRecession.length > 0 ? (
        <p className="border-t border-line px-3 py-2 text-[11px] leading-tight text-status-amber">
          {profile.depthWithoutRecession.length}{" "}
          {profile.depthWithoutRecession.length === 1 ? "site has" : "sites have"} a probing depth
          but no recession, so neither line can be placed there. A recession of zero was not assumed.
        </p>
      ) : null}
      {profile.unplacedTeeth.length > 0 ? (
        <p className="border-t border-line px-3 py-2 text-[11px] leading-tight text-status-amber">
          Charted, and not drawn on this arch: {profile.unplacedTeeth.join(", ")}. Their readings are
          in the chart above.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The legend. A chart nobody can decode is a chart nobody trusts.
// ---------------------------------------------------------------------------

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] leading-tight text-muted">
      <li>
        <span className="mr-1 font-semibold text-status-blue">———</span>
        gingival margin, from recession
      </li>
      <li>
        <span className="mr-1 font-semibold text-status-red">———</span>
        base of the pocket, at the attachment level
      </li>
      <li>
        <span className="mr-1 font-semibold text-status-red">▨</span>
        the pocket between them
      </li>
      <li>
        <span className="mr-1 font-semibold text-faint">▨</span>
        not recorded — never joined across
      </li>
      <li>
        <span className="mr-1 font-semibold text-navy">———</span>
        cemento-enamel junction, 0mm
      </li>
      <li>
        <span className="mr-1 font-semibold text-status-red">▬</span>
        {DEEP_POCKET_MM}mm or deeper, as Dentally marks it
      </li>
    </ul>
  );
}

// ---------------------------------------------------------------------------

export function GumLine({ profiles, scopeNote, heading }: GumLineProps) {
  return (
    <section className="space-y-2">
      <div className="space-y-1">
        <h3 className="text-[13px] font-semibold text-navy">{heading ?? "Gum line"}</h3>
        <p className="text-[11px] leading-tight text-muted">
          The picture is drawn FROM the numbers and cannot be drawn on. To change a reading, change
          the reading.
        </p>
        {scopeNote ? (
          <p className="text-[11px] font-medium leading-tight text-navy">{scopeNote}</p>
        ) : null}
      </div>
      <Legend />
      <div className="space-y-2">
        {profiles.map((profile) => (
          <Row key={`${profile.arch}-${profile.aspect}`} profile={profile} />
        ))}
      </div>
      <p className="text-[11px] leading-tight text-faint">{describeGumScale()}</p>
    </section>
  );
}
