import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Minimi",
  description: "A chat agent with web search and private, local memory.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
