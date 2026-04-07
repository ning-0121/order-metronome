'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from '@/app/actions/auth';
import { NotificationBell } from '@/components/NotificationBell';

interface NavbarProps {
  isAdmin?: boolean;
}

export function Navbar({ isAdmin = false }: NavbarProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  if (pathname === '/login') {
    return null;
  }

  // 主导航（精简核心入口）
  const navLinks = isAdmin
    ? [
        { href: '/ceo', label: '我的节拍', icon: '🎯' },
        { href: '/orders', label: '订单列表', icon: '📦' },
        { href: '/analytics', label: '数据分析', icon: '📊' },
        { href: '/admin/users', label: '用户', icon: '👥' },
      ]
    : [
        { href: '/dashboard', label: '我的工作台', icon: '📋' },
        { href: '/orders', label: '订单列表', icon: '📦' },
        { href: '/briefing', label: '今日简报', icon: '📧' },
        { href: '/memos', label: '备忘录', icon: '📝' },
      ];

  // 更多菜单（低频入口）
  const moreLinks = isAdmin
    ? [
        { href: '/customers', label: '客户管理', icon: '🤝' },
        { href: '/factories', label: '工厂管理', icon: '🏭' },
        { href: '/memos', label: '备忘录', icon: '📝' },
        { href: '/ai-knowledge', label: 'AI知识库', icon: '🧠' },
        { href: '/admin/mail-monitor', label: '邮件无声失败', icon: '📧' },
        { href: '/admin/price-approvals', label: '价格审批', icon: '💰' },
        { href: '/guide', label: '操作说明', icon: '📖' },
      ]
    : [
        { href: '/guide', label: '操作说明', icon: '📖' },
      ];

  const logoHref = isAdmin ? '/ceo' : '/dashboard';

  return (
    <nav className="sticky top-0 z-50 border-b border-gray-200/80 bg-white/80 backdrop-blur-md">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 md:h-16 items-center justify-between">
          {/* Logo + Desktop Nav */}
          <div className="flex items-center gap-6 lg:gap-10">
            <Link href={logoHref} className="flex items-center gap-2">
              <div className="flex h-8 w-8 md:h-9 md:w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-base md:text-lg">
                ⏱
              </div>
              <span className="hidden sm:block text-lg font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                绮陌服饰智能系统
              </span>
            </Link>

            {/* Desktop nav links */}
            <div className="hidden md:flex items-center gap-1">
              {navLinks.map((link) => {
                const isActive = pathname === link.href || pathname.startsWith(link.href + '/');
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                      isActive
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                    }`}
                  >
                    <span className="text-sm">{link.icon}</span>
                    {link.label}
                  </Link>
                );
              })}
              {/* 更多下拉 */}
              {moreLinks.length > 0 && (
                <div className="relative">
                  <button onClick={() => setMoreOpen(!moreOpen)}
                    className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-all">
                    更多 <svg className={`w-3 h-3 transition-transform ${moreOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                  </button>
                  {moreOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
                      <div className="absolute top-full left-0 mt-1 w-44 bg-white rounded-xl border border-gray-200 shadow-lg z-50 py-1">
                        {moreLinks.map(link => (
                          <Link key={link.href} href={link.href} onClick={() => setMoreOpen(false)}
                            className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
                            <span>{link.icon}</span>{link.label}
                          </Link>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right: notification + logout + hamburger */}
          <div className="flex items-center gap-1">
            <NotificationBell />
            <form action={signOut} className="hidden sm:block">
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
            {/* Mobile hamburger */}
            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              className="md:hidden p-2 rounded-lg text-gray-600 hover:bg-gray-100"
            >
              {mobileOpen ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="md:hidden border-t border-gray-200 bg-white">
          <div className="px-4 py-3 space-y-1">
            {[...navLinks, ...moreLinks].map((link) => {
              const isActive = pathname === link.href || pathname.startsWith(link.href + '/');
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-all ${
                    isActive
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <span className="text-lg">{link.icon}</span>
                  {link.label}
                </Link>
              );
            })}
            <form action={signOut} className="sm:hidden pt-2 border-t border-gray-100">
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
    </nav>
  );
}
