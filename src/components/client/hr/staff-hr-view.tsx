import { PageHeader, Tabs } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { StaffDocumentsPanel } from "@/components/hr/staff-documents-panel";
import { PolicyLibraryPanel } from "@/components/hr/policy-library-panel";
import { HrWorkspace } from "./hr-workspace";

// The employee file.
//
// Contact and emergency details, employment dates, and the holiday entitlement
// each person's working pattern earns. Pay is a SEPARATE permission inside the
// module: a practice manager opens this screen every week and never sees a rate,
// and that is enforced by the server not building the fields rather than by the
// screen not drawing them.
//
// ---------------------------------------------------------------------------
// THE SEAM, JOINED (campaign 6, C1 + C2, wired in the integration phase).
// ---------------------------------------------------------------------------
// The document vault and the policy library are separate lanes with their own
// APIs and their own tests; to the practice they are three views of one thing —
// the people who work here — so they are three tabs and not three modules.
//
// `Tabs` is a client component whose `content` is a React NODE, which is why this
// server component can compose it without becoming a client component itself.
// (That distinction matters here: the DataTable/Tabs lesson is that a shared
// primitive taking FUNCTION props must not cross the RSC boundary — the build
// passes and the server page crashes at render. A node is fine; a render callback
// would not be.)
//
// Both panels fetch their own data and each renders an honest failure of its own
// when its read fails, so one broken tab cannot blank the other two.
export async function StaffHrView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Staff HR" description="This client could not be found." />;
  }

  const scope = await getViewScope(client.id);

  return (
    <>
      <PageHeader
        title="Staff HR"
        description={
          scope.isAllSites
            ? "The employee file for everyone across all sites: contact and emergency details, employment dates, holiday entitlement, the documents you hold and the policies people have signed."
            : `The employee file for the team at ${scope.siteName}: contact and emergency details, employment dates, holiday entitlement, the documents you hold and the policies people have signed.`
        }
      />

      <Tabs
        tabs={[
          // NO `icon` ON THESE TABS, and it is not an oversight. `TabItem.icon` is a
          // LucideIcon — a FUNCTION — and this is a server component handing props to
          // a client one, so an icon here throws "Functions cannot be passed directly
          // to Client Components" at RENDER time. tsc is happy and the build is happy;
          // the page 500s. That is the DataTable/Tabs lesson exactly, and it was caught
          // here by rendering the page rather than by compiling it.
          { key: "people", label: "People", content: <HrWorkspace clientSlug={clientSlug} /> },
          {
            key: "documents",
            label: "Documents",
            content: <StaffDocumentsPanel clientSlug={clientSlug} />,
          },
          {
            key: "signatures",
            label: "Signatures",
            content: <PolicyLibraryPanel clientSlug={clientSlug} />,
          },
        ]}
      />
    </>
  );
}
