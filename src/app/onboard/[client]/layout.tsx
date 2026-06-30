// Public layout for the embeddable new-patient onboarding form. Deliberately minimal:
// brand chrome and a centred card on a calm background, with NO authed client shell
// (no sidebar/topbar). The root layout already supplies <html>/<body> and the font, so
// this only frames the public page.
//
// The /onboard/* paths are public (proxy gates only /agency, /owner, /c/*).

export const metadata = {
  title: "New patient onboarding",
  description: "Join the practice: a few short steps to get you registered.",
};

export default function OnboardLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-cream">{children}</div>;
}
