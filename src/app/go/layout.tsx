// Public layout for campaign landing pages (/go/<client>/<slug>). Deliberately
// minimal, matching the assess pages: a calm cream background and no authed client
// shell. The root layout supplies <html>/<body> and the font.
//
// The /go/* paths are public (the proxy gates only /agency, /owner, /c/*).

export const metadata = {
  title: "Vitality Dental",
};

export default function GoLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen bg-cream">
      {/* Soft brand glow behind the page, matching the assess/book pages. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-[radial-gradient(58%_70%_at_50%_0%,rgba(91,196,247,0.20),transparent_72%)]"
      />
      {children}
    </div>
  );
}
