/**
 * 邮件晨报服务（按需触发 + 缓存）
 *
 * 业务背景：
 *  把"今日邮件晨报"做进"我的节拍"，CEO/业务点击按需生成，
 *  一日一次缓存，避免 cron 全量调用的浪费。
 *
 * Token 经济学（Claude Sonnet）：
 *  - 首次生成：输入 ~10K + 输出 ~2K → 约 ¥0.30-0.50/次
 *  - 当日命中缓存：0 token
 *  - 强制刷新：同首次（前端弹确认告知用户成本）
 *
 * 使用：
 *   const result = await getOrGenerateBriefing(supabase, userId, { forceRefresh: false });
 */

import { aiGateway } from '@/lib/ai/aiGateway';
import type { ServiceResult } from './types';

// ── 类型 ──────────────────────────────────────────────────────

export interface BriefingSummary {
  /** AI 生成的核心摘要文本（2-4 段） */
  summaryText: string;
  /** 今日重点行动建议（3-5 条） */
  topActions: string[];
  /** 紧急事项（如客户投诉、严重延期） */
  urgentItems: string[];
  /** 数据快照 */
  stats: {
    newEmailsCount: number;
    activeOrdersCount: number;
    todayDueMilestones: number;
    overdueMilestones: number;
    pendingDelays: number;
  };
}

export interface BriefingRecord {
  id: string;
  userId: string;
  briefingDate: string; // YYYY-MM-DD
  content: BriefingSummary;
  summaryText: string;
  totalEmails: number;
  urgentCount: number;
  createdAt: string;
  /** 距离生成时间多少分钟（前端展示"X 小时前生成"） */
  ageMinutes: number;
}

export interface GenerateOptions {
  /** 是否强制刷新（即使今日已有缓存也重新生成） */
  forceRefresh?: boolean;
  /** 用户名（用于个性化提示） */
  userName?: string;
}

// ── 工具 ──────────────────────────────────────────────────────

function todayDateStr(): string {
  // 北京时间日期
  const offset = 8 * 60 * 60 * 1000;
  const bjNow = new Date(Date.now() + offset);
  return bjNow.toISOString().slice(0, 10);
}

function ageMinutesFrom(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
}

// ── 上下文采集 ────────────────────────────────────────────────

interface BriefingContext {
  myOrders: any[];
  newEmails: any[];
  todayDue: any[];
  overdue: any[];
  pendingDelays: any[];
  ownedRoles: string[];
}

async function collectContext(supabase: any, userId: string): Promise<BriefingContext> {
  // 24小时窗口
  const yesterdayIso = new Date(Date.now() - 86400000).toISOString();
  const todayStartIso = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const tomorrowIso = new Date(Date.now() + 86400000).toISOString();
  const todayDateOnly = new Date().toISOString().slice(0, 10);

  // 我负责的订单（只取活跃的）
  const { data: myOrders } = await (supabase.from('orders') as any)
    .select('id, order_no, customer_name, factory_date, etd, lifecycle_status')
    .eq('owner_user_id', userId)
    .in('lifecycle_status', ['active', '执行中', '已生效', 'running'])
    .limit(60);

  const orders = (myOrders || []) as any[];
  const orderIds = orders.map(o => o.id);
  const customers = [...new Set(orders.map(o => o.customer_name).filter(Boolean))];

  // 昨日新邮件（mail_inbox 表 — 如果不存在或失败，返回空数组）
  let newEmails: any[] = [];
  try {
    const { data } = await (supabase.from('mail_inbox') as any)
      .select('subject, from_email, received_at, customer_id, order_id')
      .gte('received_at', yesterdayIso)
      .not('from_email', 'ilike', '%@qimoclothing.com')
      .order('received_at', { ascending: false })
      .limit(30);
    if (data && customers.length > 0) {
      newEmails = (data as any[]).filter(e => customers.includes(e.customer_id));
    }
  } catch { /* mail_inbox 可能不存在，忽略 */ }

  // 今日到期节点
  let todayDue: any[] = [];
  if (orderIds.length > 0) {
    const { data } = await (supabase.from('milestones') as any)
      .select('id, name, due_at, status, order_id')
      .in('order_id', orderIds)
      .gte('due_at', todayStartIso)
      .lt('due_at', tomorrowIso)
      .not('status', 'in', '(done,已完成,completed)')
      .order('due_at', { ascending: true })
      .limit(20);
    todayDue = (data || []) as any[];
  }

  // 超期节点
  let overdue: any[] = [];
  if (orderIds.length > 0) {
    const { data } = await (supabase.from('milestones') as any)
      .select('id, name, due_at, status, order_id')
      .in('order_id', orderIds)
      .lt('due_at', todayStartIso)
      .not('status', 'in', '(done,已完成,completed)')
      .order('due_at', { ascending: true })
      .limit(20);
    overdue = (data || []) as any[];
  }

  // 待审批的延期申请（针对我的订单）
  let pendingDelays: any[] = [];
  if (orderIds.length > 0) {
    const { data } = await (supabase.from('delay_requests') as any)
      .select('id, order_id, reason, days_delay, created_at')
      .in('order_id', orderIds)
      .eq('status', 'pending')
      .limit(20);
    pendingDelays = (data || []) as any[];
  }

  return {
    myOrders: orders,
    newEmails,
    todayDue,
    overdue,
    pendingDelays,
    ownedRoles: [],
  };
}

// ── AI 提示词构建 ──────────────────────────────────────────────

function buildPrompt(ctx: BriefingContext, userName: string): { system: string; input: string } {
  const system = `你是外贸服装业务员 ${userName} 的资深 AI 助手（20 年外贸经验）。
基于昨日邮件 + 今日待办 + 风险信号，生成"早晨 5 分钟看完即上手"的工作简报。

输出严格 JSON（不要 markdown 包装）：
{
  "summaryText": "2-3 段中文，第一段总览今天最重要的事，第二段提示风险，第三段（可选）鼓励",
  "topActions": ["动作1（含订单号/客户）", "动作2", "动作3"],
  "urgentItems": ["紧急事项1", "紧急事项2"]
}

风格要求：
- 口语化，像真人助理对老板汇报，不要堆术语
- 必须带具体订单号/客户名/数字，禁止泛泛而谈
- topActions 必须可执行，不是"关注 XXX"这种空话
- 没有紧急事项就 urgentItems: []`;

  const input = `# 业务员：${userName}
# 日期：${todayDateStr()}（北京时间）

## 我的活跃订单（${ctx.myOrders.length} 个）
${ctx.myOrders.slice(0, 30).map(o =>
    `- ${o.order_no} / ${o.customer_name} / 出厂 ${o.factory_date || '?'} / ETD ${o.etd || '?'}`
  ).join('\n') || '无活跃订单'}

## 昨日新邮件（${ctx.newEmails.length} 封）
${ctx.newEmails.slice(0, 15).map(e =>
    `- ${e.from_email}: ${e.subject?.slice(0, 80) || '(无主题)'}`
  ).join('\n') || '无新邮件'}

## 今日到期节点（${ctx.todayDue.length} 个）
${ctx.todayDue.slice(0, 15).map(m => {
    const order = ctx.myOrders.find(o => o.id === m.order_id);
    return `- ${order?.order_no || '?'} / ${m.name} / ${order?.customer_name || '?'}`;
  }).join('\n') || '无'}

## 已超期节点（${ctx.overdue.length} 个）
${ctx.overdue.slice(0, 10).map(m => {
    const order = ctx.myOrders.find(o => o.id === m.order_id);
    const daysOver = Math.ceil((Date.now() - new Date(m.due_at).getTime()) / 86400000);
    return `- ${order?.order_no || '?'} / ${m.name} / 已超 ${daysOver} 天`;
  }).join('\n') || '无超期 ✓'}

## 待审批延期（${ctx.pendingDelays.length} 个）
${ctx.pendingDelays.slice(0, 5).map(d => {
    const order = ctx.myOrders.find(o => o.id === d.order_id);
    return `- ${order?.order_no || '?'} 申请 ${d.days_delay || '?'} 天：${d.reason?.slice(0, 50) || '?'}`;
  }).join('\n') || '无'}

请基于以上信息生成今日简报 JSON。`;

  return { system, input };
}

// ── 缓存读取 ──────────────────────────────────────────────────

/**
 * 读取今日缓存（不触发生成）
 */
export async function getTodayBriefing(
  supabase: any,
  userId: string,
): Promise<ServiceResult<BriefingRecord | null>> {
  const today = todayDateStr();
  const { data, error } = await (supabase.from('daily_briefings') as any)
    .select('id, user_id, briefing_date, content, summary_text, total_emails, urgent_count, created_at')
    .eq('user_id', userId)
    .eq('briefing_date', today)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: true, data: null };

  const record = data as any;
  return {
    ok: true,
    data: {
      id: record.id,
      userId: record.user_id,
      briefingDate: record.briefing_date,
      content: record.content as BriefingSummary,
      summaryText: record.summary_text || '',
      totalEmails: record.total_emails || 0,
      urgentCount: record.urgent_count || 0,
      createdAt: record.created_at,
      ageMinutes: ageMinutesFrom(record.created_at),
    },
  };
}

// ── 主入口：按需生成（含缓存检查） ─────────────────────────────

/**
 * 获取或生成今日晨报
 * - 默认：今日已有 → 返回缓存；今日没有 → 调 AI 生成
 * - forceRefresh=true：无视缓存，重新生成（覆盖今日记录）
 */
export async function getOrGenerateBriefing(
  supabase: any,
  userId: string,
  opts: GenerateOptions = {},
): Promise<ServiceResult<BriefingRecord>> {
  const today = todayDateStr();
  const userName = opts.userName || '同学';

  // 1. 非强制刷新 → 先查缓存
  if (!opts.forceRefresh) {
    const cached = await getTodayBriefing(supabase, userId);
    if (cached.ok && cached.data) {
      return { ok: true, data: cached.data };
    }
  }

  // 2. 收集上下文
  const ctx = await collectContext(supabase, userId);

  // 3. 调 AI Gateway
  const { system, input } = buildPrompt(ctx, userName);

  const aiResult = await aiGateway.run<BriefingSummary>({
    task: 'morning_briefing',
    system,
    input,
    timeoutMs: 45_000,
    maxTokens: 1500,
    cacheKey: `briefing:${userId}:${today}`,
    fallback: null,
  });

  // 4. 兜底：AI 失败也要给用户一份基础简报（基于纯数据）
  let summary: BriefingSummary;
  if (aiResult.ok && aiResult.data) {
    summary = {
      summaryText: aiResult.data.summaryText || '今日 AI 摘要生成失败，已展示原始数据。',
      topActions: aiResult.data.topActions || [],
      urgentItems: aiResult.data.urgentItems || [],
      stats: {
        newEmailsCount: ctx.newEmails.length,
        activeOrdersCount: ctx.myOrders.length,
        todayDueMilestones: ctx.todayDue.length,
        overdueMilestones: ctx.overdue.length,
        pendingDelays: ctx.pendingDelays.length,
      },
    };
  } else {
    // AI 失败兜底
    summary = {
      summaryText: `${userName}，今日 AI 摘要服务暂时不可用（${aiResult.reason || '未知原因'}），但你的工作数据已准备好。`,
      topActions: ctx.todayDue.slice(0, 3).map(m => {
        const order = ctx.myOrders.find(o => o.id === m.order_id);
        return `推进 ${order?.order_no || '?'} 的「${m.name}」节点（今日到期）`;
      }),
      urgentItems: ctx.overdue.slice(0, 3).map(m => {
        const order = ctx.myOrders.find(o => o.id === m.order_id);
        const daysOver = Math.ceil((Date.now() - new Date(m.due_at).getTime()) / 86400000);
        return `${order?.order_no || '?'} 「${m.name}」已超期 ${daysOver} 天`;
      }),
      stats: {
        newEmailsCount: ctx.newEmails.length,
        activeOrdersCount: ctx.myOrders.length,
        todayDueMilestones: ctx.todayDue.length,
        overdueMilestones: ctx.overdue.length,
        pendingDelays: ctx.pendingDelays.length,
      },
    };
  }

  // 5. 写入 daily_briefings（UPSERT by user_id+briefing_date）
  const summaryText = summary.summaryText.slice(0, 1000);

  const { data: saved, error: saveErr } = await (supabase.from('daily_briefings') as any)
    .upsert({
      user_id: userId,
      briefing_date: today,
      content: summary,
      summary_text: summaryText,
      total_emails: ctx.newEmails.length,
      urgent_count: summary.urgentItems.length,
    }, { onConflict: 'user_id,briefing_date' })
    .select('id, created_at')
    .single();

  if (saveErr || !saved) {
    return { ok: false, error: `晨报写入失败：${saveErr?.message || '未知'}` };
  }

  return {
    ok: true,
    data: {
      id: (saved as any).id,
      userId,
      briefingDate: today,
      content: summary,
      summaryText,
      totalEmails: ctx.newEmails.length,
      urgentCount: summary.urgentItems.length,
      createdAt: (saved as any).created_at,
      ageMinutes: 0,
    },
  };
}
