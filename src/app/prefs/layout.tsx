// Public layout for the patient channel-preference page (/prefs/<token>).
// Deliberately minimal, matching the assess / book / go pages: a calm cream
// background with a soft brand glow and no authed client shell. The root layout
// supplies <html>/<body> and the font.
//
// The /prefs/* paths are public (the proxy gates only /agency, /owner, /c/*).

export const metadata = {
  title: "Your messaging preferences",
};

export default function PrefsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen bg-cream">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-[radial-gradient(58%_70%_at_50%_0%,rgba(91,196,247,0.20),transparent_72%)]"
      />
      {children}
    </div>
  );
}
