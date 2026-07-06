// ============================================================
// GET /api/finance-sso —— 跨系统 SSO 发起端(财务人从节拍器一键进财务系统,免二次登录)。
// 仅登录用户;仅财务/管理员放行。签 HMAC token(共享 INTEGRATION_WEBHOOK_SECRET)→ 302 跳财务侧接收端。
// token 单次用(nonce)+ 2 分钟过期;每次点击都新签,绝不缓存复用。
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createHmac, randomUUID } from 'crypto';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const FINANCE_SYSTEM_URL = process.env.FINANCE_SYSTEM_URL || '';
const SECRET = process.env.INTEGRATION_WEBHOOK_SECRET || '';

// 财务侧接收端约定 base64url(无填充)
function base64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function GET(req: NextRequest) {
  if (!FINANCE_SYSTEM_URL || !SECRET) {
    return NextResponse.json({ error: '财务系统未配置(FINANCE_SYSTEM_URL / INTEGRATION_WEBHOOK_SECRET)' }, { status: 503 });
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.redirect(new URL('/login', req.url), 302);

  const { data: prof } = await (supabase.from('profiles') as any).select('name, role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  const emailAdmin = ['alex@qimoclothing.com', 'su@qimoclothing.com'].includes(user.email.toLowerCase());
  const isFinance = roles.includes('finance') || roles.includes('admin') || emailAdmin;
  if (!isFinance) return NextResponse.redirect(new URL('/dashboard', req.url), 302); // 非财务不进财务系统

  const role = roles.includes('finance') ? 'finance' : (roles.includes('admin') || emailAdmin) ? 'admin' : (roles[0] || 'finance');
  const payload = {
    email: user.email,
    name: (prof as any)?.name || user.email.split('@')[0],
    role,
    iss: 'order-metronome',
    exp: Date.now() + 120000, // 2 分钟
    nonce: randomUUID(),       // 单次用
  };
  const b64 = base64url(JSON.stringify(payload));
  const sig = createHmac('sha256', SECRET).update(b64).digest('hex');
  const token = `${b64}.${sig}`;

  const target = `${FINANCE_SYSTEM_URL.replace(/\/$/, '')}/api/auth/sso?token=${encodeURIComponent(token)}&redirect=${encodeURIComponent('/dashboard')}`;
  const res = NextResponse.redirect(target, 302);
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate'); // token 绝不缓存
  return res;
}
