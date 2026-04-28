'use server';

import { createClient } from '@/lib/supabase/server';
import { callClaudeJSON } from '@/lib/agent/anthropicClient';
import { getCurrentUserRole } from '@/lib/utils/user-role';

interface OrderSummary {
  order_no: string;
  customer_name: string;
  order_type: string;
  quantity: number | null;
  factory_date: string | null;
  incoterm: string;
  created_at: string;
}

interface InsightResult {
  suggestion: string;
  generatedAt: string;
}

// Simple in-process cache (resets on cold start, good enough for CEO page)
let _cache: { result: InsightResult; expiresAt: number } | null = null;

export async function generateAcceptanceInsight(orders: OrderSummary[]): Promise<{
  suggestion?: string;
  error?: string;
  cached?: boolean;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '无权限' };

  const now = Date.now();
  if (_cache && _cache.expiresAt > now) {
    return { suggestion: _cache.result.suggestion, cached: true };
  }

  if (orders.length === 0) {
    return { suggestion: '当前无新订单，可主动联系客户开发新单。' };
  }

  const orderList = orders.map(o =>
    `- ${o.order_no} | ${o.customer_name} | ${o.order_type} | ${o.quantity ?? '?'}件 | 工厂交期:${o.factory_date ?? '未填'} | ${o.incoterm}`
  ).join('\n');

  const result = await callClaudeJSON<{ suggestion: string }>({
    scene: 'ceo-acceptance-insight',
    system: `你是一位服装外贸工厂的CEO助手，帮助CEO快速判断当前新订单的接单策略。
你的分析要从客户风险、工厂产能、原辅料、团队执行四个维度综合来看。
回答要简洁有力，控制在3-4句话，直接给出行动建议，不要废话。
输出 JSON: { "suggestion": "..." }`,
    prompt: `当前待启动新订单（共${orders.length}单）：\n${orderList}\n\n请给出接单策略建议。`,
    maxTokens: 200,
    cacheSystem: true,
  });

  const suggestion = result?.suggestion || '订单数据不足，建议人工逐单评估工厂产能和原料到位情况。';

  _cache = {
    result: { suggestion, generatedAt: new Date().toISOString() },
    expiresAt: now + 2 * 60 * 60 * 1000, // 2 hours
  };

  return { suggestion };
}
