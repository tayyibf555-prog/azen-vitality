// Public layout for the patient-facing booking page. Deliberately minimal, like
// /assess: brand chrome and a centred card on a calm background, with NO authed
// client shell (no sidebar/topbar). The root layout already supplies
// <html>/<body> and the font, so this only frames the public page.
//
// The /book/* paths are public (proxy gates only /agency, /owner, /c/*).

export const metadata = {
  title: "Book an appointment",
  description: "Choose an appointment time that suits you.",
};

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-cream">{children}</div>;
}
