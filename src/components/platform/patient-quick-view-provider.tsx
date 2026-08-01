"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { PatientQuickView } from "@/components/client/patients/record/patient-quick-view";

/**
 * The quick overview, mounted once per tree so any patient name anywhere can open it
 * IN PLACE.
 *
 * WHY IN PLACE, and it is the whole point. Every caller used to navigate to
 * /c/<client>/patients?patient=<id>, which leaves the diary, leaves the dashboard and
 * loses your place before the overlay has even opened. You are mid-task somewhere else
 * and usually only need to check one thing; losing your place to do it is the wrong
 * trade. From the PATIENTS LIST the opposite is true and a row goes straight to the
 * full record: there the patient IS the task, and an intermediate step is friction.
 *
 * The drawer is not replaced by the record page. It is the shallow end of the same
 * record, and both read through the same server function, so no figure can differ
 * between them.
 *
 * MOUNT IT ABOVE EVERYTHING THAT CAN NAME A PATIENT. It used to wrap only {children}
 * inside <main>, which left the command palette outside the context: usePatientQuickView
 * returned null there, so Cmd-K -> a patient name silently fell back to a full-page
 * navigation and threw away the diary you were looking at. Both layouts now wrap the
 * whole shell.
 *
 * IT CLOSES ON NAVIGATION. This provider sits in a layout that is an ANCESTOR of the
 * record page, so a client-side navigation does not unmount it and did not clear the
 * request: the overlay stayed on top of the page it had just opened, with the body
 * scroll still locked, until somebody pressed Escape. The pathname effect is the
 * general form of that fix and covers every link inside the overlay, not just the
 * "View full patient profile" button.
 */

interface QuickViewRequest {
  patientId: string;
  siteId: string;
  /** The record page for this patient. Carried through to "View full patient profile"
   *  so the button and the link that opened the overview always agree. */
  href: string;
  patientName?: string;
}

interface QuickViewApi {
  open: (req: QuickViewRequest) => void;
}

const Ctx = createContext<QuickViewApi | null>(null);

/** Null when no provider is mounted, so a PatientLink outside one degrades to a plain
 *  anchor rather than throwing. */
export function usePatientQuickView(): QuickViewApi | null {
  return useContext(Ctx);
}

export function PatientQuickViewProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<QuickViewRequest | null>(null);
  // The element that opened the overview, so focus returns exactly where it was when
  // the overview closes. Without this, closing drops focus to the document body and a
  // keyboard user restarts their tab journey from the top of the page.
  const triggerRef = useRef<HTMLElement | null>(null);

  const open = useCallback((req: QuickViewRequest) => {
    const active = document.activeElement;
    triggerRef.current = active instanceof HTMLElement ? active : null;
    setRequest(req);
  }, []);

  const close = useCallback(() => {
    setRequest(null);
    triggerRef.current?.focus();
    triggerRef.current = null;
  }, []);

  // Any navigation dismisses the overview. NOT `close`: focus must not be yanked back
  // to a trigger on a page that is no longer on screen, so this clears without
  // refocusing. The first render's pathname is skipped, so opening never self-closes.
  const pathname = usePathname();
  const openedAt = useRef<string | null>(null);
  useEffect(() => {
    if (openedAt.current === null) {
      openedAt.current = pathname;
      return;
    }
    if (openedAt.current === pathname) return;
    openedAt.current = pathname;
    setRequest(null);
    triggerRef.current = null;
  }, [pathname]);

  const api = useMemo<QuickViewApi>(() => ({ open }), [open]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {request ? (
        <PatientQuickView
          key={`${request.siteId}:${request.patientId}`}
          patientId={request.patientId}
          siteId={request.siteId}
          recordHref={request.href}
          initialName={request.patientName}
          onClose={close}
        />
      ) : null}
    </Ctx.Provider>
  );
}
