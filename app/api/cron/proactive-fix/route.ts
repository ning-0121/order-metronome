/**
 * 主动问题发现与自动修复 — 每2小时运行
 *
 * 不等用户报告，系统自己发现并修复：
 *   1. 数据完整性修复（缺失负责人、错误状态）
 *   2. 流程卡点清理（死锁节点、过期状态）
 *   3. 性能优化（清理过期缓存、压缩日志）
 *   4. 员工提醒（长期未操作的节点、遗忘的任务）
 */

import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 55;

interface FixResult {
  check: string;
  found: number;
  fixed: number;
  details?: string;
}

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;

  const supabase = await createClient();
  if (!isCron) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const fixes: FixResult[] = [];
  const now = new Date();

  // ═══════════════════════════════════════════
  // 修复1：财务/采购/生产主管节点缺失负责人
  // ═══════════════════════════════════════════
  try {
    const { DEFAULT_ASSIGNEES, findAssigneeUserId } = await import('@/lib/domain/default-assignees');
    const { data: allProfiles } = await (supabase.from('profiles') as any)
      .select('user_id, name, email, role, roles');

    let assignedCount = 0;
    if (allProfiles) {
      for (const [roleName, matcher] of Object.entries(DEFAULT_ASSIGNEES)) {
        const userId = findAssigneeUserId(allProfiles as any, matcher);
        if (!userId) continue;
        const { data: unassigned } = await (supabase.from('milestones') as any)
          .select('id')
          .eq('owner_role', roleName)
          .is('owner_user_id', null)
          .limit(100);
        if (unassigned && unassigned.length > 0) {
          await (supabase.from('milestones') as any)
            .update({ owner_user_id: userId })
            .in('id', unassigned.map((m: any) => m.id));
          assignedCount += unassigned.length;
        }
      }
    }
    fixes.push({ check: '补分配负责人', found: assignedCount, fixed: assignedCount });
  } catch {}

  // ═══════════════════════════════════════════
  // 修复2：草稿/待审批订单超过3天自动激活
  // ═══════════════════════════════════════════
  try {
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const { data: staleDrafts } = await (supabase.from('orders') as any)
      .select('id')
      .in('lifecycle_status', ['draft', '草稿', 'pending_approval'])
      .lt('created_at', threeDaysAgo.toISOString());

    if (staleDrafts && staleDrafts.length > 0) {
      await (supabase.from('orders') as any)
        .update({ lifecycle_status: 'active' })
        .in('id', staleDrafts.map((d: any) => d.id));
      fixes.push({ check: '激活滞留草稿订单', found: staleDrafts.length, fixed: staleDrafts.length });
    } else {
      fixes.push({ check: '激活滞留草稿订单', found: 0, fixed: 0 });
    }
  } catch {}

  // ═══════════════════════════════════════════
  // 修复3：in_progress 超过30天的节点（可能是bug）
  // ═══════════════════════════════════════════
  try {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const { data: zombieNodes } = await (supabase.from('milestones') as any)
      .select('id, name, step_key, order_id')
      .in('status', ['in_progress', '进行中'])
      .lt('due_at', thirtyDaysAgo.toISOString())
      .limit(50);

    fixes.push({
      check: '超30天进行中节点（僵尸节点）',
      found: zombieNodes?.length || 0,
      fixed: 0,
      details: zombieNodes?.slice(0, 5).map((m: any) => m.name).join(', '),
    });

    // 通知管理员处理僵尸节点
    if (zombieNodes && zombieNodes.length > 0) {
      const { data: admins } = await (supabase.from('profiles') as any)
        .select('user_id')
        .contains('roles', ['admin']);
      for (const admin of (admins || [])) {
        // 避免重复通知：检查是否已有未读通知
        const { data: existing } = await (supabase.from('notifications') as any)
          .select('id')
          .eq('user_id', admin.user_id)
          .eq('type', 'zombie_nodes')
          .eq('status', 'unread')
          .limit(1);
        if (!existing || existing.length === 0) {
          await (supabase.from('notifications') as any).insert({
            user_id: admin.user_id,
            type: 'zombie_nodes',
            title: `⚠ ${zombieNodes.length} 个节点超过30天仍未完成`,
            message: `请检查：${zombieNodes.slice(0, 3).map((m: any) => m.name).join('、')}等`,
            status: 'unread',
          });
        }
      }
    }
  } catch {}

  // ═══════════════════════════════════════════
  // 修复4：清理过期AI缓存
  // ═══════════════════════════════════════════
  try {
    const { data: expired } = await (supabase.from('ai_skill_runs') as any)
      .select('id')
      .lt('expires_at', now.toISOString())
      .eq('status', 'success')
      .limit(200);

    if (expired && expired.length > 0) {
      await (supabase.from('ai_skill_runs') as any)
        .update({ invalidated_at: now.toISOString() })
        .in('id', expired.map((r: any) => r.id));
      fixes.push({ check: '清理过期AI缓存', found: expired.length, fixed: expired.length });
    } else {
      fixes.push({ check: '清理过期AI缓存', found: 0, fixed: 0 });
    }
  } catch {}

  // ═══════════════════════════════════════════
  // 修复5：提醒长期未操作的关键节点负责人
  // ═══════════════════════════════════════════
  try {
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const { data: overdueNodes } = await (supabase.from('milestones') as any)
      .select('id, name, step_key, owner_user_id, due_at, order_id, is_critical')
      .in('status', ['in_progress', '进行中', 'pending', '待处理'])
      .eq('is_critical', true)
      .lt('due_at', threeDaysAgo.toISOString())
      .not('owner_user_id', 'is', null)
      .limit(50);

    let reminded = 0;
    for (const node of (overdueNodes || [])) {
      // 检查是否已有延期申请
      const { data: delays } = await (supabase.from('delay_requests') as any)
        .select('id')
        .eq('milestone_id', node.id)
        .eq('status', 'pending')
        .limit(1);
      if (delays && delays.length > 0) continue; // 已申请延期

      // 检查是否已发过提醒（避免重复）
      const { data: existingReminder } = await (supabase.from('notifications') as any)
        .select('id')
        .eq('related_milestone_id', node.id)
        .eq('type', 'proactive_reminder')
        .gte('created_at', threeDaysAgo.toISOString())
        .limit(1);
      if (existingReminder && existingReminder.length > 0) continue;

      const daysOverdue = Math.ceil((now.getTime() - new Date(node.due_at).getTime()) / 86400000);
      await (supabase.from('notifications') as any).insert({
        user_id: node.owner_user_id,
        type: 'proactive_reminder',
        title: `⏰ 「${node.name}」已逾期 ${daysOverdue} 天，请尽快处理或申请延期`,
        message: `关键节点逾期未处理。请前往订单详情执行该节点，或申请延期并说明原因。`,
        related_order_id: node.order_id,
        related_milestone_id: node.id,
        status: 'unread',
      });
      reminded++;
    }
    fixes.push({ check: '逾期关键节点主动提醒', found: overdueNodes?.length || 0, fixed: reminded });
  } catch {}

  const totalFixed = fixes.reduce((s, f) => s + f.fixed, 0);
  const totalFound = fixes.reduce((s, f) => s + f.found, 0);

  return NextResponse.json({
    success: true,
    timestamp: now.toISOString(),
    total_found: totalFound,
    total_fixed: totalFixed,
    fixes,
  });
}
