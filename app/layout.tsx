import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Planning Additions — Voice Support",
  description: "Real-time voice support agent for Planning Additions Ltd.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}