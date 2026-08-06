import type { Metadata } from "next";
import "./globals.css";
import { Navbar } from "@/components/Navbar";
import { PWARegister } from "@/components/PWARegister";
import { ChunkErrorReloader } from "@/components/ChunkErrorReloader";
import { WorkbenchAnchor } from "@/components/WorkbenchAnchor";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserRole } from "@/lib/utils/user-role";
import { knowledgeLayerCaptureVisible } from "@/lib/engine/featureFlags";
import { BRAND } from "@/lib/config/brand";

// 去掉 Google Fonts — Vercel 构建时经常拉不到导致部署失败
// 改用系统字体栈，视觉差异极小但部署 100% 稳定

export const metadata: Metadata = {
  title: BRAND.productName,
  description: BRAND.description,
  // 内部系统，禁止搜索引擎收录（防止"搜绮陌服饰能搜到节拍器"）
  robots: { index: false, follow: false, nocache: true },
  manifest: "/manifest.json",
  themeColor: "#4f46e5",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: BRAND.productName,
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
  // 改用请求级缓存的 getCurrentUserRole(2026-08-05 性能):布局在每个页面都渲染,
  // 原来这里自己跑一遍 getUser + profiles,页面/action 里又各跑一遍 —— 全是重复。
  // 现在整个请求里这套 auth+profiles 只发一次,谁先调谁付钱,其余全部命中缓存。
  // 口径不变:getCurrentUserRole 的邮箱白名单保底 admin 与原 getUserRoleFromEmail 一致,
  // profiles 的 roles 判定逻辑也与原内联版相同(它本来就是从这里抄出去统一的)。
  const { isAdmin, userId, roles: profileRoles } = await getCurrentUserRole(supabase);
  const user = userId ? { id: userId } : null;
  const roles: string[] = profileRoles || [];

  // 采购/生产/财务 导航可见性
  let isProcurement = isAdmin;
  let isProduction = isAdmin;
  let isFinance = isAdmin; // H4:财务/管理员显示「进入财务系统」SSO 入口
  let isSupervisor = isAdmin;  // 督办总览可见性(管理/督导 = CAN_SEE_ALL_ORDERS)
  let canCheckMissing = isAdmin;  // 缺明细检查入口(2026-07-27:管理层看全部 + 业务/跟单看自己的)
  if (user && !isAdmin) {
    // admin_assistant(行政督导)给采购/生产中心入口 —— 督导要能看两个中心(只看不改,写操作另有门禁)
    isProcurement = roles.some(r => ['procurement', 'procurement_manager', 'admin', 'admin_assistant'].includes(r));
    isProduction = roles.some(r => ['production', 'production_manager', 'admin', 'admin_assistant'].includes(r));
    isFinance = roles.some(r => ['finance', 'admin'].includes(r));
    isSupervisor = roles.some(r => ['admin', 'finance', 'admin_assistant', 'production_manager', 'sales_manager', 'order_manager', 'procurement_manager'].includes(r));
    canCheckMissing = roles.some(r => ['sales', 'merchandiser', 'finance', 'admin_assistant', 'production_manager', 'sales_manager', 'order_manager', 'procurement_manager'].includes(r));
  }

  // Knowledge Layer K1:学习中心导航按 flag 灰度显示（off→不显示；admin→仅管理员；on→全员）
  const knowledgeLayer = knowledgeLayerCaptureVisible(isAdmin);

  const currentYear = new Date().getFullYear();

  return (
    <html lang="zh-CN">
      <body
        className="bg-white text-gray-900 antialiased font-sans min-h-screen"
      >
        <ChunkErrorReloader />
        <Navbar isAdmin={isAdmin} isProcurement={isProcurement} isProduction={isProduction} isFinance={isFinance} isSupervisor={isSupervisor} canCheckMissing={canCheckMissing} knowledgeLayer={knowledgeLayer} />
        <PWARegister />
        {/* 打开系统/闲置2小时后再打开 → 回角色工作台;工作中刷新不打扰;单据深链不劫持 */}
        <WorkbenchAnchor />
        {/* 左侧控制中心宽 60(15rem),桌面端正文留出左边距 */}
        <div className="md:pl-60 flex flex-col min-h-screen">
          <main className="container mx-auto bg-white px-4 py-8 flex-1">
            {children}
          </main>
          <footer className="border-t border-gray-200 bg-gray-50 py-6 mt-auto">
          <div className="container mx-auto px-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 text-xs text-gray-500">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-gray-700">{BRAND.productName}</span>
                <span className="text-gray-400">·</span>
                <span>{BRAND.taglineEn}</span>
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
        </div>
      </body>
    </html>
  );
}
