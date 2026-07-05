'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from '@/app/actions/auth';
import { NotificationBell } from '@/components/NotificationBell';
import { getPendingPriceApprovalsCount } from '@/app/actions/price-approvals';
import { PRODUCT_NAME } from '@/lib/branding/constants';

interface NavbarProps {
  isAdmin?: boolean;
  isProcurement?: boolean;
  isProduction?: boolean;
}

interface NavLink {
  href: string;
  label: string;
  icon: string;
  badge?: 'price';
}
interface NavSection {
  label?: string;
  links: NavLink[];
}

export function Navbar({ isAdmin = false, isProcurement = false, isProduction = false }: NavbarProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pendingPriceCount, setPendingPriceCount] = useState(0);

  // 价格审批待办数量 — 仅管理员，每 120s 刷新
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const n = await getPendingPriceApprovalsCount();
        if (!cancelled) setPendingPriceCount(n);
      } catch {}
    };
    fetchCount();
    const t = setInterval(fetchCount, 120000);
    return () => { cancelled = true; clearInterval(t); };
  }, [isAdmin]);

  if (pathname === '/login') {
    return null;
  }

  // ── 控制中心菜单（QIMO OS：左侧 = 各控制中心，订单只是其中一个）──
  const sections: NavSection[] = isAdmin
    ? [
        {
          links: [
            { href: '/hub', label: '系统门户', icon: '🧭' },
            { href: '/ceo', label: '我的节拍', icon: '🎯' },
            { href: '/orders', label: '订单中心', icon: '📦' },
            { href: '/procurement', label: '采购 / 供应链', icon: '🛒' },
            { href: '/production', label: '生产中心', icon: '🏭' },
            { href: '/analytics', label: '数据分析', icon: '📊' },
          ],
        },
        {
          label: '业务',
          links: [
            { href: '/my-customers', label: '我的客户', icon: '👤' },
            { href: '/customers', label: '客户管理', icon: '🤝' },
            { href: '/sales-targets', label: '客户年度目标', icon: '🎯' },
            { href: '/quoter', label: '报价员', icon: '💰' },
            { href: '/factories', label: '工厂管理', icon: '🏭' },
            { href: '/products', label: '产品款库', icon: '🧬' },
            { href: '/material-master', label: '物料主数据', icon: '🧱' },
            { href: '/memos', label: '备忘录', icon: '📝' },
          ],
        },
        {
          label: 'AI',
          links: [
            { href: '/ai-knowledge', label: 'AI 知识库', icon: '🧠' },
            { href: '/my-assistant', label: 'AI 助手', icon: '🤖' },
          ],
        },
        {
          label: '治理',
          links: [
            { href: '/admin/price-approvals', label: '价格审批', icon: '💰', badge: 'price' },
            { href: '/admin/system-health', label: '系统守护', icon: '🛡' },
            { href: '/admin/overdue', label: '逾期治理', icon: '🚨' },
            { href: '/admin/delay-hotspots', label: '延误排行榜', icon: '📉' },
            { href: '/admin/customer-schedules', label: '客户节奏', icon: '🎼' },
            { href: '/admin/mail-monitor', label: '今日邮件晨报', icon: '📧' },
          ],
        },
        {
          label: '系统',
          links: [
            { href: '/admin/order-templates', label: '订单模板', icon: '📋' },
            { href: '/admin/users', label: '用户管理', icon: '👥' },
            { href: '/guide', label: '操作说明', icon: '📖' },
          ],
        },
      ]
    : [
        {
          links: [
            { href: '/hub', label: '系统门户', icon: '🧭' },
            { href: '/dashboard', label: '我的工作台', icon: '📋' },
            { href: '/my-customers', label: '我的客户', icon: '🎯' },
            { href: '/orders', label: '订单列表', icon: '📦' },
            isProcurement
              ? { href: '/procurement', label: '采购中心', icon: '🛒' }
              : { href: '/briefing', label: '今日简报', icon: '📧' },
            ...(isProduction ? [{ href: '/production', label: '生产中心', icon: '🏭' }] : []),
          ],
        },
        {
          label: '工具',
          links: [
            { href: '/sales-targets', label: '年度目标', icon: '🎯' },
            { href: '/quoter', label: '报价员', icon: '💰' },
            { href: '/products', label: '产品款库', icon: '🧬' },
            { href: '/material-master', label: '物料主数据', icon: '🧱' },
            { href: '/memos', label: '备忘录', icon: '📝' },
            { href: '/my-assistant', label: 'AI 助手', icon: '🤖' },
            { href: '/guide', label: '操作说明', icon: '📖' },
          ],
        },
      ];

  const logoHref = isAdmin ? '/ceo' : '/dashboard';

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  const renderLink = (link: NavLink, onNavigate?: () => void) => {
    const active = isActive(link.href);
    const showBadge = link.badge === 'price' && pendingPriceCount > 0;
    return (
      <Link
        key={link.href}
        href={link.href}
        onClick={onNavigate}
        className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
          active ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
        }`}
      >
        <span className="flex items-center gap-2.5">
          <span className="text-base">{link.icon}</span>
          {link.label}
        </span>
        {showBadge && (
          <span className="px-1.5 py-0.5 rounded-full bg-red-500 text-white text-[10px] font-bold min-w-[18px] text-center">
            {pendingPriceCount}
          </span>
        )}
      </Link>
    );
  };

  const Logo = ({ onNavigate }: { onNavigate?: () => void }) => (
    <Link href={logoHref} onClick={onNavigate} className="flex items-center gap-2">
      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-sm font-bold">
        Q
      </div>
      <span className="text-lg font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
        {PRODUCT_NAME}
      </span>
    </Link>
  );

  const navContent = (onNavigate?: () => void) => (
    <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
      {sections.map((section, si) => (
        <div key={section.label || `sec-${si}`}>
          {section.label && (
            <p className="px-3 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
              {section.label}
            </p>
          )}
          <div className="space-y-0.5">
            {section.links.map((link) => renderLink(link, onNavigate))}
          </div>
        </div>
      ))}
    </nav>
  );

  return (
    <>
      {/* Desktop 左侧控制中心 */}
      <aside className="hidden md:flex fixed left-0 top-0 h-screen w-60 flex-col border-r border-gray-200 bg-white z-40">
        <div className="h-16 px-4 flex items-center border-b border-gray-100 shrink-0">
          <Logo />
        </div>
        {navContent()}
        <div className="border-t border-gray-100 px-3 py-2 flex items-center justify-between shrink-0">
          <NotificationBell />
          <form action={signOut}>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-all"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              退出
            </button>
          </form>
        </div>
      </aside>

      {/* Mobile 顶栏 */}
      <div className="md:hidden sticky top-0 z-40 flex items-center justify-between h-14 px-4 border-b border-gray-200 bg-white/90 backdrop-blur-md">
        <Logo />
        <div className="flex items-center gap-1">
          <NotificationBell />
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="p-2 rounded-lg text-gray-600 hover:bg-gray-100"
            aria-label="菜单"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile 抽屉 */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-72 max-w-[80vw] bg-white shadow-xl flex flex-col">
            <div className="h-14 px-4 flex items-center justify-between border-b border-gray-100 shrink-0">
              <Logo onNavigate={() => setMobileOpen(false)} />
              <button onClick={() => setMobileOpen(false)} className="p-2 rounded-lg text-gray-600 hover:bg-gray-100" aria-label="关闭">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {navContent(() => setMobileOpen(false))}
            <form action={signOut} className="border-t border-gray-100 p-3 shrink-0">
              <button
                type="submit"
                className="flex items-center gap-3 w-full px-3 py-3 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 transition-all"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                退出登录
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
