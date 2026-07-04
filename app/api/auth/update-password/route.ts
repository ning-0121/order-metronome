import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

export async function POST(request: Request) {
  try {
    // 安全(2026-07-04 审计 P0):只允许改「已认证用户自己」的密码——
    // Method 1 = cookie session,Method 2 = access_token(Supabase 恢复令牌,自证身份)。
    // 原 Method 3 从请求体取 user_id + service-role 改任意人密码 = 账号接管后门,已删除。
    // 忘记密码重置走 /api/auth/reset-password(HMAC 签名令牌派生 userId),不走本路由。
    const { password, access_token } = await request.json();

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

    // (Method 3 已删除:服务端凭 body.user_id 改任意人密码是账号接管后门)

    return NextResponse.json({ error: '无法更新密码 — 请重新发送重置邮件并点击新链接' }, { status: 400 });
  } catch (err: any) {
    console.error('[update-password] Unexpected error:', err);
    return NextResponse.json({ error: err.message || '操作失败' }, { status: 500 });
  }
}
