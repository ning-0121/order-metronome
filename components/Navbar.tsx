'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from '@/app/actions/auth';

interface NavbarProps {
  isAdmin?: boolean;
}

export function Navbar({ isAdmin }: NavbarProps) {
  const pathname = usePathname();

  // Don't show navbar on login page
  if (pathname === '/login') {
    return null;
  }

  const navLinks = [
    { href: '/dashboard', label: '我的工作台', icon: '📋' },
    { href: '/orders', label: '订单列表', icon: '📦' },
    { href: '/admin', label: '管理后台', icon: '⚙️' },
  ];

  return (
    <nav className="sticky top-0 z-50 border-b border-gray-200/80 bg-white/80 backdrop-blur-md">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center gap-10">
            {/* Logo */}
            <Link href="/dashboard" className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-lg">
                ⏱
              </div>
              <span className="text-lg font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                订单节拍器
              </span>
            </Link>

            {/* Nav Links */}
            <div className="flex items-center gap-1">
              {navLinks.map((link) => {
                const isActive = pathname === link.href || pathname.startsWith(link.href + '/');
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                      isActive
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                    }`}
                  >
                    <span className="text-base">{link.icon}</span>
                    {link.label}
                  </Link>
          <Link
            href="/warehouse"
            className={pathname === '/warehouse' ? 'text-indigo-600 font-semibold' : 'text-gray-600 hover:text-gray-900'}
          >
            仓库工作台
          </Link>
          <Link
            href="/exceptions"
            className={pathname === '/exceptions' ? 'text-indigo-600 font-semibold' : 'text-gray-600 hover:text-gray-900'}
          >
            异常中心
          </Link>
                );
              })}
            </div>
          </div>

          {/* User Actions */}
          <form action={signOut}>
            <button
              type="submit"
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-all duration-200"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              退出
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}
