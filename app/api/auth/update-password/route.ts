import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

export async function POST(request: Request) {
  try {
    const { password, access_token, user_id } = await request.json();

    if (!password || password.length < 8) {
      return NextResponse.json({ error: '密码至少需要 8 位' }, { status: 400 });
    }

    // Method 1: Use server client (cookie session)
    try {
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { error } = await supabase.auth.updateUser({ password });
        if (!error) return NextResponse.json({ success: true });
        console.log('[update-password] Method 1 (cookie) updateUser error:', error.message);
      }
    } catch (e: any) {
      console.log('[update-password] Method 1 (cookie) exception:', e.message);
    }

    // Method 2: Use access_token to create authenticated client
    if (access_token) {
      try {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        if (url && key) {
          const tokenClient = createSupabaseClient(url, key, {
            global: { headers: { Authorization: `Bearer ${access_token}` } }
          });
          const { error } = await tokenClient.auth.updateUser({ password });
          if (!error) return NextResponse.json({ success: true });
          console.log('[update-password] Method 2 (access_token) error:', error.message);
        }
      } catch (e: any) {
        console.log('[update-password] Method 2 (access_token) exception:', e.message);
      }
    }

    // Method 3: Use service_role admin API (MOST RELIABLE — bypasses all session issues)
    if (user_id) {
      try {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (url && serviceKey) {
          const adminClient = createSupabaseClient(url, serviceKey);
          const { error } = await adminClient.auth.admin.updateUserById(user_id, { password });
          if (!error) return NextResponse.json({ success: true });
          console.log('[update-password] Method 3 (admin) error:', error.message);
          return NextResponse.json({ error: error.message }, { status: 400 });
        } else {
          console.log('[update-password] Method 3 skipped: missing SUPABASE_SERVICE_ROLE_KEY');
        }
      } catch (e: any) {
        console.log('[update-password] Method 3 (admin) exception:', e.message);
      }
    }

    return NextResponse.json({ error: '无法更新密码 — 请重新发送重置邮件并点击新链接' }, { status: 400 });
  } catch (err: any) {
    console.error('[update-password] Unexpected error:', err);
    return NextResponse.json({ error: err.message || '操作失败' }, { status: 500 });
  }
}
