import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth/mock-auth";
import { getSessionUser } from "@/lib/auth/session";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Azen x Vitality",
  description: "AI operations layer for the Vitality Dental Network, built on Dentally.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const sessionUser = await getSessionUser();
  const initialUser = sessionUser
    ? {
        id: sessionUser.id,
        name: sessionUser.name,
        email: sessionUser.email,
        role: sessionUser.role,
        clientId: sessionUser.clientId,
      }
    : null;

  return (
    <html lang="en" className={`${jakarta.variable} h-full antialiased`}>
      <body className="min-h-full">
        <AuthProvider initialUser={initialUser}>{children}</AuthProvider>
      </body>
    </html>
  );
}
