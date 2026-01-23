import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
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

  // Protect routes (except login and auth callback)
  const isLoginPage = request.nextUrl.pathname === '/login';
  const isAuthCallback = request.nextUrl.pathname.startsWith('/auth/callback');
  
  if (!user && !isLoginPage && !isAuthCallback) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  
  // Redirect to dashboard if logged in and on login page
  if (user && isLoginPage) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }
  
  // Validate email domain for authenticated users
  if (user && !user.email?.endsWith('@qimoclothing.com')) {
    // Sign out user if domain doesn't match
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL('/login?error=invalid_domain', request.url));
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
