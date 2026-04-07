import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Navbar } from "@/components/Navbar";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserRole } from "@/lib/utils/user-role";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "订单节拍器",
  description: "Qimo 订单跟踪和里程碑管理系统",
  manifest: "/manifest.json",
  themeColor: "#4f46e5",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "订单节拍器",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { role, isAdmin } = user ? await getCurrentUserRole(supabase) : { role: undefined, isAdmin: false };

  const currentYear = new Date().getFullYear();

  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} bg-white text-gray-900 antialiased flex flex-col min-h-screen`}
      >
        <Navbar isAdmin={isAdmin} />
        <main className="container mx-auto bg-white px-4 py-8 flex-1">
          {children}
        </main>
        <footer className="border-t border-gray-200 bg-gray-50 py-6 mt-auto">
          <div className="container mx-auto px-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 text-xs text-gray-500">
              <div className="flex items-center gap-2">
                <span className="text-base">⏱</span>
                <span className="font-semibold text-gray-700">绮陌服饰订单节拍器</span>
                <span className="text-gray-400">·</span>
                <span>Qimo Activewear Order Metronome</span>
              </div>
              <div className="flex items-center gap-4">
                <span>© {currentYear} 义乌绮陌服饰有限公司</span>
                <span className="text-gray-400">|</span>
                <span>Powered by Qimo Tech</span>
              </div>
            </div>
            <div className="text-center text-[10px] text-gray-400 mt-2">
              本系统受版权法保护，未经授权不得复制、传播或商用
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
