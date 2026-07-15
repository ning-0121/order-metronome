import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { shouldBypassForPreviewSmoke } from './middleware-smoke-bypass';

export async function middleware(request: NextRequest) {
  if (shouldBypassForPreviewSmoke({
    environment: process.env.VERCEL_ENV,
    method: request.method,
    pathname: request.nextUrl.pathname,
  })) return NextResponse.next();

  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value));
          response = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  // Protect routes (except login, auth callback, and auth API)
  const isLoginPage = request.nextUrl.pathname === '/login';
  const isPendingPage = request.nextUrl.pathname === '/pending-approval';
  const isAuthPage = request.nextUrl.pathname.startsWith('/auth/');
  const isAuthApi = request.nextUrl.pathname.startsWith('/api/auth/');
  const isCronApi = request.nextUrl.pathname.startsWith('/api/cron/');
  const isMailApi = request.nextUrl.pathname.startsWith('/api/mail-');
  const isBackupApi = request.nextUrl.pathname === '/api/backup';
  const isIntegrationApi = request.nextUrl.pathname.startsWith('/api/integration/');
  const isContractApi = request.nextUrl.pathname.startsWith('/api/contract/');
  const isPublicApi = isCronApi || isMailApi || isBackupApi || isIntegrationApi || isContractApi;

  if (!user && !isLoginPage && !isAuthPage && !isAuthApi && !isPublicApi) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // Validate email domain for authenticated users（先于审批闸门）
  if (user && !user.email?.endsWith('@qimoclothing.com')) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL('/login?error=invalid_domain', request.url));
  }

  // ═══ 审批闸门(2026-07-03 安全修复)═══
  // 此前漏洞:注册后 role=null 强刷即进系统,还被当成 sales。
  // 规则:已登录+域名对 → 必须「管理员白名单 或 已分配角色且未停用」才放行,否则打到 /pending-approval。
  // 白名单(alex/su)永远放行,保证至少有管理员能进去分配角色(防自锁死)。
  if (user && !isPublicApi && !isAuthApi && !isAuthPage) {
    const email = (user.email || '').toLowerCase();
    const ADMIN_ALLOWLIST = ['alex@qimoclothing.com', 'su@qimoclothing.com'];
    let approved = ADMIN_ALLOWLIST.includes(email);
    if (!approved) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('role, roles, is_active')
        .eq('user_id', user.id)
        .maybeSingle();
      const p: any = profile;
      const hasRole = !!p && (p.role != null || (Array.isArray(p.roles) && p.roles.length > 0));
      const notDeactivated = !p || p.is_active !== false;
      approved = hasRole && notDeactivated;
    }

    if (!approved) {
      // 未获批:只允许停留在 /pending-approval,其余一律重定向过去
      if (!isPendingPage) {
        return NextResponse.redirect(new URL('/pending-approval', request.url));
      }
      return response;
    }

    // 已获批:登录页/待审批页 → 首页(home 再分流 admin->/ceo, staff->/dashboard)
    if (isLoginPage || isPendingPage) {
      return NextResponse.redirect(new URL('/', request.url));
    }
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
