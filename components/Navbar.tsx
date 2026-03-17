'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from '@/app/actions/auth';

interface NavbarProps {
  isAdmin?: boolean;
  userRole?: string;
}

// 每个角色可见的导航项
const NAV_BY_ROLE: Record<string, { href: string; label: string; icon: string }[]> = {
  admin: [
    { href: '/dashboard', label: '工作台', icon: '📋' },
    { href: '/orders', label: '订单列表', icon: '📦' },
    { href: '/admin', label: '管理后台', icon: '⚙️' },
    { href: '/admin/users', label: '用户管理', icon: '👥' },
    { href: '/warehouse', label: '仓库工作台', icon: '🏭' },
    { href: '/exceptions', label: '异常中心', icon: '⚠️' },
  ],
  ceo: [
    { href: '/dashboard', label: '工作台', icon: '📋' },
    { href: '/orders', label: '订单列表', icon: '📦' },
    { href: '/ceo', label: 'CEO总览', icon: '📊' },
    { href: '/exceptions', label: '异常中心', icon: '⚠️' },
  ],
  sales: [
    { href: '/dashboard', label: '我的工作台', icon: '📋' },
    { href: '/orders', label: '我的订单', icon: '📦' },
    { href: '/exceptions', label: '异常中心', icon: '⚠️' },
  ],
  finance: [
    { href: '/dashboard', label: '我的工作台', icon: '📋' },
    { href: '/orders', label: '订单列表', icon: '📦' },
    { href: '/exceptions', label: '异常中心', icon: '⚠️' },
  ],
  procurement: [
    { href: '/dashboard', label: '我的工作台', icon: '📋' },
    { href: '/orders', label: '订单列表', icon: '📦' },
  ],
  production: [
    { href: '/dashboard', label: '我的工作台', icon: '📋' },
    { href: '/orders', label: '订单列表', icon: '📦' },
  ],
  qc: [
    { href: '/dashboard', label: '我的工作台', icon: '📋' },
    { href: '/orders', label: '订单列表', icon: '📦' },
    { href: '/exceptions', label: '异常中心', icon: '⚠️' },
  ],
  quality: [
    { href: '/dashboard', label: '我的工作台', icon: '📋' },
    { href: '/orders', label: '订单列表', icon: '📦' },
    { href: '/exceptions', label: '异常中心', icon: '⚠️' },
  ],
  logistics: [
    { href: '/dashboard', label: '我的工作台', icon: '📋' },
    { href: '/orders', label: '订单列表', icon: '📦' },
    { href: '/warehouse', label: '仓库工作台', icon: '🏭' },
    { href: '/exceptions', label: '异常中心', icon: '⚠️' },
  ],
};

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员', ceo: 'CEO', sales: '业务', finance: '财务',
  procurement: '采购', production: '生产', qc: '质检',
  logistics: '物流/仓库', quality: '品控',
};

const ROLE_COLORS: Record<string, string> = {
  admin: 'bg-purple-100 text-purple-700',
  ceo: 'bg-indigo-100 text-indigo-700',
  sales: 'bg-blue-100 text-blue-700',
  finance: 'bg-amber-100 text-amber-700',
  procurement: 'bg-teal-100 text-teal-700',
  production: 'bg-red-100 text-red-700',
  qc: 'bg-pink-100 text-pink-700',
  logistics: 'bg-green-100 text-green-700',
  quality: 'bg-orange-100 text-orange-700',
};

export function Navbar({ isAdmin, userRole }: NavbarProps) {
  const pathname = usePathname();
  if (pathname === '/login') return null;

  // 根据角色获取导航项，兜底显示基础导航
  const role = userRole || (isAdmin ? 'admin' : '');
  const navLinks = NAV_BY_ROLE[role] || [
    { href: '/dashboard', label: '工作台', icon: '📋' },
    { href: '/orders', label: '订单列表', icon: '📦' },
  ];

  return (
    <nav className="sticky top-0 z-50 border-b border-gray-200/80 bg-white/80 backdrop-blur-md">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center gap-8">
            {/* Logo */}
            <Link href="/dashboard" className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-lg">
                ⏱
              </div>
              <span className="text-lg font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                订单节拍器
              </span>
            </Link>

            {/* 动态导航 */}
            <div className="flex items-center gap-1">
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
            </div>
          </div>

          {/* 右侧：角色标签 + 退出 */}
          <div className="flex items-center gap-3">
            {role && (
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${ROLE_COLORS[role] || 'bg-gray-100 text-gray-600'}`}>
                {ROLE_LABELS[role] || role}
              </span>
            )}
            <form action={signOut}>
              <button
                type="submit"
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-all duration-200"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                退出
              </button>
            </form>
          </div>
        </div>
      </div>
    </nav>
  );
}
