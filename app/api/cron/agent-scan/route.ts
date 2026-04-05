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
import { buildCustomerProfile, type CustomerProfile } from '@/lib/agent/customerProfile';
import { buildFactoryProfile, type FactoryProfile } from '@/lib/agent/factoryProfile';
import { AGENT_FLAGS } from '@/lib/agent/featureFlags';
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

    // 0. 链式动作
    if (AGENT_FLAGS.chainActions()) {
    // 链式动作：检查已执行的链式建议，到时间后生成下一步
    const { data: chainActions } = await supabase
      .from('agent_actions')
      .select('id, order_id, milestone_id, action_payload, executed_at')
      .eq('status', 'executed')
      .not('action_payload->chain_next_type', 'is', null)
      .limit(50);

    let chainGenerated = 0;
    for (const ca of chainActions || []) {
      const payload = ca.action_payload as any;
      if (!payload?.chain_next_type || !payload?.chain_delay_hours || !ca.executed_at) continue;
      // 检查是否已过等待时间
      const execTime = new Date(ca.executed_at).getTime();
      const waitMs = payload.chain_delay_hours * 60 * 60 * 1000;
      if (Date.now() - execTime < waitMs) continue;
      // 检查原节点是否已解决（如果已解决就不升级了）
      if (ca.milestone_id) {
        const { data: ms } = await supabase.from('milestones').select('status').eq('id', ca.milestone_id).single();
        if (ms && (ms.status === 'done' || ms.status === '已完成')) {
          // 节点已完成，清除链（标记chain为null防重复）
          await supabase.from('agent_actions').update({ action_payload: { ...payload, chain_next_type: null } }).eq('id', ca.id);
          continue;
        }
      }
      // 生成下一步
      const chainDedup = `${payload.chain_id || ca.id}:step2`;
      const { data: existing } = await supabase.from('agent_actions').select('id').eq('dedup_key', chainDedup).in('status', ['pending', 'executing']).limit(1);
      if (existing && existing.length > 0) continue;

      await supabase.from('agent_actions').insert({
        order_id: ca.order_id,
        milestone_id: ca.milestone_id,
        action_type: payload.chain_next_type,
        title: `[自动升级] 催办后${payload.chain_delay_hours}h无回应，建议升级CEO`,
        description: '前一步催办已执行但节点仍未处理，建议升级管理层介入。',
        reason: '链式动作自动触发：催办→等待→升级',
        severity: 'high',
        action_payload: { chain_step: 2, chain_id: payload.chain_id },
        status: 'pending',
        dedup_key: chainDedup,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      // 清除原动作的chain防重复触发
      await supabase.from('agent_actions').update({ action_payload: { ...payload, chain_next_type: null } }).eq('id', ca.id);
      chainGenerated++;
    }
    } // end chainActions flag

    // 0.5 清理卡死的 'executing' 状态（超5分钟未完成的回退pending）
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await supabase.from('agent_actions')
      .update({ status: 'pending' })
      .eq('status', 'executing')
      .lt('created_at', fiveMinAgo);

    // 1. 清理过期建议
    const { count: expiredCount } = await supabase
      .from('agent_actions')
      .update({ status: 'expired' })
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString())
      .select('id', { count: 'exact', head: true });

    // 2. 获取执行中订单（限制200单防OOM，按创建时间倒序优先处理新单）
    const { data: orders } = await supabase
      .from('orders')
      .select('id, order_no, customer_name, factory_name, quantity, lifecycle_status, incoterm, order_type, factory_date, is_new_customer, is_new_factory')
      .in('lifecycle_status', ['执行中', 'running', 'active', '已生效'])
      .order('created_at', { ascending: false })
      .limit(200);

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
    const customerProfileCache = new Map<string, CustomerProfile | null>();
    const factoryProfileCache = new Map<string, FactoryProfile | null>();
    let totalAutoExecuted = 0;

    // 5. 逐订单生成建议
    for (const order of orders) {
      const { data: milestones } = await supabase
        .from('milestones')
        .select('id, step_key, name, status, due_at, owner_role, owner_user_id, evidence_required, is_critical')
        .eq('order_id', order.id);

      const orderActions = (allExistingActions || []).filter((a: any) => a.order_id === order.id);

      // 客户画像
      let custProfile: CustomerProfile | null = null;
      if (AGENT_FLAGS.customerProfile() && order.customer_name) {
        if (!customerProfileCache.has(order.customer_name)) {
          customerProfileCache.set(order.customer_name, await buildCustomerProfile(supabase, order.customer_name).catch(() => null));
        }
        custProfile = customerProfileCache.get(order.customer_name) || null;
      }

      // 工厂画像
      let factProfile: FactoryProfile | null = null;
      if (AGENT_FLAGS.factoryProfile() && order.factory_name) {
        if (!factoryProfileCache.has(order.factory_name)) {
          factoryProfileCache.set(order.factory_name, await buildFactoryProfile(supabase, order.factory_name).catch(() => null));
        }
        factProfile = factoryProfileCache.get(order.factory_name) || null;
      }

      let suggestions = generateSuggestionsForOrder(
        order, milestones || [], profileList, orderActions, custProfile
      );

      if (suggestions.length === 0) continue;

      // Phase 2: AI 增强
      const hasHighSeverity = AGENT_FLAGS.aiEnhance() && suggestions.some(s => s.severity === 'high');
      if (hasHighSeverity) {
        try {
          const memory = await getEnhancementContext(supabase, order.id, order.customer_name, order.factory_name);
          const milestonesCtx = (milestones || []).map((m: any) => ({
            name: m.name, status: m.status, dueAt: m.due_at,
            daysOverdue: m.due_at && new Date(m.due_at) < new Date() ? Math.ceil((Date.now() - new Date(m.due_at).getTime()) / 86400000) : 0,
            ownerRole: m.owner_role, isCritical: m.is_critical,
          }));
          // 注入工厂产能数据到AI上下文
          if (factProfile) {
            memory.factoryCapacity = factProfile.monthlyCapacity || undefined;
            memory.historicalOnTimeRate = factProfile.historicalOnTimeRate;
            if (factProfile.utilizationRate > 90) {
              memory.customerMemories = [
                `⚠ 工厂${order.factory_name}当前产能利用率${factProfile.utilizationRate}%（${factProfile.tags.join('、')}）`,
                ...memory.customerMemories,
              ];
            }
          }
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

      // 6. L1 自动执行（每单每次最多2个自动执行，防通知轰炸）
      let autoExecThisOrder = 0;
      const MAX_AUTO_PER_ORDER = 2;
      for (const action of inserted || []) {
        if (autoExecThisOrder >= MAX_AUTO_PER_ORDER) break;
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
            autoExecThisOrder++;
          }
        }

        // L1 自动执行：通知下一节点 + 自动推进状态
        if (action.action_type === 'notify_next') {
          const payload = action.action_payload as any;
          // L2 自动推进：将下一节点从 pending → in_progress
          if (action.milestone_id) {
            await supabase.from('milestones')
              .update({ status: 'in_progress' })
              .eq('id', action.milestone_id)
              .eq('status', 'pending');
          }
          if (payload?.target_user_id) {
            await supabase.from('notifications').insert({
              user_id: payload.target_user_id,
              type: 'agent_notify',
              title: `[Agent] 轮到你了`,
              message: `前置节点已完成，「${payload.next_milestone_name || '下一节点'}」已自动启动。订单：${order.order_no}`,
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
            autoExecThisOrder++;
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

    // 8. 跨订单协调：同一工厂多订单延期 → 整体建议
    let crossOrderSuggestions = 0;
    const factoryOverdueMap = new Map<string, string[]>(); // factory → orderNos
    for (const order of orders) {
      if (!order.factory_name) continue;
      const { data: orderMs } = await supabase.from('milestones').select('status, due_at')
        .eq('order_id', order.id).in('status', ['in_progress', '进行中']).lt('due_at', new Date().toISOString()).limit(1);
      if (orderMs && orderMs.length > 0) {
        const list = factoryOverdueMap.get(order.factory_name) || [];
        list.push(order.order_no);
        factoryOverdueMap.set(order.factory_name, list);
      }
    }
    for (const [factory, orderNos] of factoryOverdueMap) {
      if (orderNos.length < 3) continue; // 3个以上才触发
      const dedupKey = `cross:${factory}:${new Date().toISOString().slice(0, 10)}`;
      const { data: existing } = await supabase.from('agent_actions').select('id').eq('dedup_key', dedupKey).in('status', ['pending', 'executing']).limit(1);
      if (existing && existing.length > 0) continue;
      const firstOrder = orders.find((o: any) => o.factory_name === factory);
      if (!firstOrder) continue;
      await supabase.from('agent_actions').insert({
        order_id: firstOrder.id,
        action_type: 'escalate_ceo',
        title: `⚠️ 工厂「${factory}」${orderNos.length}个订单同时延期`,
        description: `涉及订单：${orderNos.join('、')}。建议与工厂整体协调产能和交期。`,
        reason: '多订单同一工厂延期表明工厂产能问题，需系统性解决而非逐单催办。',
        severity: 'high',
        action_payload: { factory_name: factory, order_nos: orderNos, is_cross_order: true },
        status: 'pending',
        dedup_key: dedupKey,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      crossOrderSuggestions++;
    }

    // 9. 资源协调：超负荷工厂建议转厂
    for (const [factoryName, profile] of factoryProfileCache) {
      if (!profile || profile.utilizationRate <= 120) continue;
      // 找产能空闲的同类工厂
      const { data: altFactories } = await supabase
        .from('factories')
        .select('factory_name, monthly_capacity, worker_count')
        .is('deleted_at', null)
        .neq('factory_name', factoryName);
      const available = (altFactories || []).filter((f: any) => {
        const fp = factoryProfileCache.get(f.factory_name);
        return fp && fp.utilizationRate < 60;
      });
      if (available.length > 0) {
        const dedupKey = `resource:${factoryName}:${new Date().toISOString().slice(0, 10)}`;
        const { data: existing } = await supabase.from('agent_actions').select('id').eq('dedup_key', dedupKey).in('status', ['pending', 'executing']).limit(1);
        if (!existing || existing.length === 0) {
          const firstOrder = orders.find((o: any) => o.factory_name === factoryName);
          if (firstOrder) {
            await supabase.from('agent_actions').insert({
              order_id: firstOrder.id,
              action_type: 'escalate_ceo',
              title: `🏭 工厂「${factoryName}」超负荷（${profile.utilizationRate}%），建议分流`,
              description: `${factoryName}当前产能利用率${profile.utilizationRate}%，可考虑转部分订单到：${available.map((f: any) => f.factory_name).join('、')}`,
              reason: '产能超负荷会导致交期延误和品质下降，建议提前分流。',
              severity: 'high',
              action_payload: { factory_name: factoryName, utilization: profile.utilizationRate, alternatives: available.map((f: any) => f.factory_name) },
              status: 'pending',
              dedup_key: dedupKey,
              expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            });
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      ordersScanned: orders.length,
      suggestionsGenerated: totalGenerated,
      chainActionsGenerated: chainGenerated,
      autoExecuted: totalAutoExecuted,
      crossOrderSuggestions,
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
