import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Auth callback handler
 * Supabase redirects here after email confirmation / password reset
 * Exchanges the code for a session, then redirects to the appropriate page
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const type = searchParams.get('type');
  const next = searchParams.get('next') || '/';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Password recovery → redirect to reset password page
      if (type === 'recovery') {
        return NextResponse.redirect(new URL('/auth/reset-password', request.url));
      }
      // Email confirmation or other → redirect to home
      return NextResponse.redirect(new URL(next, request.url));
    }
  }

  // If code exchange fails, redirect to login with error
  return NextResponse.redirect(new URL('/login?error=auth_callback_failed', request.url));
}
