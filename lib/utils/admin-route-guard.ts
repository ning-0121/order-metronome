import { createClient } from '@/lib/supabase/server';
import { isAdminRole } from '@/lib/domain/roles';

/**
 * 管理/回填/导入类 API 路由统一鉴权守卫（fail-closed）。
 * 放行条件二选一：
 *   1) Header `Authorization: Bearer <CRON_SECRET>`（cron / 手动 curl）
 *   2) 登录的 admin 会话（含邮箱白名单兜底）
 * 任何其它情况一律拒绝。返回 { ok:true } 或 { ok:false, status, error }。
 *
 * 背景：多个 service-role 写接口此前要么完全不校验、要么 CRON_SECRET 没设时短路、
 * 要么任意登录用户即放行（2026-06-19 审计）。统一收口到这里。
 */
const ADMIN_EMAILS = ['alex@qimoclothing.com', 'su@qimoclothing.com'];

export async function guardAdminRoute(
  req: Request,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  // 1) CRON_SECRET（仅当已配置且完全匹配）
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') === `Bearer ${secret}`) {
    return { ok: true };
  }

  // 2) 登录 admin 会话
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, status: 401, error: '请先登录' };

    const { data: profile } = await (supabase.from('profiles') as any)
      .select('role, roles')
      .eq('user_id', user.id)
      .single();
    const roles: string[] = (profile as any)?.roles?.length > 0
      ? (profile as any).roles
      : [(profile as any)?.role].filter(Boolean);

    const emailAdmin = !!user.email && ADMIN_EMAILS.includes(user.email);
    if (!isAdminRole(roles) && !emailAdmin) {
      return { ok: false, status: 403, error: '仅管理员可执行此操作' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, status: 500, error: e?.message || '鉴权失败' };
  }
}
