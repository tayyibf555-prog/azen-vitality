"use client";

import { useCallback, useEffect, useState } from "react";
import type { LoadFailure } from "@/lib/my-work/rules";
import { readJson } from "./shared";

// The network half of a self-service tab, and nothing else.
//
// THE FETCH IS IN THE EFFECT AND THE setState IS IN ITS CALLBACK — the house
// pattern (see use-diary-day.ts and absence-workspace.tsx). Two reasons:
//  - it stops the mount doing a render, a synchronous setState and a second
//    render before the request has even been issued;
//  - `cancelled` retires an in-flight answer when the screen unmounts or the
//    client changes, so a slow reply for one practice cannot repaint over a
//    faster one for the next.
//
// It holds NO rules. Whether the result should render as a list, a failure, a
// spinner or "your login is not linked" is decided by `panelStateFor` in
// @/lib/my-work/rules, under test.

export interface SelfServiceRead<T> {
  data: T | null;
  loading: boolean;
  failure: LoadFailure | null;
  reload: () => Promise<void>;
}

/**
 * Read one self-service endpoint.
 *
 * `url: null` means "there is nothing to ask for" (no staff link), which
 * settles immediately with no data and NO failure — the caller renders the
 * unlinked copy, which is a different thing from a failed read and must not be
 * dressed up as one.
 */
export function useSelfServiceRead<T>(url: string | null): SelfServiceRead<T> {
  const [state, setState] = useState<{ data: T | null; loading: boolean; failure: LoadFailure | null }>({
    data: null,
    loading: url !== null,
    failure: null,
  });

  const run = useCallback(async (): Promise<{ data: T | null; failure: LoadFailure | null }> => {
    if (url === null) return { data: null, failure: null };
    return readJson<T>(url);
  }, [url]);

  useEffect(() => {
    let cancelled = false;
    run()
      .then((r) => {
        if (!cancelled) setState({ data: r.data, loading: false, failure: r.failure });
      })
      .catch(() => {
        // readJson does not throw; this is belt and braces so an unexpected
        // throw becomes an honest failure rather than a spinner that never ends.
        if (!cancelled) setState({ data: null, loading: false, failure: { status: null } });
      });
    return () => {
      cancelled = true;
    };
  }, [run]);

  // Called from event handlers only, never from an effect. It deliberately does
  // not put the spinner back: the list you have just acted on should not vanish
  // and return.
  const reload = useCallback(async () => {
    const r = await run();
    setState({ data: r.data, loading: false, failure: r.failure });
  }, [run]);

  return { ...state, reload };
}
