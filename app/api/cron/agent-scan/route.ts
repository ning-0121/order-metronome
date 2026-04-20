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
import { analyzeHistoricalPattern } from '@/lib/agent/historicalPattern';
import { AGENT_FLAGS } from '@/lib/agent/featureFlags';
import { executeMultiStepReasoning } from '@/lib/agent/multiStepReasoning';
import { analyzeChainImpact } from '@/lib/agent/chainImpact';
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
        const { data: ms } = await supabase.from('milestones').select('status').eq('id', ca.milestone_id).maybeSingle();
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

    // 0.8 多轮推理：检查催办后24h的进展
    const multiStepEscalated = await executeMultiStepReasoning(supabase).catch(() => 0);

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
      .select('id, order_no, customer_name, factory_name, quantity, lifecycle_status, incoterm, order_type, factory_date, is_new_customer, is_new_factory, special_tags, ai_scan_date, owner_user_id')
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

      // 查订单附件（用于过滤"缺少凭证"误报）
      const { data: orderAttachments } = await supabase
        .from('order_attachments')
        .select('file_type')
        .eq('order_id', order.id);
      const attachmentTypes = (orderAttachments || []).map((a: any) => a.file_type);

      let suggestions = generateSuggestionsForOrder(
        order, milestones || [], profileList, orderActions, custProfile, attachmentTypes
      );

      if (suggestions.length === 0) continue;

      // Phase 2: AI 增强
      // ── 每日缓存机制 ──────────────────────────────────────────────────
      // 规则引擎每小时运行（dedup 防重复）；AI 增强每单每天最多 1 次，
      // 避免对同一订单重复调用 Claude，降低 ~20x token 消耗。
      // 判断依据：orders.ai_scan_date（新字段）是否等于今日日期
      // 使用业务时区（东8区）计算"今天"，避免 UTC 跨天误差导致同一天跑2次 AI 增强
      const todayDate = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10); // YYYY-MM-DD
      const alreadyAIScannedToday = order.ai_scan_date === todayDate;

      const hasHighSeverity = AGENT_FLAGS.aiEnhance()
        && !alreadyAIScannedToday          // ← 今天已跑过 AI 增强则跳过
        && suggestions.some(s => s.severity === 'high');

      if (hasHighSeverity) {
        try {
          const memory = await getEnhancementContext(supabase, order.id, order.customer_name, order.factory_name);
          const milestonesCtx = (milestones || []).map((m: any) => ({
            name: m.name, status: m.status, dueAt: m.due_at,
            daysOverdue: m.due_at && new Date(m.due_at) < new Date() ? Math.ceil((Date.now() - new Date(m.due_at).getTime()) / 86400000) : 0,
            ownerRole: m.owner_role, isCritical: m.is_critical,
          }));
          // 注入行业知识建议
          const { getIndustryAdvice } = await import('@/lib/agent/industryKnowledge');
          const industryTips = getIndustryAdvice({
            specialTags: order.special_tags, orderType: order.order_type,
            quantity: order.quantity, currentMonth: new Date().getMonth() + 1,
          });
          if (industryTips.length > 0) {
            memory.customerMemories = [...(memory.customerMemories || []), ...industryTips.map(t => `[行业] ${t}`)];
          }
          // 注入历史模式到AI上下文
          const histPattern = await analyzeHistoricalPattern(supabase, order.customer_name, order.factory_name, order.quantity).catch(() => null);
          if (histPattern) {
            memory.historicalPattern = `历史分析(${histPattern.similarOrderCount}单)：超期率${histPattern.overdueRate}%，常超期节点：${histPattern.commonDelayNodes.join('、')}，${histPattern.riskPrediction}`;
          }
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

          // ── 写回 AI 扫描日期（下次同日跳过 AI 增强） ──
          const { error: updateErr } = await supabase.from('orders')
            .update({
              ai_scan_date: todayDate,
              ai_scan_suggestion_count: suggestions.length,
            })
            .eq('id', order.id);
          if (updateErr) {
            console.warn(`[agent-scan] 更新 ai_scan_date 失败 order=${order.id}:`, updateErr.message);
          }
        } catch (aiErr: any) {
          console.warn(`[agent-scan] AI 增强失败 order=${order.id}:`, aiErr?.message || aiErr);
          /* AI失败不影响，用规则引擎原始建议 */
        }
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

      // 统计超期数
      const overdueCount = (milestones || []).filter((m: any) =>
        m.status !== 'done' && m.status !== '已完成' && m.due_at && new Date(m.due_at) < new Date()
      ).length;

      // 5.5 主动提问：关键异常推送给负责人（每单每天最多1次）
      if (overdueCount >= 3 && order.owner_user_id) {
        const questionDedup = `question:${order.id}:${new Date().toISOString().slice(0, 10)}`;
        const { data: existQ } = await supabase.from('agent_actions').select('id').eq('dedup_key', questionDedup).limit(1);
        if (!existQ || existQ.length === 0) {
          await supabase.from('notifications').insert({
            user_id: order.owner_user_id,
            type: 'agent_question',
            title: `🤖 Agent 提问：${order.order_no} 需要你的判断`,
            message: `订单有${overdueCount}个节点超期。请判断：1)需要申请延期？2)需要协调资源？3)可以正常推进？请在订单详情页操作。`,
            related_order_id: order.id,
            status: 'unread',
          });
          // 微信推送
          if (AGENT_FLAGS.wechatPush()) {
            await pushToUsers(supabase, [order.owner_user_id],
              `🤖 Agent提问：${order.order_no}`,
              `${overdueCount}个节点超期，需要你判断下一步行动。请打开系统处理。`
            ).catch(() => {});
          }
          await supabase.from('agent_actions').insert({
            order_id: order.id, action_type: 'send_nudge', title: `主动提问：${order.order_no}`,
            status: 'executed', executed_at: new Date().toISOString(),
            dedup_key: questionDedup, expires_at: new Date(Date.now() + 86400000).toISOString(),
          });
        }
      }

      // 6. L1 自动执行（每单每次最多2个自动执行，防通知轰炸）
      let autoExecThisOrder = 0;
      const MAX_AUTO_PER_ORDER = 2;
      for (const action of inserted || []) {
        if (autoExecThisOrder >= MAX_AUTO_PER_ORDER) break;
        if (action.action_type === 'send_nudge' && AGENT_FLAGS.autoNudge()) {
          // 自动催办：点对点发送通知给节点负责人
          const payload = action.action_payload as any;
          if (payload?.target_user_id) {
            // 🔴 CEO 2026-04-09：防止管理员被 Agent 催办刷屏
            // 如果 target 恰好是 admin 角色 → 跳过（admin 不执行节点）
            const { data: targetProfile } = await supabase
              .from('profiles')
              .select('role, roles')
              .eq('user_id', payload.target_user_id)
              .single();
            const targetRoles: string[] = (targetProfile as any)?.roles?.length > 0
              ? (targetProfile as any).roles
              : [(targetProfile as any)?.role].filter(Boolean);
            const targetIsAdmin = targetRoles.includes('admin')
              && !targetRoles.some(r => ['sales', 'merchandiser', 'finance', 'procurement'].includes(r));
            if (targetIsAdmin) {
              // admin 单一角色 → 跳过，让 CEO 清静
              console.log(`[agent-scan] 跳过 admin 催办 — ${order.order_no}`);
              await supabase
                .from('agent_actions')
                .update({ status: 'dismissed', executed_at: new Date().toISOString() })
                .eq('id', action.id);
              continue;
            }

            // 标题包含订单号 + 节点名 → 责任明确
            const nudgeTitle = `⏰ ${order.order_no} · ${action.milestone_name || '节点'} 已超期`;
            const nudgeMsg = `您负责的「${action.milestone_name || '节点'}」已超期 ${payload.days_overdue || ''} 天\n订单：${order.order_no}（${order.customer_name || ''}）\n请尽快登录系统处理。`;

            await supabase.from('notifications').insert({
              user_id: payload.target_user_id,
              type: 'agent_nudge',
              title: nudgeTitle,
              message: nudgeMsg,
              related_order_id: order.id,
              related_milestone_id: action.milestone_id,
              status: 'unread',
            });

            // 微信推送
            await pushToUsers(supabase, [payload.target_user_id], nudgeTitle, nudgeMsg).catch(() => {});

            // 标记为已执行
            await supabase
              .from('agent_actions')
              .update({ status: 'executed', executed_at: new Date().toISOString() })
              .eq('id', action.id);

            totalAutoExecuted++;
            autoExecThisOrder++;
          }
        }

        // L1 自动执行：仅发送"轮到你了"通知，不自动修改里程碑状态
        // 修复（2026-04-07 审计）：之前会把下一节点从 pending 自动推进到 in_progress，
        // 这是静默的数据修改，用户没有机会审阅。现在仅发通知，由负责人自己点击「开始处理」。
        if (action.action_type === 'notify_next' && AGENT_FLAGS.autoNotifyNext()) {
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
            autoExecThisOrder++;
          }
        }
      }

      // 6.5 链路预警：上下游提前通知
      try {
        const chainMilestones = (milestones || []).map((m: any, idx: number) => ({
          ...m, sort_order: idx,
        }));
        const anchorDate = order.factory_date || order.etd || null;
        const chainAlerts = analyzeChainImpact(chainMilestones, order.order_no, anchorDate);

        for (const alert of chainAlerts) {
          // 去重：每天每个目标+来源只通知一次
          const alertDedup = `chain:${alert.type}:${alert.targetUserId || alert.targetRole}:${alert.sourceMilestoneId}:${new Date().toISOString().slice(0, 10)}`;
          const { data: existAlert } = await supabase.from('notifications')
            .select('id').eq('type', 'chain_alert')
            .gte('created_at', new Date().toISOString().slice(0, 10) + 'T00:00:00Z')
            .limit(1);
          // 简单限制：每单每次最多发5条链路预警
          if (chainAlerts.indexOf(alert) >= 5) break;

          if (alert.targetUserId) {
            await supabase.from('notifications').insert({
              user_id: alert.targetUserId,
              type: 'chain_alert',
              title: alert.title,
              message: alert.message,
              related_order_id: order.id,
              related_milestone_id: alert.affectedMilestoneId,
              status: 'unread',
            });

            // 高优先级链路预警也推微信
            if (alert.severity === 'high') {
              await pushToUsers(supabase, [alert.targetUserId], alert.title, alert.message).catch(() => {});
            }
          }

          // deadline_risk 通知所有管理员
          if (alert.type === 'deadline_risk') {
            const { data: admins } = await supabase.from('profiles')
              .select('user_id').or("role.eq.admin,roles.cs.{admin}");
            for (const admin of admins || []) {
              await supabase.from('notifications').insert({
                user_id: admin.user_id,
                type: 'chain_alert',
                title: alert.title,
                message: alert.message,
                related_order_id: order.id,
                status: 'unread',
              });
              await pushToUsers(supabase, [admin.user_id], alert.title, alert.message).catch(() => {});
            }
          }
        }
      } catch (chainErr: any) {
        console.error('[agent-scan] Chain impact error:', chainErr?.message);
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
          });
        }
      }
    }

    // 8. 跨订单协调（Feature Flag）
    if (AGENT_FLAGS.crossOrderAnalysis()) {
    // 跨订单协调：同一工厂多订单延期 → 整体建议
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

    } // end crossOrderAnalysis flag

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
