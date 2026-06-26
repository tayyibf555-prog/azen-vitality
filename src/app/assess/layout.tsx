// Public layout for the embeddable Smile Assessment quiz. Deliberately minimal:
// brand chrome and a centred card on a calm background, with NO authed client
// shell (no sidebar/topbar). The root layout already supplies <html>/<body> and
// the font, so this only frames the public page.
//
// The /assess/* paths are public (proxy gates only /agency, /owner, /c/*).

export const metadata = {
  title: "Smile Assessment",
  description: "A quick check to point you to the right next step for your smile.",
};

export default function AssessLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-cream">{children}</div>;
}
