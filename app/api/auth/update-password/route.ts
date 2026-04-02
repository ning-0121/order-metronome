import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';

export async function POST(request: Request) {
  try {
    const { password, access_token } = await request.json();

    if (!password || password.length < 8) {
      return NextResponse.json({ error: '密码至少需要 8 位' }, { status: 400 });
    }

    // 方法1: 用 server client (cookie session)
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (user) {
      const { error } = await supabase.auth.updateUser({ password });
      if (!error) return NextResponse.json({ success: true });
    }

    // 方法2: 用 access_token 直接调用
    if (access_token) {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (url && key) {
        const tokenClient = createAdminClient(url, key, {
          global: { headers: { Authorization: `Bearer ${access_token}` } }
        });
        const { error } = await tokenClient.auth.updateUser({ password });
        if (!error) return NextResponse.json({ success: true });
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }

    return NextResponse.json({ error: 'Auth session missing - 请重新发送重置邮件并点击新链接' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || '操作失败' }, { status: 500 });
  }
}
