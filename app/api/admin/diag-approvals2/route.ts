import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import { getPendingApprovals } from '@/lib/services/pending-approvals.service';

/**
 * 临时诊断2:直接跑 getPendingApprovals(用高洁的角色 order_manager),看到底返回哪些待审批、
 * 有几项 actionable。定位「高洁工作台审批中心为空」是服务层没返回,还是前端没渲染。用完删。
 * GET /api/admin/diag-approvals2
 */
export async function GET() {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return NextResponse.json({ error: '仅管理员可访问' }, { status: 403 });

  const gaojieUserId = '852a518c-ebe6-4b2d-8f20-606283348592';   // 高洁
  const res = await getPendingApprovals(supabase, { userId: gaojieUserId, roles: ['order_manager', 'merchandiser'] });

  if (!(res as any).ok) return NextResponse.json({ ok: false, error: (res as any).error }, { status: 200 });
  const data = (res as any).data;
  return NextResponse.json({
    以高洁角色_order_manager_跑getPendingApprovals: {
      总项数: data.total,
      我能处理的_actionableCount: data.actionableCount,
      按类: data.byCategory,
      前8项: data.items.slice(0, 8).map((i: any) => ({
        类型: i.category, 标题: i.title, 可处理: i.actionable, 订单: i.orderNo, 等待天数: i.ageDays,
      })),
    },
    结论: data.actionableCount > 0
      ? '✅ 服务层有返回可处理项 → 若工作台还空,是前端/部署问题(硬刷新/等部署)'
      : '❌ 服务层返回 0 个可处理项 → 问题在服务层(clientFor/RLS/actionable),继续查',
  }, { status: 200 });
}
