import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Auth callback handler
 * Supabase redirects here after email confirmation / password reset
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const next = searchParams.get('next') || '/';

  const supabase = await createClient();
  let sessionOk = false;

  // PKCE flow
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) sessionOk = true;
  }

  // Token hash flow
  if (!sessionOk && token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash, type: type as any });
    if (!error) sessionOk = true;
  }

  // Recovery: 获取 session 的 access_token 传给重置页面
  if (type === 'recovery') {
    if (sessionOk) {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        // 把 token 通过 hash 传给客户端页面
        const resetUrl = new URL('/auth/reset-password', request.url);
        return NextResponse.redirect(
          `${resetUrl.origin}${resetUrl.pathname}#access_token=${session.access_token}&refresh_token=${session.refresh_token || ''}&type=recovery`
        );
      }
    }
    // session 获取失败也跳转，让页面展示错误
    return NextResponse.redirect(new URL('/auth/reset-password#error=session_failed', request.url));
  }

  if (sessionOk) {
    return NextResponse.redirect(new URL(next, request.url));
  }

  return NextResponse.redirect(new URL('/login?error=auth_callback_failed', request.url));
}
