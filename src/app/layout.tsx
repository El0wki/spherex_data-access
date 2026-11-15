import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SPHEREx Sky Explorer",
  description: "Explore the SPHEREx sky",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
