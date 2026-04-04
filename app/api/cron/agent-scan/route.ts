/**
 * Agent 巡检 Cron — 每小时运行
 *
 * 1. 扫描所有执行中订单
 * 2. 为每个订单生成 Agent 建议（规则引擎）
 * 3. 自动执行 L1 动作（超期通知、日报提醒）
 * 4. 清理过期建议
 *
 * Vercel Cron: 每小时运行一次
 * 配置: vercel.json → crons → /api/cron/agent-scan
 */

import { createClient } from '@supabase/supabase-js';
import { generateSuggestionsForOrder } from '@/lib/agent/generateSuggestions';
import { enhanceSuggestionsWithAI, getEnhancementContext } from '@/lib/agent/aiEnhance';
import { CIRCUIT_BREAKER } from '@/lib/agent/types';
import { pushToUsers } from '@/lib/utils/wechat-push';
import { NextResponse } from 'next/server';

export const maxDuration = 60; // Vercel 最大60秒

export async function POST(req: Request) {
  try {
    // 验证 cron secret
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      return NextResponse.json({ error: 'Missing config' }, { status: 500 });
    }

    const supabase = createClient(url, serviceKey);

    // 1. 清理过期建议
    const { count: expiredCount } = await supabase
      .from('agent_actions')
      .update({ status: 'expired' })
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString())
      .select('id', { count: 'exact', head: true });

    // 2. 获取所有执行中订单
    const { data: orders } = await supabase
      .from('orders')
      .select('id, order_no, customer_name, factory_name, quantity, lifecycle_status, incoterm, order_type, factory_date, is_new_customer, is_new_factory')
      .in('lifecycle_status', ['执行中', 'running', 'active', '已生效']);

    if (!orders || orders.length === 0) {
      return NextResponse.json({ message: 'No active orders', expired: expiredCount });
    }

    // 3. 获取所有用户（一次查询）
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, name, email, role, roles');
    const profileList = (profiles || []).map((p: any) => ({
      user_id: p.user_id,
      name: p.name,
      email: p.email,
      roles: p.roles?.length > 0 ? p.roles : [p.role].filter(Boolean),
    }));

    // 4. 获取所有已有建议（防重复）
    const { data: allExistingActions } = await supabase
      .from('agent_actions')
      .select('dedup_key, status, created_at, order_id');

    let totalGenerated = 0;
    let totalAutoExecuted = 0;

    // 5. 逐订单生成建议
    for (const order of orders) {
      const { data: milestones } = await supabase
        .from('milestones')
        .select('id, step_key, name, status, due_at, owner_role, owner_user_id, evidence_required, is_critical')
        .eq('order_id', order.id);

      const orderActions = (allExistingActions || []).filter((a: any) => a.order_id === order.id);

      let suggestions = generateSuggestionsForOrder(
        order, milestones || [], profileList, orderActions
      );

      if (suggestions.length === 0) continue;

      // Phase 2: AI 增强（只对有 high severity 建议的订单调用，控制成本）
      const hasHighSeverity = suggestions.some(s => s.severity === 'high');
      if (hasHighSeverity) {
        try {
          const memory = await getEnhancementContext(supabase, order.id, order.customer_name, order.factory_name);
          const milestonesCtx = (milestones || []).map((m: any) => ({
            name: m.name, status: m.status, dueAt: m.due_at,
            daysOverdue: m.due_at && new Date(m.due_at) < new Date() ? Math.ceil((Date.now() - new Date(m.due_at).getTime()) / 86400000) : 0,
            ownerRole: m.owner_role, isCritical: m.is_critical,
          }));
          suggestions = await enhanceSuggestionsWithAI(suggestions, {
            orderNo: order.order_no, customerName: order.customer_name,
            factoryName: order.factory_name, quantity: order.quantity,
          }, milestonesCtx, memory);
        } catch { /* AI失败不影响，用规则引擎原始建议 */ }
      }

      // 存入数据库
      const rows = suggestions.map(s => ({
        order_id: s.orderId,
        milestone_id: s.milestoneId || null,
        action_type: s.actionType,
        title: s.title,
        description: s.description,
        reason: s.reason,
        severity: s.severity,
        action_payload: s.payload,
        status: 'pending',
        dedup_key: s.payload.dedup_key,
        expires_at: new Date(Date.now() + CIRCUIT_BREAKER.expirationHours * 60 * 60 * 1000).toISOString(),
      }));

      const { data: inserted } = await supabase
        .from('agent_actions')
        .insert(rows)
        .select('id, action_type, milestone_id, action_payload');

      totalGenerated += (inserted || []).length;

      // 统计超期数（用于客户记忆）
      const overdueCount = (milestones || []).filter((m: any) =>
        m.status !== 'done' && m.status !== '已完成' && m.due_at && new Date(m.due_at) < new Date()
      ).length;

      // 6. L1 自动执行：超期通知 + 日报提醒（不需要人确认的动作）
      for (const action of inserted || []) {
        if (action.action_type === 'send_nudge') {
          // 自动催办：发送通知给负责人
          const payload = action.action_payload as any;
          if (payload?.target_user_id) {
            await supabase.from('notifications').insert({
              user_id: payload.target_user_id,
              type: 'agent_nudge',
              title: `[Agent] 节点超期提醒`,
              message: `您负责的节点已超期${payload.days_overdue || ''}天，请尽快处理。订单：${order.order_no}`,
              related_order_id: order.id,
              related_milestone_id: action.milestone_id,
              status: 'unread',
            });

            // 微信推送
            await pushToUsers(supabase, [payload.target_user_id],
              `⏰ 节点超期提醒 — ${order.order_no}`,
              `您负责的节点已超期${payload.days_overdue || ''}天，请尽快处理。`
            ).catch(() => {});

            // 标记为已执行
            await supabase
              .from('agent_actions')
              .update({ status: 'executed', executed_at: new Date().toISOString() })
              .eq('id', action.id);

            totalAutoExecuted++;
          }
        }

        // L1 自动执行：通知下一节点负责人
        if (action.action_type === 'notify_next') {
          const payload = action.action_payload as any;
          if (payload?.target_user_id) {
            await supabase.from('notifications').insert({
              user_id: payload.target_user_id,
              type: 'agent_notify',
              title: `[Agent] 轮到你了`,
              message: `前置节点已完成，请启动「${payload.next_milestone_name || '下一节点'}」。订单：${order.order_no}`,
              related_order_id: order.id,
              related_milestone_id: action.milestone_id,
              status: 'unread',
            });
            // 微信推送
            await pushToUsers(supabase, [payload.target_user_id],
              `📢 轮到你了 — ${order.order_no}`,
              `前置节点已完成，请启动「${payload.next_milestone_name || '下一节点'}」。`
            ).catch(() => {});

            await supabase.from('agent_actions')
              .update({ status: 'executed', executed_at: new Date().toISOString() })
              .eq('id', action.id);
            totalAutoExecuted++;
          }
        }
      }

      // 7. 客户记忆自动积累：记录超期模式
      if (overdueCount >= 2 && order.customer_name) {
        const memoryContent = `订单 ${order.order_no}：${overdueCount} 个节点超期`;
        // 防重复：同订单同天不重复记录
        const { data: existingMem } = await supabase
          .from('customer_memory')
          .select('id')
          .eq('customer_id', order.customer_name)
          .eq('order_id', order.id)
          .eq('category', 'delay')
          .gte('created_at', new Date().toISOString().slice(0, 10) + 'T00:00:00Z')
          .limit(1);
        if (!existingMem || existingMem.length === 0) {
          await supabase.from('customer_memory').insert({
            customer_id: order.customer_name,
            order_id: order.id,
            source_type: 'agent_scan',
            content: memoryContent,
            category: 'delay',
            risk_level: overdueCount >= 4 ? 'high' : 'medium',
          }).catch(() => {});
        }
      }
    }

    return NextResponse.json({
      success: true,
      ordersScanned: orders.length,
      suggestionsGenerated: totalGenerated,
      autoExecuted: totalAutoExecuted,
      expiredCleaned: expiredCount || 0,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[agent-scan] Error:', err?.message);
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 });
  }
}

// GET 也支持（方便手动测试）
export async function GET(req: Request) {
  return POST(req);
}
