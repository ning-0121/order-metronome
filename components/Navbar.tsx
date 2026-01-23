'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from '@/app/actions/auth';

export function Navbar() {
  const pathname = usePathname();

  // Don't show navbar on login page
  if (pathname === '/login') {
    return null;
  }

  const navLinks = [
    { href: '/dashboard', label: '我的工作台' },
    { href: '/orders', label: '订单列表' },
    { href: '/admin', label: '管理后台' },
  ];

  return (
    <nav className="border-b bg-white">
      <div className="container mx-auto px-4">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center space-x-8">
            <Link href="/dashboard" className="text-xl font-bold">
              订单节拍器
            </Link>
            <div className="flex space-x-4">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`${
                    pathname === link.href
                      ? 'text-blue-600 font-semibold'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
          <form action={signOut}>
            <button
              type="submit"
              className="text-gray-600 hover:text-gray-900"
            >
              退出登录
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}
