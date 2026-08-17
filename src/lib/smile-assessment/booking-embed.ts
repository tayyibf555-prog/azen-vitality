// MAY THIS FUNNEL PUT A REAL BOOKING CALENDAR ON ITS RESULT SCREEN, AND FOR WHICH
// PRACTICE DIARY? (C1.)
//
// The one place that answer is decided. Every input is already in the browser by
// the time the result screen renders, and the temptation is to write the decision
// as a `&&` chain in the JSX - which is exactly how a gate stops being a gate:
// vitest collects src/**\/*.test.ts only, so a rule inside a component is a rule
// no test can reach, and this particular rule guards a REAL APPOINTMENT IN A REAL
// PRACTICE DIARY.
//
// THE FOUR THINGS IT WEIGHS, and what each one actually protects:
//
//   THE AUTHORED BLOCK. Did the owner put a booking invitation on THIS result
//   screen (flow.ts, the `booking` block kind)? No block, no offer - the funnel
//   behaves exactly as it did before C1 and keeps its plain link to /book.
//
//   THE BOOKING URL, which is the KILL SWITCH ARRIVING BY POST. submit/route.ts
//   builds `/book/<client>?site=<siteId>` only when isSystemEnabled(client,
//   "online-booking") says yes, and omits the field entirely when it does not. So
//   an absent bookingUrl IS the owner's switch, resolved on the server where it
//   belongs, and nothing in the browser can talk its way past it.
//
//   THE SITE, TAKEN FROM THAT URL AND CHECKED AGAINST THE CAMPAIGN'S OWN. The
//   public /book page falls back to the practice's FIRST site for an unknown
//   ?site= (book/[client]/page.tsx) - display-only there, and catastrophic here: a
//   multi-site practice would book a funnel's patient into a diary in another
//   town. Every booking API re-validates that a site belongs to the client, but
//   none of them checks it is the site this CAMPAIGN runs at. So the two are
//   compared here, and a mismatch means no embedded calendar at all rather than a
//   calendar for the wrong building.
//
//   PREVIEW MODE, which is the highest-severity failure this whole feature can
//   have. campaigns-panel.tsx embeds the live public page in an iframe so an owner
//   can click through their own funnel (?preview=1). The quiz already refuses to
//   submit there. A mounted booking calendar would not care: it would hold a slot
//   and write a real appointment for a real patient's time, from a preview. So
//   "preview" is a status of its own - the button is still drawn, because a
//   preview that hides half the screen is not a preview, and it is INERT, because
//   the caller has nothing to mount from it.
//
// PURE, and imports nothing at all. Reachable from the browser through
// deterministic-assessment-quiz.tsx, so it holds the same boundary flow.ts and
// flow-block-view.ts hold: no ./quiz, no scoring weights, no server modules.

/** The site a booking calendar would be mounted for, and the words above it. */
export interface BookingEmbedTarget {
  status: "ready";
  /** The campaign's own site. Never a fallback, never the practice's first. */
  siteId: string;
  /** What the patient sees the appointment is at. */
  siteName: string;
  headline: string;
  blurb: string;
}

/**
 * What the result screen may offer.
 *
 * THREE STATES RATHER THAN A BOOLEAN, because "no" has two different meanings and
 * the screen has to draw them differently. "off" is nothing at all - the funnel
 * renders what it rendered before C1. "preview" is the offer, visible and dead,
 * with a line saying why. Only "ready" carries a site, and it is the only shape
 * <BookingCalendar> can be built from, which is what makes an unmountable state
 * unmountable rather than merely discouraged.
 */
export type BookingEmbed =
  | { status: "off" }
  | { status: "preview"; headline: string; blurb: string }
  | BookingEmbedTarget;

const OFF: BookingEmbed = { status: "off" };

/**
 * The `site` parameter of a booking URL the SERVER minted, or null.
 *
 * PARSED BY HAND rather than through `new URL()`, and that is the point: URL needs
 * a base for a relative path, and giving it one turns a value that arrived in a
 * JSON body into something that can be resolved against an origin. Nothing here
 * resolves, fetches or navigates - it reads one query parameter out of a string
 * and hands back the text.
 *
 * FIRST `site=` WINS, matching how every server-side parser this build has already
 * reads a duplicated parameter, so a URL carrying two of them cannot mean one
 * thing to this check and another to the API that re-validates it.
 */
export function bookingSiteFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const q = url.indexOf("?");
  if (q < 0) return null;
  const hash = url.indexOf("#");
  const query = hash > q ? url.slice(q + 1, hash) : url.slice(q + 1);
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq) !== "site") continue;
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    } catch {
      // A malformed percent-escape is not a site id. Refuse rather than guess.
      return null;
    }
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  return null;
}

function clean(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * THE GATE. Everything above, in the order that makes each refusal say the truest
 * thing about why.
 *
 * PREVIEW IS TESTED LAST, ON PURPOSE. An owner's preview must show the screen a
 * patient would actually get: if a live patient would see no booking button
 * (because the switch is off, or the site does not line up), the preview must show
 * no booking button either. Testing preview first would draw an inert offer on a
 * funnel that has none, which is a preview lying about the funnel it previews.
 */
export function bookingEmbed(input: {
  /** submit/route.ts's `bookingUrl`. Absent = the online-booking switch is off. */
  bookingUrl?: string | null;
  /** The authored booking block on the result screen this patient landed on. */
  block?: { headline: string; blurb: string } | null;
  /** The CAMPAIGN's site, resolved server-side by the page. Never sites[0]. */
  site?: { id: string; name: string } | null;
  previewMode?: boolean;
}): BookingEmbed {
  const headline = clean(input.block?.headline);
  const blurb = clean(input.block?.blurb);
  if (!headline || !blurb) return OFF;

  const wanted = bookingSiteFromUrl(input.bookingUrl);
  if (!wanted) return OFF;

  const siteId = clean(input.site?.id);
  const siteName = clean(input.site?.name);
  if (!siteId || !siteName) return OFF;
  if (siteId !== wanted) return OFF;

  if (input.previewMode) return { status: "preview", headline, blurb };
  return { status: "ready", siteId, siteName, headline, blurb };
}
