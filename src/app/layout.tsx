import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { MockAuthProvider } from "@/lib/auth/mock-auth";
import { RoleSwitcher } from "@/components/dev/role-switcher";

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${jakarta.variable} h-full antialiased`}>
      <body className="min-h-full">
        <MockAuthProvider>
          {children}
          <RoleSwitcher />
        </MockAuthProvider>
      </body>
    </html>
  );
}
