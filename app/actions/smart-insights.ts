'use server';

import { createClient } from '@/lib/supabase/server';
import Anthropic from '@anthropic-ai/sdk';

export interface SmartInsight {
  type: 'customer' | 'factory' | 'product' | 'general';
  icon: string;
  title: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
  source: string; // 数据来源说明
}

/**
 * 智能提醒引擎：根据客户、工厂、产品类型，从历史数据中提取经验教训
 * 数据来源：
 * 1. order_retrospectives — 订单复盘中的问题和教训
 * 2. customer_memory — 客户偏好和历史问题
 * 3. milestone_logs — 关卡操作中的备注和阻塞原因
 * 4. delay_requests — 延期原因分析
 * 5. production_reports — 生产不良率数据
 */
export async function getSmartInsights(params: {
  customerName?: string;
  factoryName?: string;
  orderType?: string;
}): Promise<{ data: SmartInsight[] }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { data: [] };

  const insights: SmartInsight[] = [];
  const { customerName, factoryName } = params;

  // ══════ 1. 客户历史分析 ══════
  if (customerName) {
    // 1a. 客户记忆（customer_memory）
    const { data: memories } = await (supabase.from('customer_memory') as any)
      .select('content, category, risk_level')
      .eq('customer_id', customerName)
      .order('created_at', { ascending: false })
      .limit(10);

    if (memories && memories.length > 0) {
      const highRisk = memories.filter((m: any) => m.risk_level === 'high');
      if (highRisk.length > 0) {
        insights.push({
          type: 'customer', icon: '⚠️',
          title: `${customerName} 有 ${highRisk.length} 条高风险记录`,
          detail: highRisk.map((m: any) => m.content).join('；'),
          severity: 'high',
          source: '客户记忆库',
        });
      }

      // 品质相关记忆
      const qualityMemos = memories.filter((m: any) => m.category === 'fabric_quality' || m.category === 'quality');
      if (qualityMemos.length > 0) {
        insights.push({
          type: 'customer', icon: '🔍',
          title: `${customerName} 品质关注点`,
          detail: qualityMemos.map((m: any) => m.content).slice(0, 3).join('；'),
          severity: 'medium',
          source: '客户品质记录',
        });
      }

      // 包装相关
      const packMemos = memories.filter((m: any) => m.category === 'packaging');
      if (packMemos.length > 0) {
        insights.push({
          type: 'customer', icon: '📦',
          title: `${customerName} 包装特殊要求`,
          detail: packMemos.map((m: any) => m.content).slice(0, 3).join('；'),
          severity: 'medium',
          source: '客户包装记录',
        });
      }
    }

    // 1b. 历史订单复盘问题
    const { data: customerOrders } = await (supabase.from('orders') as any)
      .select('id, order_no')
      .eq('customer_name', customerName);

    if (customerOrders && customerOrders.length > 0) {
      const orderIds = customerOrders.map((o: any) => o.id);

      // 复盘中的关键问题
      const { data: retros } = await (supabase.from('order_retrospectives') as any)
        .select('key_issue, root_cause, on_time_delivery, blocked_count, delay_request_count')
        .in('order_id', orderIds);

      if (retros && retros.length > 0) {
        const lateCount = retros.filter((r: any) => r.on_time_delivery === false).length;
        if (lateCount > 0) {
          insights.push({
            type: 'customer', icon: '⏰',
            title: `${customerName} 历史准时率 ${Math.round(((retros.length - lateCount) / retros.length) * 100)}%`,
            detail: `${retros.length} 个历史订单中 ${lateCount} 个未准时交付`,
            severity: lateCount > 1 ? 'high' : 'medium',
            source: '订单复盘数据',
          });
        }

        const issues = retros.map((r: any) => r.key_issue).filter(Boolean);
        if (issues.length > 0) {
          insights.push({
            type: 'customer', icon: '📝',
            title: `${customerName} 历史问题教训`,
            detail: issues.slice(0, 3).join('；'),
            severity: 'medium',
            source: '订单复盘',
          });
        }
      }

      // 延期原因分析
      const { data: delays } = await (supabase.from('delay_requests') as any)
        .select('reason_type, reason_detail')
        .in('order_id', orderIds)
        .limit(10);

      if (delays && delays.length >= 2) {
        const reasonCounts: Record<string, number> = {};
        for (const d of delays) {
          const type = d.reason_type || 'other';
          reasonCounts[type] = (reasonCounts[type] || 0) + 1;
        }
        const topReason = Object.entries(reasonCounts).sort(([, a], [, b]) => b - a)[0];
        const reasonLabels: Record<string, string> = {
          customer_confirmation: '客户确认延迟', supplier_delay: '供应商延迟',
          internal_delay: '内部延迟', logistics: '物流延迟', other: '其他',
        };
        insights.push({
          type: 'customer', icon: '📅',
          title: `该客户订单常见延期原因：${reasonLabels[topReason[0]] || topReason[0]}`,
          detail: `历史 ${delays.length} 次延期中，${reasonLabels[topReason[0]] || topReason[0]}占 ${topReason[1]} 次`,
          severity: 'medium',
          source: '延期记录分析',
        });
      }
    }
  }

  // ══════ 2. 工厂历史分析 ══════
  if (factoryName) {
    const { data: factoryOrders } = await (supabase.from('orders') as any)
      .select('id, order_no')
      .eq('factory_name', factoryName);

    if (factoryOrders && factoryOrders.length > 0) {
      const fOrderIds = factoryOrders.map((o: any) => o.id);

      // 工厂的生产不良率
      const { data: reports } = await (supabase.from('production_reports') as any)
        .select('qty_produced, qty_defect')
        .in('order_id', fOrderIds);

      if (reports && reports.length > 0) {
        const totalProduced = reports.reduce((s: number, r: any) => s + (r.qty_produced || 0), 0);
        const totalDefect = reports.reduce((s: number, r: any) => s + (r.qty_defect || 0), 0);
        const defectRate = totalProduced > 0 ? Math.round((totalDefect / totalProduced) * 1000) / 10 : 0;

        if (defectRate > 3) {
          insights.push({
            type: 'factory', icon: '🏭',
            title: `工厂「${factoryName}」历史不良率 ${defectRate}%`,
            detail: `累计生产 ${totalProduced} 件，不良 ${totalDefect} 件，${defectRate > 5 ? '品质风险较高，建议加强中查' : '需关注品控'}`,
            severity: defectRate > 5 ? 'high' : 'medium',
            source: '生产日报数据',
          });
        }
      }

      // 工厂的阻塞记录
      const { data: blockLogs } = await (supabase.from('milestone_logs') as any)
        .select('note')
        .in('order_id', fOrderIds)
        .eq('action', 'mark_blocked')
        .limit(5);

      if (blockLogs && blockLogs.length >= 2) {
        insights.push({
          type: 'factory', icon: '🚧',
          title: `工厂「${factoryName}」历史有 ${blockLogs.length} 次阻塞记录`,
          detail: blockLogs.map((l: any) => l.note).filter(Boolean).slice(0, 3).join('；') || '多次出现生产阻塞',
          severity: 'medium',
          source: '关卡阻塞记录',
        });
      }

      // 工厂复盘
      const { data: fRetros } = await (supabase.from('order_retrospectives') as any)
        .select('key_issue, root_cause')
        .in('order_id', fOrderIds);

      if (fRetros && fRetros.length > 0) {
        const fIssues = fRetros.map((r: any) => r.key_issue).filter(Boolean);
        if (fIssues.length > 0) {
          insights.push({
            type: 'factory', icon: '📋',
            title: `工厂「${factoryName}」历史问题`,
            detail: fIssues.slice(0, 3).join('；'),
            severity: 'medium',
            source: '复盘记录',
          });
        }
      }
    }
  }

  // ══════ 3. 通用行业提醒 ══════
  // 从系统积累的所有复盘中提取高频问题
  if (insights.length === 0) {
    const { data: allRetros } = await (supabase.from('order_retrospectives') as any)
      .select('key_issue')
      .not('key_issue', 'is', null)
      .order('created_at', { ascending: false })
      .limit(20);

    if (allRetros && allRetros.length >= 3) {
      insights.push({
        type: 'general', icon: '💡',
        title: '公司历史经验提醒',
        detail: allRetros.map((r: any) => r.key_issue).slice(0, 3).join('；'),
        severity: 'low',
        source: '公司复盘知识库',
      });
    }
  }

  // ══════ 4. AI 深度洞察（Claude 分析历史模式） ══════
  if (customerName || factoryName) {
    try {
      const aiInsights = await generateAIInsights(supabase, customerName, factoryName, insights);
      if (aiInsights.length > 0) {
        insights.push(...aiInsights);
      }
    } catch {
      // AI 分析失败不影响规则引擎结果
    }
  }

  return { data: insights };
}

/**
 * Claude AI 深度洞察：分析历史数据中的复合模式
 * - 24小时缓存，避免重复调用
 * - 失败时静默降级
 */
async function generateAIInsights(
  supabase: any,
  customerName?: string,
  factoryName?: string,
  ruleInsights: SmartInsight[] = [],
): Promise<SmartInsight[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  // 缓存检查：24小时内同一组合不重复分析
  const cacheKey = `insight_${customerName || ''}_${factoryName || ''}_${new Date().toISOString().slice(0, 10)}`;
  const { data: cached } = await (supabase.from('ai_knowledge_base') as any)
    .select('structured_data')
    .eq('source_id', cacheKey)
    .eq('category', 'ai_insight_cache')
    .maybeSingle();

  if (cached?.structured_data?.insights) {
    return cached.structured_data.insights as SmartInsight[];
  }

  // 收集历史数据摘要
  const summaryParts: string[] = [];

  if (customerName) {
    // 最近5单概况
    const { data: recentOrders } = await (supabase.from('orders') as any)
      .select('id, order_no, lifecycle_status, created_at, quantity')
      .eq('customer_name', customerName)
      .order('created_at', { ascending: false })
      .limit(5);

    if (recentOrders?.length > 0) {
      summaryParts.push(`【客户 ${customerName} 最近${recentOrders.length}单】`);
      const orderIds = recentOrders.map((o: any) => o.id);

      // 复盘数据
      const { data: retros } = await (supabase.from('order_retrospectives') as any)
        .select('key_issue, root_cause, what_worked, on_time_delivery')
        .in('order_id', orderIds);
      if (retros?.length > 0) {
        for (const r of retros) {
          summaryParts.push(`- 问题：${r.key_issue || '无'}，根因：${r.root_cause || '无'}，成功经验：${r.what_worked || '无'}，准时：${r.on_time_delivery ? '是' : '否'}`);
        }
      }

      // 延期记录
      const { data: delays } = await (supabase.from('delay_requests') as any)
        .select('reason_type, reason_detail')
        .in('order_id', orderIds)
        .limit(5);
      if (delays?.length > 0) {
        summaryParts.push(`延期记录：${delays.map((d: any) => `${d.reason_type}: ${d.reason_detail || ''}`).join('；')}`);
      }

      // 客户记忆
      const { data: memories } = await (supabase.from('customer_memory') as any)
        .select('content, category, risk_level')
        .eq('customer_id', customerName)
        .eq('risk_level', 'high')
        .limit(5);
      if (memories?.length > 0) {
        summaryParts.push(`高风险记忆：${memories.map((m: any) => m.content).join('；')}`);
      }
    }
  }

  if (factoryName) {
    const { data: fOrders } = await (supabase.from('orders') as any)
      .select('id').eq('factory_name', factoryName).limit(10);
    if (fOrders?.length > 0) {
      const fIds = fOrders.map((o: any) => o.id);
      summaryParts.push(`【工厂 ${factoryName}】`);

      // 不良率
      const { data: reports } = await (supabase.from('production_reports') as any)
        .select('qty_produced, qty_defect, issues')
        .in('order_id', fIds);
      if (reports?.length > 0) {
        const totalProd = reports.reduce((s: number, r: any) => s + (r.qty_produced || 0), 0);
        const totalDef = reports.reduce((s: number, r: any) => s + (r.qty_defect || 0), 0);
        summaryParts.push(`生产统计：总产量${totalProd}件，不良${totalDef}件（${totalProd > 0 ? ((totalDef / totalProd) * 100).toFixed(1) : 0}%）`);
        const issues = reports.map((r: any) => r.issues).filter(Boolean);
        if (issues.length > 0) summaryParts.push(`生产问题：${issues.slice(0, 3).join('；')}`);
      }

      // 阻塞
      const { data: blocks } = await (supabase.from('milestone_logs') as any)
        .select('note, step_key').in('order_id', fIds).eq('action', 'mark_blocked').limit(5);
      if (blocks?.length > 0) {
        summaryParts.push(`阻塞记录：${blocks.map((b: any) => `${b.step_key}: ${b.note || ''}`).join('；')}`);
      }
    }
  }

  // 数据不够不分析
  if (summaryParts.length < 2) return [];

  // 规则引擎结果作为参考
  const rulesSummary = ruleInsights.length > 0
    ? `\n已有规则分析结果：${ruleInsights.map(r => r.title).join('；')}`
    : '';

  // 调用 Claude
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    system: `你是服装外贸订单风险分析师。根据历史数据，分析出最关键的风险点和成功经验。
要求：
1. 找出数据中的复合模式（如"该客户+浅色面料=高退货风险"）
2. 给出具体可行的预防建议
3. 如果有成功经验也要提炼
4. 返回JSON数组，每个元素: {"title":"标题","detail":"分析详情","severity":"high/medium/low"}
5. 最多3条，每条detail不超过80字
6. 只返回JSON，不要其他内容`,
    messages: [{
      role: 'user',
      content: `${summaryParts.join('\n')}\n${rulesSummary}\n\n请分析风险和经验：`,
    }],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as Anthropic.TextBlock).text)
    .join('');

  let jsonStr = text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed: any[];
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const aiInsights: SmartInsight[] = parsed.slice(0, 3).map((item: any) => ({
    type: (customerName ? 'customer' : 'factory') as SmartInsight['type'],
    icon: '🤖',
    title: String(item.title || ''),
    detail: String(item.detail || ''),
    severity: (['high', 'medium', 'low'].includes(item.severity) ? item.severity : 'medium') as SmartInsight['severity'],
    source: 'AI 深度分析',
  }));

  // 写入缓存
  try {
    await (supabase.from('ai_knowledge_base') as any).insert({
      knowledge_type: 'process',
      category: 'ai_insight_cache',
      title: `AI洞察缓存: ${customerName || ''} / ${factoryName || ''}`,
      content: aiInsights.map(i => i.title).join('；'),
      structured_data: { insights: aiInsights },
      source_type: 'manual',
      source_id: cacheKey,
      confidence: 'high',
      impact_level: 'medium',
      is_actionable: true,
      status: 'active',
    });
  } catch {} // 缓存写入失败不影响结果

  return aiInsights;
}
