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
  let sessionData: { access_token: string; refresh_token: string; user_id: string } | null = null;

  // PKCE flow — use return value directly (don't rely on getSession)
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.session) {
      sessionOk = true;
      sessionData = {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        user_id: data.session.user.id,
      };
    }
  }

  // Token hash flow
  if (!sessionOk && token_hash && type) {
    const { data, error } = await supabase.auth.verifyOtp({ token_hash, type: type as any });
    if (!error && data.session) {
      sessionOk = true;
      sessionData = {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        user_id: data.session.user.id,
      };
    }
  }

  // Recovery: pass tokens via hash to reset page
  if (type === 'recovery') {
    if (sessionOk && sessionData) {
      const resetUrl = new URL('/auth/reset-password', request.url);
      return NextResponse.redirect(
        `${resetUrl.origin}${resetUrl.pathname}#access_token=${sessionData.access_token}&refresh_token=${sessionData.refresh_token}&user_id=${sessionData.user_id}&type=recovery`
      );
    }
    return NextResponse.redirect(new URL('/auth/reset-password#error=session_failed', request.url));
  }

  if (sessionOk) {
    return NextResponse.redirect(new URL(next, request.url));
  }

  return NextResponse.redirect(new URL('/login?error=auth_callback_failed', request.url));
}
