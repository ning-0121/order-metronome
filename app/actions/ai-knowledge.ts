'use server';

import { createClient } from '@/lib/supabase/server';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import type { KnowledgeType, KnowledgeSource, KnowledgeEntry, KnowledgeStats, CompanyProfile, CollectionLog } from '@/lib/domain/ai-knowledge';

// ══════════════════════════════════════════════
// 数据采集管道：6 个采集器 + 统一入库
// ══════════════════════════════════════════════

interface CollectResult {
  source: KnowledgeSource;
  scanned: number;
  ingested: number;
  skipped: number;
  error?: string;
}

/**
 * 获取公司画像（用于给知识打标签）
 */
async function getCompanyTags(supabase: any): Promise<{ industry: string; scale: string; markets: string[] }> {
  const { data } = await (supabase.from('company_profile') as any).select('industry, company_scale, main_markets').limit(1).single();
  return {
    industry: data?.industry ?? 'apparel',
    scale: data?.company_scale ?? 'small',
    markets: data?.main_markets ?? [],
  };
}

/**
 * 统一入库：去重后插入知识条目
 */
async function ingestEntries(
  supabase: any,
  entries: Array<{
    knowledge_type: KnowledgeType;
    category: string;
    subcategory?: string;
    title: string;
    content: string;
    structured_data?: Record<string, unknown>;
    source_type: KnowledgeSource;
    source_id?: string;
    source_table?: string;
    customer_name?: string;
    factory_name?: string;
    order_id?: string;
    employee_role?: string;
    confidence?: string;
    impact_level?: string;
    is_actionable?: boolean;
  }>,
  tags: { industry: string; scale: string; markets: string[] },
  userId: string,
): Promise<number> {
  if (entries.length === 0) return 0;

  // 查询已存在的 source_id，避免重复
  const sourceIds = entries.map(e => e.source_id).filter(Boolean);
  const existingIds = new Set<string>();
  if (sourceIds.length > 0) {
    const { data: existing } = await (supabase.from('ai_knowledge_base') as any)
      .select('source_id')
      .in('source_id', sourceIds);
    (existing || []).forEach((e: any) => existingIds.add(e.source_id));
  }

  const newEntries = entries
    .filter(e => !e.source_id || !existingIds.has(e.source_id))
    .map(e => ({
      knowledge_type: e.knowledge_type,
      category: e.category,
      subcategory: e.subcategory ?? null,
      title: e.title,
      content: e.content,
      structured_data: e.structured_data ?? {},
      source_type: e.source_type,
      source_id: e.source_id ?? null,
      source_table: e.source_table ?? null,
      customer_name: e.customer_name ?? null,
      factory_name: e.factory_name ?? null,
      order_id: e.order_id ?? null,
      employee_role: e.employee_role ?? null,
      industry_tag: tags.industry,
      scale_tag: tags.scale,
      market_tags: tags.markets,
      confidence: e.confidence ?? 'medium',
      impact_level: e.impact_level ?? 'medium',
      is_actionable: e.is_actionable ?? true,
      created_by: userId,
    }));

  if (newEntries.length === 0) return 0;

  const { error } = await (supabase.from('ai_knowledge_base') as any).insert(newEntries);
  if (error) throw new Error(`入库失败: ${error.message}`);
  return newEntries.length;
}

// ──────────────────────────────────────────────
// 采集器 1：订单复盘 → 流程优化 + 客户智能
// ──────────────────────────────────────────────
async function collectFromRetrospectives(supabase: any, tags: any, userId: string): Promise<CollectResult> {
  const { data: retros } = await (supabase.from('order_retrospectives') as any)
    .select('id, order_id, on_time_delivery, major_delay_reason, key_issue, root_cause, what_worked, improvement_actions, blocked_count, delay_request_count, created_at');

  if (!retros || retros.length === 0) return { source: 'retrospective', scanned: 0, ingested: 0, skipped: 0 };

  // 拿订单信息做关联
  const orderIds = retros.map((r: any) => r.order_id).filter(Boolean);
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, customer_name, factory_name')
    .in('id', orderIds);
  const orderMap = new Map((orders || []).map((o: any) => [o.id, o]));

  const entries: any[] = [];
  for (const r of retros) {
    const order = orderMap.get(r.order_id) || {} as any;

    if (r.key_issue) {
      entries.push({
        knowledge_type: 'process',
        category: r.on_time_delivery ? 'best_practice' : 'lesson_learned',
        title: r.on_time_delivery === false ? `延期教训：${r.key_issue.slice(0, 50)}` : `经验总结：${r.key_issue.slice(0, 50)}`,
        content: [r.key_issue, r.root_cause ? `根因：${r.root_cause}` : '', r.what_worked ? `亮点：${r.what_worked}` : ''].filter(Boolean).join('\n'),
        structured_data: { on_time: r.on_time_delivery, blocked_count: r.blocked_count, delay_count: r.delay_request_count, improvements: r.improvement_actions },
        source_type: 'retrospective' as KnowledgeSource,
        source_id: r.id,
        source_table: 'order_retrospectives',
        customer_name: order.customer_name,
        factory_name: order.factory_name,
        order_id: r.order_id,
        confidence: r.root_cause ? 'high' : 'medium',
        impact_level: r.on_time_delivery === false ? 'high' : 'medium',
      });
    }

    // 客户维度：如果延期，归到客户智能
    if (r.on_time_delivery === false && r.major_delay_reason && order.customer_name) {
      entries.push({
        knowledge_type: 'customer',
        category: 'delivery_risk',
        title: `${order.customer_name} 延期原因：${r.major_delay_reason.slice(0, 40)}`,
        content: r.major_delay_reason,
        source_type: 'retrospective' as KnowledgeSource,
        source_id: `${r.id}_customer`,
        source_table: 'order_retrospectives',
        customer_name: order.customer_name,
        order_id: r.order_id,
        impact_level: 'high',
      });
    }
  }

  const ingested = await ingestEntries(supabase, entries, tags, userId);
  return { source: 'retrospective', scanned: retros.length, ingested, skipped: entries.length - ingested };
}

// ──────────────────────────────────────────────
// 采集器 2：客户记忆 → 客户智能
// ──────────────────────────────────────────────
async function collectFromCustomerMemory(supabase: any, tags: any, userId: string): Promise<CollectResult> {
  const { data: memories } = await (supabase.from('customer_memory') as any)
    .select('id, customer_id, content, category, risk_level, source_type, order_id');

  if (!memories || memories.length === 0) return { source: 'customer_memory', scanned: 0, ingested: 0, skipped: 0 };

  const entries = memories.map((m: any) => ({
    knowledge_type: 'customer' as KnowledgeType,
    category: m.category || 'general',
    title: `${m.customer_id}：${m.content.slice(0, 50)}`,
    content: m.content,
    structured_data: { risk_level: m.risk_level, original_source: m.source_type },
    source_type: 'customer_memory' as KnowledgeSource,
    source_id: m.id,
    source_table: 'customer_memory',
    customer_name: m.customer_id,
    order_id: m.order_id,
    confidence: m.risk_level === 'high' ? 'high' : 'medium',
    impact_level: m.risk_level || 'medium',
  }));

  const ingested = await ingestEntries(supabase, entries, tags, userId);
  return { source: 'customer_memory', scanned: memories.length, ingested, skipped: entries.length - ingested };
}

// ──────────────────────────────────────────────
// 采集器 3：关卡阻塞日志 → 流程优化 + 员工效率
// ──────────────────────────────────────────────
async function collectFromMilestoneLogs(supabase: any, tags: any, userId: string): Promise<CollectResult> {
  const { data: logs } = await (supabase.from('milestone_logs') as any)
    .select('id, milestone_id, order_id, action, note, created_at')
    .in('action', ['mark_blocked', 'mark_done'])
    .not('note', 'is', null)
    .limit(500);

  if (!logs || logs.length === 0) return { source: 'milestone_log', scanned: 0, ingested: 0, skipped: 0 };

  // 拿关卡和订单信息
  const milestoneIds = [...new Set(logs.map((l: any) => l.milestone_id))];
  const { data: milestones } = await (supabase.from('milestones') as any)
    .select('id, step_key, name, owner_role')
    .in('id', milestoneIds);
  const msMap = new Map((milestones || []).map((m: any) => [m.id, m]));

  const orderIds = [...new Set(logs.map((l: any) => l.order_id))];
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, customer_name, factory_name')
    .in('id', orderIds);
  const orderMap = new Map((orders || []).map((o: any) => [o.id, o]));

  const entries: any[] = [];
  for (const log of logs) {
    const ms: any = msMap.get(log.milestone_id);
    const order: any = orderMap.get(log.order_id) || {};
    if (!ms || !log.note || log.note.length < 5) continue;

    if (log.action === 'mark_blocked') {
      entries.push({
        knowledge_type: 'process' as KnowledgeType,
        category: 'bottleneck',
        title: `${ms.name} 阻塞：${log.note.slice(0, 50)}`,
        content: log.note,
        structured_data: { step_key: ms.step_key, milestone_name: ms.name },
        source_type: 'milestone_log' as KnowledgeSource,
        source_id: log.id,
        source_table: 'milestone_logs',
        customer_name: order.customer_name,
        factory_name: order.factory_name,
        order_id: log.order_id,
        employee_role: ms.owner_role,
        impact_level: 'high',
      });
    }
  }

  const ingested = await ingestEntries(supabase, entries, tags, userId);
  return { source: 'milestone_log', scanned: logs.length, ingested, skipped: entries.length - ingested };
}

// ──────────────────────────────────────────────
// 采集器 4：延期申请 → 客户智能 + 流程优化
// ──────────────────────────────────────────────
async function collectFromDelayRequests(supabase: any, tags: any, userId: string): Promise<CollectResult> {
  const { data: delays } = await (supabase.from('delay_requests') as any)
    .select('id, order_id, reason_type, reason_detail, created_at');

  if (!delays || delays.length === 0) return { source: 'delay_request', scanned: 0, ingested: 0, skipped: 0 };

  const orderIds = [...new Set(delays.map((d: any) => d.order_id))];
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, customer_name, factory_name')
    .in('id', orderIds);
  const orderMap = new Map((orders || []).map((o: any) => [o.id, o]));

  const reasonLabels: Record<string, string> = {
    customer_confirmation: '客户确认延迟', supplier_delay: '供应商延迟',
    internal_delay: '内部延迟', logistics: '物流延迟', other: '其他',
  };

  const entries = delays.filter((d: any) => d.reason_detail).map((d: any) => {
    const order = orderMap.get(d.order_id) || {} as any;
    return {
      knowledge_type: (d.reason_type === 'supplier_delay' ? 'factory' : d.reason_type === 'customer_confirmation' ? 'customer' : 'process') as KnowledgeType,
      category: 'delay_pattern',
      title: `延期（${reasonLabels[d.reason_type] || d.reason_type}）：${(d.reason_detail || '').slice(0, 50)}`,
      content: d.reason_detail,
      structured_data: { reason_type: d.reason_type },
      source_type: 'delay_request' as KnowledgeSource,
      source_id: d.id,
      source_table: 'delay_requests',
      customer_name: (order as any).customer_name,
      factory_name: (order as any).factory_name,
      order_id: d.order_id,
      impact_level: 'high',
    };
  });

  const ingested = await ingestEntries(supabase, entries, tags, userId);
  return { source: 'delay_request', scanned: delays.length, ingested, skipped: entries.length - ingested };
}

// ──────────────────────────────────────────────
// 采集器 5：生产日报 → 工厂智能
// ──────────────────────────────────────────────
async function collectFromProductionReports(supabase: any, tags: any, userId: string): Promise<CollectResult> {
  // 按订单聚合生产数据
  const { data: reports } = await (supabase.from('production_reports') as any)
    .select('id, order_id, qty_produced, qty_defect, defect_rate, issues, efficiency_rate');

  if (!reports || reports.length === 0) return { source: 'production_report', scanned: 0, ingested: 0, skipped: 0 };

  const orderIds = [...new Set(reports.map((r: any) => r.order_id))];
  const { data: orders } = await (supabase.from('orders') as any)
    .select('id, customer_name, factory_name')
    .in('id', orderIds);
  const orderMap = new Map((orders || []).map((o: any) => [o.id, o]));

  const entries: any[] = [];

  // 按订单聚合：找出有问题的生产记录
  const byOrder = new Map<string, any[]>();
  for (const r of reports) {
    const arr = byOrder.get(r.order_id) || [];
    arr.push(r);
    byOrder.set(r.order_id, arr);
  }

  for (const [orderId, recs] of byOrder) {
    const order = orderMap.get(orderId) || {} as any;
    const totalProduced = recs.reduce((s: number, r: any) => s + (r.qty_produced || 0), 0);
    const totalDefect = recs.reduce((s: number, r: any) => s + (r.qty_defect || 0), 0);
    const avgDefectRate = totalProduced > 0 ? Math.round((totalDefect / totalProduced) * 1000) / 10 : 0;
    const issues = recs.map((r: any) => r.issues).filter(Boolean);

    if (avgDefectRate > 2 || issues.length > 0) {
      entries.push({
        knowledge_type: 'factory' as KnowledgeType,
        category: avgDefectRate > 5 ? 'quality_high_risk' : 'quality_monitor',
        title: `${(order as any).factory_name || '未知工厂'} 不良率 ${avgDefectRate}%（${totalDefect}/${totalProduced}）`,
        content: issues.length > 0 ? `生产问题：${issues.join('；')}` : `累计不良率 ${avgDefectRate}%`,
        structured_data: { total_produced: totalProduced, total_defect: totalDefect, defect_rate: avgDefectRate, report_count: recs.length },
        source_type: 'production_report' as KnowledgeSource,
        source_id: `prod_agg_${orderId}`,
        source_table: 'production_reports',
        factory_name: (order as any).factory_name,
        customer_name: (order as any).customer_name,
        order_id: orderId,
        confidence: recs.length >= 3 ? 'high' : 'medium',
        impact_level: avgDefectRate > 5 ? 'high' : 'medium',
      });
    }
  }

  const ingested = await ingestEntries(supabase, entries, tags, userId);
  return { source: 'production_report', scanned: reports.length, ingested, skipped: entries.length - ingested };
}

// ──────────────────────────────────────────────
// 采集器 6：员工备忘录 → 员工效率 + 流程优化
// ──────────────────────────────────────────────
async function collectFromMemos(supabase: any, tags: any, userId: string): Promise<CollectResult> {
  const { data: memos } = await (supabase.from('user_memos') as any)
    .select('id, content, user_id, order_id, is_done, created_at')
    .not('content', 'is', null);

  if (!memos || memos.length === 0) return { source: 'memo', scanned: 0, ingested: 0, skipped: 0 };

  // 只采集有实质内容的备忘录（>20字符）
  const meaningful = memos.filter((m: any) => m.content && m.content.length > 20);

  const entries = meaningful.map((m: any) => ({
    knowledge_type: 'employee' as KnowledgeType,
    category: m.is_done ? 'completed_task' : 'open_task',
    title: `员工备忘：${m.content.slice(0, 50)}`,
    content: m.content,
    structured_data: { is_done: m.is_done },
    source_type: 'memo' as KnowledgeSource,
    source_id: m.id,
    source_table: 'user_memos',
    order_id: m.order_id,
    confidence: 'low',
    impact_level: 'low',
    is_actionable: !m.is_done,
  }));

  const ingested = await ingestEntries(supabase, entries, tags, userId);
  return { source: 'memo', scanned: memos.length, ingested, skipped: entries.length - ingested };
}

// ══════════════════════════════════════════════
// 公开 API
// ══════════════════════════════════════════════

/**
 * 运行全量数据采集管道（管理员）
 */
export async function runCollectionPipeline(): Promise<{ data?: CollectResult[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可运行数据采集' };

  const tags = await getCompanyTags(supabase);
  const startTime = Date.now();
  const results: CollectResult[] = [];

  const collectors = [
    collectFromRetrospectives,
    collectFromCustomerMemory,
    collectFromMilestoneLogs,
    collectFromDelayRequests,
    collectFromProductionReports,
    collectFromMemos,
  ];

  for (const collector of collectors) {
    try {
      const result = await collector(supabase, tags, user.id);
      results.push(result);

      // 记录采集日志
      await (supabase.from('ai_collection_log') as any).insert({
        triggered_by: user.id,
        source_type: result.source,
        records_scanned: result.scanned,
        records_ingested: result.ingested,
        records_skipped: result.skipped,
        duration_ms: Date.now() - startTime,
      });
    } catch (err: any) {
      results.push({ source: collector.name.replace('collectFrom', '').toLowerCase() as KnowledgeSource, scanned: 0, ingested: 0, skipped: 0, error: err.message });
    }
  }

  return { data: results };
}

/**
 * 获取知识库统计概览
 */
export async function getKnowledgeStats(): Promise<{ data?: KnowledgeStats; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  // 总数
  const { count: total } = await (supabase.from('ai_knowledge_base') as any)
    .select('*', { count: 'exact', head: true })
    .eq('status', 'active');

  // 按类型统计
  const { data: allEntries } = await (supabase.from('ai_knowledge_base') as any)
    .select('knowledge_type, source_type, industry_tag')
    .eq('status', 'active');

  const byType: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byIndustry: Record<string, number> = {};
  for (const e of allEntries || []) {
    byType[e.knowledge_type] = (byType[e.knowledge_type] || 0) + 1;
    bySource[e.source_type] = (bySource[e.source_type] || 0) + 1;
    byIndustry[e.industry_tag] = (byIndustry[e.industry_tag] || 0) + 1;
  }

  // 最新条目
  const { data: recentEntries } = await (supabase.from('ai_knowledge_base') as any)
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(20);

  // 最近采集日志
  const { data: lastRuns } = await (supabase.from('ai_collection_log') as any)
    .select('*')
    .order('run_at', { ascending: false })
    .limit(10);

  return {
    data: {
      total: total || 0,
      byType,
      bySource,
      byIndustry,
      recentEntries: recentEntries || [],
      lastCollectionRuns: lastRuns || [],
    },
  };
}

/**
 * 搜索知识库
 */
export async function searchKnowledge(params: {
  knowledgeType?: string;
  sourceType?: string;
  customerName?: string;
  factoryName?: string;
  keyword?: string;
  limit?: number;
}): Promise<{ data?: KnowledgeEntry[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  let query = (supabase.from('ai_knowledge_base') as any)
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(params.limit || 50);

  if (params.knowledgeType) query = query.eq('knowledge_type', params.knowledgeType);
  if (params.sourceType) query = query.eq('source_type', params.sourceType);
  if (params.customerName) query = query.eq('customer_name', params.customerName);
  if (params.factoryName) query = query.eq('factory_name', params.factoryName);
  if (params.keyword) query = query.or(`title.ilike.%${params.keyword}%,content.ilike.%${params.keyword}%`);

  const { data, error } = await query;
  if (error) return { error: error.message };
  return { data: data || [] };
}

/**
 * 获取公司画像
 */
export async function getCompanyProfile(): Promise<{ data?: CompanyProfile; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { data, error } = await (supabase.from('company_profile') as any).select('*').limit(1).single();
  if (error) return { error: error.message };
  return { data };
}

/**
 * 更新公司画像
 */
export async function updateCompanyProfile(profile: Partial<CompanyProfile>): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) return { error: '仅管理员可修改公司画像' };

  const { data: existing } = await (supabase.from('company_profile') as any).select('id').limit(1).single();

  if (existing) {
    const { error } = await (supabase.from('company_profile') as any)
      .update({ ...profile, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) return { error: error.message };
  } else {
    const { error } = await (supabase.from('company_profile') as any).insert(profile);
    if (error) return { error: error.message };
  }

  return {};
}

/**
 * 手动添加知识条目
 */
export async function addManualKnowledge(entry: {
  knowledge_type: KnowledgeType;
  category: string;
  title: string;
  content: string;
  customer_name?: string;
  factory_name?: string;
  impact_level?: string;
}): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '未登录' };

  const tags = await getCompanyTags(supabase);

  const { error } = await (supabase.from('ai_knowledge_base') as any).insert({
    knowledge_type: entry.knowledge_type,
    category: entry.category,
    title: entry.title,
    content: entry.content,
    source_type: 'manual',
    customer_name: entry.customer_name ?? null,
    factory_name: entry.factory_name ?? null,
    industry_tag: tags.industry,
    scale_tag: tags.scale,
    market_tags: tags.markets,
    confidence: 'high',
    impact_level: entry.impact_level ?? 'medium',
    is_actionable: true,
    created_by: user.id,
  });

  if (error) return { error: error.message };
  return {};
}
