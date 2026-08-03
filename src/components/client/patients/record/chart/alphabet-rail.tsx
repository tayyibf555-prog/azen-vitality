import { cn } from "@/lib/utils";
import type { AlphabetBucket } from "@/lib/charting/treatment-list";

/**
 * The vertical quick-link index down the right of the treatment list: the favourites
 * star, then 0 to 9, then A to Z. Thirty-seven keys, exactly as Dentally draws it.
 *
 * ALL THIRTY-SEVEN ARE ALWAYS RENDERED. A rail that hides its empty letters changes
 * length as the search box is typed into, so the letter under the reader's finger
 * moves, and a Dentally user reaching for "N" by muscle memory lands on something
 * else. An empty bucket is drawn in place, visibly inert, with its own count in the
 * title, which is more information than hiding it and no less honest.
 *
 * The buckets and their counts come from A-logic's alphabetBuckets(); this file
 * computes nothing. The scroll target is resolved through `idFor`, so the panel owns
 * the DOM ids of its group headings and the two cannot drift apart.
 */
export function AlphabetRail({
  buckets,
  idFor,
  className,
}: {
  buckets: AlphabetBucket[];
  /** The DOM id of the list group heading for a bucket key. */
  idFor: (key: string) => string;
  className?: string;
}) {
  return (
    <nav
      aria-label="Jump to treatment group"
      className={cn(
        "flex w-[19px] shrink-0 flex-col items-stretch gap-px overflow-y-auto border-l border-line py-1",
        className,
      )}
    >
      {buckets.map((bucket) => {
        const empty = bucket.count === 0;
        return (
          <button
            key={bucket.key}
            type="button"
            aria-disabled={empty ? "true" : undefined}
            title={empty ? `${bucket.label}: no treatments` : `${bucket.label}: ${bucket.count}`}
            onClick={
              empty
                ? undefined
                : () => {
                    // block: "nearest" keeps the surrounding rows in view rather than
                    // slamming the group to the top of a short list, which reads as the
                    // list having been emptied.
                    document.getElementById(idFor(bucket.key))?.scrollIntoView({ block: "nearest" });
                  }
            }
            className={cn(
              "rounded-[3px] py-[1px] text-center text-[9.5px] font-semibold leading-[1.35] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-navy/30",
              empty ? "cursor-default text-line-strong" : "text-muted hover:bg-band hover:text-navy",
            )}
          >
            {bucket.label}
          </button>
        );
      })}
    </nav>
  );
}
