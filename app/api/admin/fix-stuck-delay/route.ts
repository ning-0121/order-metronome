import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';

/**
 * 临时:诊断 + 强制清掉卡住的延期(50354794)。用完删。
 * A) 复刻 Core 的 service-role 读,看 route 里能不能读到(diag-delay-one 已证能读)
 * B) 走真实 approveDeferralStep 抓完整返回(定位 not found 真因)
 * C) 若仍 pending → service-role 直接标 approved + 推里程碑到期日(保证高洁不再卡)
 * GET /api/admin/fix-stuck-delay
 */
export async function GET() {
  const userClient = await createClient();
  const { isAdmin } = await getCurrentUserRole(userClient);
  if (!isAdmin) return NextResponse.json({ error: '仅管理员可访问' }, { status: 403 });

  const delayId = '50354794-b742-4594-8b18-839d599b2349';
  const svc = createServiceRoleClient();

  // A) 复刻 Core 的读(select * + single)
  const coreRead = await (svc.from('delay_requests') as any).select('*').eq('id', delayId).single();
  const A = { 读到了吗: !!coreRead.data, 报错: coreRead.error?.message || null, status: coreRead.data?.status, current_step: coreRead.data?.current_step, chain: coreRead.data?.approval_chain };

  // B) 走真实审批路径抓返回
  let B: any;
  try {
    const { approveDeferralStep } = await import('@/app/actions/delays');
    B = await approveDeferralStep(delayId, 'admin 清理卡住延期', 'push_delivery');
  } catch (e: any) { B = { 抛异常: String(e?.message || e) }; }

  // C) 兜底强制清理(service-role 直改,绕过一切)
  let C: any = '未执行(可能 B 已成功)';
  const after = await (svc.from('delay_requests') as any).select('id, status, approval_chain, milestone_id, proposed_new_due_at').eq('id', delayId).single();
  if (after.data && after.data.status === 'pending') {
    const chain = Array.isArray(after.data.approval_chain) ? after.data.approval_chain : [];
    const now = new Date().toISOString();
    const { error: upErr } = await (svc.from('delay_requests') as any)
      .update({ status: 'approved', current_step: chain.length || 1, approved_at: now, decision_note: 'admin 强制清理卡住的延期(交期来得及)', updated_at: now })
      .eq('id', delayId);
    // 把里程碑到期日推到 proposed(该延期「无后续节点受影响」,只动这个节点)
    let msFix = null;
    if (!upErr && after.data.milestone_id && after.data.proposed_new_due_at) {
      const { error: mErr } = await (svc.from('milestones') as any).update({ due_at: after.data.proposed_new_due_at, updated_at: now }).eq('id', after.data.milestone_id);
      msFix = mErr ? `里程碑到期日未更新:${mErr.message}` : `里程碑到期日已推到 ${after.data.proposed_new_due_at}`;
    }
    C = upErr ? `❌ 强制清理失败:${upErr.message}` : `✅ 已强制标记 approved,卡住解除。${msFix || ''}`;
  } else if (after.data) {
    C = `延期现状态=${after.data.status}(B 步骤可能已处理成功)`;
  }

  return NextResponse.json({ A_复刻Core读: A, B_真实审批返回: B, C_强制清理结果: C }, { status: 200 });
}
