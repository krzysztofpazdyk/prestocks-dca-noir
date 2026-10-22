import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { PrivyClientProvider } from "@/components/PrivyClientProvider";
import { SolanaWalletProvider } from "@/components/SolanaWalletProvider";
import { I18nProvider } from "@/lib/i18n";
import {
  AutoWeeklyBuyBanner,
  AutoWeeklyBuyProvider,
} from "@/lib/hooks/useAutoWeeklyBuy";
import { Nav } from "@/components/Nav";
import { APP_VERSION } from "@/lib/app-version";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PreStocks DCA · noir 3.0",
  description:
    "Weekly DCA na PreStocks SPL — noir 3.0 (predca 3.0, priced buys v2)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pl"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[#0c0e12] text-[#e8eef5]">
        <PrivyClientProvider>
          <SolanaWalletProvider>
            <I18nProvider>
              <AutoWeeklyBuyProvider>
                <Nav />
                <AutoWeeklyBuyBanner />
                <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
                  {children}
                </main>
                <footer className="border-t border-[#1e2633] px-4 py-3 text-center text-[10px] tracking-wider text-[#5c6578]">
                  noir 3.0 · v{APP_VERSION}
                </footer>
              </AutoWeeklyBuyProvider>
            </I18nProvider>
          </SolanaWalletProvider>
        </PrivyClientProvider>
      </body>
    </html>
  );
}
