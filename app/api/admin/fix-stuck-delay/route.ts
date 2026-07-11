import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';

/**
 * 临时:以 admin 身份走真实审批路径批掉那条卡住的延期(50354794)。
 * admin 必过所有权限闸 → 若成功=延期批了(卡住解除)+ 证明路径可用;若失败=返回真实错误定位 bug。用完删。
 * GET /api/admin/fix-stuck-delay
 */
export async function GET() {
  const supabase = await createClient();
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return NextResponse.json({ error: '仅管理员可访问' }, { status: 403 });

  const delayId = '50354794-b742-4594-8b18-839d599b2349';
  const { approveDeferralStep } = await import('@/app/actions/delays');

  // 无 mode 先试(不影响交期就直接落地;影响交期会返回 needsMode)
  const first = await approveDeferralStep(delayId, 'admin 清理卡住的延期申请');
  if ((first as any)?.needsMode) {
    // 影响交期 → 用「退交期」模式落地(把交期往后推,最稳妥)
    const second = await approveDeferralStep(delayId, 'admin 清理卡住的延期申请', 'push_delivery');
    return NextResponse.json({
      步骤: '影响交期→用退交期模式再批',
      第一次: first, 第二次: second,
      结论: (second as any)?.error ? `❌ 仍失败:${(second as any).error}` : '✅ 已批准(退交期落地),卡住解除',
    }, { status: 200 });
  }
  return NextResponse.json({
    结果: first,
    结论: (first as any)?.error ? `❌ 失败:${(first as any).error}(这就是高洁点批准时的真实错误)` : '✅ 已批准,卡住解除',
  }, { status: 200 });
}
