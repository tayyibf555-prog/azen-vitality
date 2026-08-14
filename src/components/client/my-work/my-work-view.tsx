import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { londonDayKey } from "@/lib/time/london";
import { MyWorkWorkspace } from "./my-work-workspace";

// MY WORK — the staff self-service surface.
//
// One module slug with five tabs rather than five slugs, because every new slug
// costs a nav entry, a page with its own `requireModuleAccess`, a branch in the
// owner if-chain and an API-coverage entry. One slug pays that once, and for a
// `client_staff` login this page plus the Overview is the entire platform
// (STAFF_SLUGS is exactly {"", "my-work"}).
//
// EVERYTHING ON IT IS THE CALLER'S OWN. Their published shifts, their holiday,
// their clocking, their documents, their signatures — each resolved from the
// session's staff record on the server, never from anything the browser sends.
// Nothing on this page reads the diary or the patient database, which is the
// whole reason the fifth role can exist at all.
//
// `today` is resolved HERE, on the server, and passed down: a client component
// computing `new Date()` would render one day during SSR and possibly another
// after hydration, and this page's whole job is telling somebody which days
// they are working.
export async function MyWorkView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="My work" description="This client could not be found." />;
  }

  return (
    <>
      <PageHeader
        title="My work"
        description="Your own page: the shifts published to you, clocking yourself in and out, your time off and where each request has got to, the documents the practice holds for you, and anything waiting for your signature."
      />

      <MyWorkWorkspace clientSlug={clientSlug} today={londonDayKey(new Date())} />
    </>
  );
}
