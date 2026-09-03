import Link from "next/link";
import { authEnforced } from "@/lib/auth/guard";
import { getSessionUser } from "@/lib/auth/session";
import { getViewScope } from "@/lib/site-view";
import { readOsBand, type OsBand, type OsTile } from "@/lib/home/os-band";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// THE OPERATING SYSTEM BAND, drawn.
//
// A SERVER COMPONENT AND NOTHING ELSE. There is no state on this band, no
// toggle, no filter: it is six facts and six links. Making it a client
// component would ship the whole thing to the browser to render text that never
// changes after the response is written.
//
// IT IS DRAWN AS A SIBLING OF THE DASHBOARD'S OWN BAND, on purpose. Same
// hairline top and bottom in --line-strong, same hairline rules between the
// cells, same left rule as every heading on the page. The reference (PRODUCT.md)
// is Dentally's density, and the failure mode named there is a row of identical
// rounded metric tiles floating in white space — "generic SaaS dashboard" is on
// the anti-reference list. So these are cells of one instrument, not cards.
//
// AND IT IS QUIET. Every element is a fact or an action: a name, a figure, a
// noun, and — only where something actually needs a person — one amber dot. No
// LIVE tags, no explanatory chips, no uppercase micro-caps. The one place it
// says more than a phrase is under a system nobody has switched on yet, where
// the sentence IS the action.
// ---------------------------------------------------------------------------

/**
 * The band as the practice sees it. Pure and synchronous so a test can render it
 * with `renderToStaticMarkup` and read what a switched-off, empty, capped or
 * unreadable tile actually prints.
 */
export function OperatingSystemBandView({
  band,
  basePath,
}: {
  band: OsBand;
  /** "/c/<client>" or "/owner/<client>". Every tile href hangs off it. */
  basePath: string;
}) {
  // NOTHING TO SHOW IS NOTHING DRAWN. A clinician may reach none of these
  // modules, and an empty band under a heading reads as a broken feature.
  if (band.tiles.length === 0) return null;

  return (
    <section aria-labelledby="os-band-heading" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="os-band-heading" className="text-[15px] font-semibold tracking-[-0.3px] text-navy">
          Operating system
        </h2>
        {band.switchesUnreadable ? (
          <p className="text-xs text-warning">
            The system switches could not be read just now, so nothing below is showing its state.
          </p>
        ) : null}
      </div>

      {/* HAIRLINES WITHOUT A PER-INDEX CLASS PER BREAKPOINT. Every cell draws a
          rule on its top and its left; the grid is pulled up and left by one
          pixel and the band clips the overflow, so the outer top and left rules
          disappear and only the internal ones survive — at one, two, three or
          six columns, with no arithmetic about which cell starts a row.

          The band's own top and bottom are --line-strong and the internal rules
          are --line, the same two weights the dashboard's band above it uses, so
          the two read as one instrument with a boundary rather than as a grid of
          cards. The colours are INLINE for the reason the dashboard documents at
          length: globals.css carries an unlayered `* { border-color: var(--line) }`
          that beats every Tailwind border utility, so a class here would say one
          thing and draw another. */}
      <div
        style={{ borderTopColor: "var(--line-strong)", borderBottomColor: "var(--line-strong)" }}
        className="overflow-hidden border-y"
      >
        <div className="-ml-px -mt-px grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {band.tiles.map((tile) => (
            <Tile key={tile.key} tile={tile} basePath={basePath} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** One cell of the band: a rule on the top and the left, both clipped at the edges. */
const CELL =
  "flex min-w-0 flex-col gap-0.5 border-l border-t px-4 py-2.5 transition-colors hover:bg-card-muted/60";

function Tile({ tile, basePath }: { tile: OsTile; basePath: string }) {
  return (
    <Link
      href={`${basePath}${tile.path}`}
      style={{ borderTopColor: "var(--line)", borderLeftColor: "var(--line)" }}
      className={cn(
        CELL,
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30",
      )}
    >
      <span className="flex items-center gap-1.5">
        <span className="truncate text-[12px] font-semibold text-navy">{tile.label}</span>
        {tile.enabled === false ? (
          <span className="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-semibold text-warning">
            Off
          </span>
        ) : null}
      </span>
      <TileState tile={tile} />
    </Link>
  );
}

function TileState({ tile }: { tile: OsTile }) {
  const state = tile.state;

  if (state.kind === "unreadable") {
    return <span className="text-xs text-muted">Not readable just now</span>;
  }

  if (state.kind === "off" || state.kind === "empty") {
    return (
      <>
        {/* "Off" and "Nothing yet" are DIFFERENT sentences and neither of them is
            "0". A switched-off system is not watching; an empty one is watching
            and has nothing to watch. Printing a zero for either is the dishonesty
            this band exists to avoid. */}
        <span className="text-[13px] font-semibold text-navy">
          {state.kind === "off" ? "Off" : "Nothing yet"}
        </span>
        {state.firstStep ? (
          <span className="line-clamp-2 text-[11px] leading-snug text-muted">{state.firstStep}</span>
        ) : null}
      </>
    );
  }

  if (state.kind === "fact") {
    return (
      <span className="flex items-center gap-1.5">
        {state.tone === "attention" ? (
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-amber" />
        ) : null}
        <span className="truncate text-[13px] font-semibold text-navy">{state.text}</span>
      </span>
    );
  }

  return (
    <span className="flex items-baseline gap-1.5">
      {state.tone === "attention" ? (
        <span aria-hidden className="size-1.5 shrink-0 self-center rounded-full bg-status-amber" />
      ) : null}
      <span className="text-[15px] font-semibold tabular-nums text-navy">
        {/* A capped read is a FLOOR. "at least 200" is the honest rendering of a
            query that stopped counting; "200" would be a total it never proved. */}
        {state.atLeast ? `at least ${state.value}` : state.value}
      </span>
      <span className="truncate text-[11px] text-muted">{state.noun}</span>
    </span>
  );
}

/**
 * The band with its own reads done: the session's role, the top bar's site scope,
 * and one bounded query per tile that has a number worth printing.
 *
 * Both home pages render exactly this line, so the two trees cannot disagree
 * about what the practice's own operating system is doing.
 */
export async function OperatingSystemBand({
  clientId,
  clientSlug,
  tree,
}: {
  clientId: string;
  clientSlug: string;
  tree: "client" | "owner";
}) {
  // A null role is the UNENFORCED pilot (no service-role key, so no sessions),
  // and it resolves to "show everything" here to match every other guard in this
  // codebase. `getSessionUser` is React-cached per request and the shell's guard
  // has already resolved it, so this costs no extra round-trip.
  const role = authEnforced() ? (await getSessionUser())?.role ?? null : null;
  const scope = await getViewScope(clientId);
  const band = await readOsBand({ clientId, siteIds: scope.siteIds, role, tree });
  return (
    <OperatingSystemBandView
      band={band}
      basePath={`${tree === "owner" ? "/owner" : "/c"}/${clientSlug}`}
    />
  );
}
