// ============================================================
// Customer Matters Service — CEO 客户事项分级（Phase 1）
// 职责：纯规则物化（零 AI 调用）：
//   信号A：疑似投诉/质量邮件 — mail_inbox 关键词 × customer_email_domains 域名归类
//   信号B：交期/订单风险 — runtime_orders 置信度 + 关键节点逾期
// 模式：dry_run（只算不写，供人审关键词误报）/ execute（upsert + 清理过期行）
// 红线：不发通知、不写 daily_tasks、不碰 customer_memory（缺表，独立 P0）。
// 调用方负责传入 service-role client（RLS 对 customer_matters 无 authenticated 写策略）。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { ok, err, type ServiceResult } from './types'
import { CRITICAL_STEP_KEYS } from '@/lib/runtime/criticalNodes'

// ── 关键词分级（CEO 拍板 2026-06-11：strong→high / weak→medium，不全 high）──
const STRONG_KEYWORDS = ['complaint', 'defect', 'reject', '不良', '缺陷', '返工']
const WEAK_KEYWORDS = ['issue', 'problem', 'wrong', '问题', '不对', '错误']

const EMAIL_LOOKBACK_DAYS = 30
const PER_CUSTOMER_EMAIL_CAP = 5 // 每客户疑似投诉上限，防单一客户刷屏

export interface CustomerMatterDraft {
  customer_name: string
  order_id: string | null
  order_no: string | null
  matter_type: 'suspected_complaint' | 'delivery_risk' | 'overdue_summary'
  severity: 'high' | 'medium'
  title: string
  evidence: Record<string, unknown>
  source: 'email' | 'order'
  source_ref: string
  matter_key: string
  detected_at: string
}

export interface MaterializeStats {
  customers: number
  total: number
  suspected_complaint: { high: number; medium: number }
  delivery_risk: { high: number; medium: number }
  overdue_summary: { high: number; medium: number }
  emails_scanned: number
  emails_matched_customer: number
  written?: number
  deleted?: number
}

const TERMINAL_LIFECYCLE = new Set(['completed', '已完成', 'cancelled', '已取消'])

/** 去掉 Re:/Fwd:/回复:/转发: 前缀后的主题，用于同主题串去重 */
function normalizeSubject(subject: string): string {
  return (subject || '')
    .replace(/^(\s*(re|fwd|fw|回复|转发|答复)\s*[:：]\s*)+/i, '')
    .trim()
    .toLowerCase()
}

function matchKeywords(text: string): { matched: string[]; severity: 'high' | 'medium' } | null {
  const lower = text.toLowerCase()
  const strong = STRONG_KEYWORDS.filter(k => lower.includes(k.toLowerCase()))
  const weak = WEAK_KEYWORDS.filter(k => lower.includes(k.toLowerCase()))
  if (strong.length === 0 && weak.length === 0) return null
  return { matched: [...strong, ...weak], severity: strong.length > 0 ? 'high' : 'medium' }
}

export async function materializeCustomerMatters(
  supabase: SupabaseClient,
  opts: { mode: 'dry_run' | 'execute' },
): Promise<ServiceResult<{ stats: MaterializeStats; matters: CustomerMatterDraft[] }>> {
  try {
    const nowMs = Date.now()
    const matters: CustomerMatterDraft[] = []

    // ════════ 信号A：疑似投诉/质量邮件 ════════
    // A1. 域名 → 客户 映射（教训：显式接 error，不吞）
    const { data: domains, error: domErr } = await (supabase.from('customer_email_domains') as any)
      .select('customer_name, email_domain')
    if (domErr) return err(`读取 customer_email_domains 失败: ${domErr.message}`)
    const domainMap = new Map<string, string>()
    for (const d of domains || []) {
      if (d.email_domain) domainMap.set(String(d.email_domain).toLowerCase(), d.customer_name)
    }

    // A2. 近 30 天邮件
    const sinceIso = new Date(nowMs - EMAIL_LOOKBACK_DAYS * 86400000).toISOString()
    const { data: emails, error: mailErr } = await (supabase.from('mail_inbox') as any)
      .select('id, from_email, subject, raw_body, received_at, extracted_po')
      .gte('received_at', sinceIso)
      .order('received_at', { ascending: false })
    if (mailErr) return err(`读取 mail_inbox 失败: ${mailErr.message}`)

    const emailsScanned = (emails || []).length
    let emailsMatchedCustomer = 0

    // A3. 归类 + 关键词 + 去重（同客户同规范化主题取最新一封）
    type EmailHit = {
      id: string; customer: string; domain: string; subject: string
      receivedAt: string; matched: string[]; severity: 'high' | 'medium'; extractedPo: string | null
    }
    const dedup = new Map<string, EmailHit>() // key: customer|normSubject（emails 已按时间倒序，首见即最新）
    for (const m of emails || []) {
      const domain = String(m.from_email || '').split('@')[1]?.toLowerCase()
      if (!domain) continue
      const customer = domainMap.get(domain)
      if (!customer) continue // 只统计已知客户域名 → 天然排除垃圾/内部邮件
      emailsMatchedCustomer++

      const text = `${m.subject || ''} ${String(m.raw_body || '').slice(0, 2000)}`
      const hit = matchKeywords(text)
      if (!hit) continue

      const key = `${customer}|${normalizeSubject(m.subject || '')}`
      if (dedup.has(key)) continue
      dedup.set(key, {
        id: m.id, customer, domain, subject: m.subject || '(无主题)',
        receivedAt: m.received_at, matched: hit.matched, severity: hit.severity,
        extractedPo: m.extracted_po || null,
      })
    }

    // A4. extracted_po → 订单（可选关联，批量一次查询）
    const pos = [...new Set([...dedup.values()].map(h => h.extractedPo).filter(Boolean))] as string[]
    const poOrderMap = new Map<string, { id: string; order_no: string }>()
    if (pos.length > 0) {
      const { data: poOrders, error: poErr } = await (supabase.from('orders') as any)
        .select('id, order_no, po_number')
        .in('po_number', pos)
      if (poErr) return err(`按 PO 关联订单失败: ${poErr.message}`)
      for (const o of poOrders || []) if (o.po_number) poOrderMap.set(o.po_number, o)
    }

    // A5. 每客户上限 + 组装（high 优先保留，再按时间新旧）
    const byCustomer = new Map<string, EmailHit[]>()
    for (const h of dedup.values()) {
      const list = byCustomer.get(h.customer) || []
      list.push(h)
      byCustomer.set(h.customer, list)
    }
    for (const [, hits] of byCustomer) {
      hits.sort((a, b) =>
        a.severity === b.severity
          ? b.receivedAt.localeCompare(a.receivedAt)
          : a.severity === 'high' ? -1 : 1)
      for (const h of hits.slice(0, PER_CUSTOMER_EMAIL_CAP)) {
        const linked = h.extractedPo ? poOrderMap.get(h.extractedPo) : undefined
        matters.push({
          customer_name: h.customer,
          order_id: linked?.id ?? null,
          order_no: linked?.order_no ?? null,
          matter_type: 'suspected_complaint',
          severity: h.severity,
          title: `疑似投诉/质量邮件：${h.subject}`.slice(0, 200),
          evidence: {
            subject: h.subject,
            from_domain: h.domain,
            received_at: h.receivedAt,
            matched_keywords: h.matched,
            customer_match_source: `email_domain:${h.domain}`,
          },
          source: 'email',
          source_ref: `email:${h.id}`,
          matter_key: `email:${h.id}`,
          detected_at: h.receivedAt,
        })
      }
    }

    // ════════ 信号B：交期/订单风险 ════════
    // B1. 交付置信度 red/orange（join orders 拿单号/客户/生命周期）
    const { data: riskRows, error: riskErr } = await (supabase.from('runtime_orders') as any)
      .select('order_id, delivery_confidence, risk_level, last_recomputed_at, explain_json, orders(order_no, customer_name, lifecycle_status)')
      .in('risk_level', ['red', 'orange'])
    if (riskErr) return err(`读取 runtime_orders 失败: ${riskErr.message}`)
    for (const r of riskRows || []) {
      const o = r.orders
      if (!o?.customer_name || TERMINAL_LIFECYCLE.has(o.lifecycle_status || '')) continue
      const severity: 'high' | 'medium' = r.risk_level === 'red' ? 'high' : 'medium'
      matters.push({
        customer_name: o.customer_name,
        order_id: r.order_id,
        order_no: o.order_no || null,
        matter_type: 'delivery_risk',
        severity,
        title: `交付置信度 ${r.risk_level}（${r.delivery_confidence ?? '?'}%）`,
        evidence: {
          delivery_confidence: r.delivery_confidence,
          risk_level: r.risk_level,
          headline: r.explain_json?.headline ?? null,
          last_recomputed_at: r.last_recomputed_at,
        },
        source: 'order',
        source_ref: `order:${r.order_id}:confidence`,
        matter_key: `order:${r.order_id}:confidence`,
        detected_at: r.last_recomputed_at || new Date(nowMs).toISOString(),
      })
    }

    // B2. 关键节点逾期 → 客户级聚合（overdue_summary，每客户最多一条）
    // 粒度教训（2026-06-11 dry_run）：节点级 Matter 313 条直接淹没 CEO 看板，
    // 改为按客户聚合，明细进 evidence（top_steps/top_orders），CEO 看汇总、点订单下钻。
    const { data: overdueRows, error: odErr } = await (supabase.from('milestones') as any)
      .select('id, order_id, step_key, name, due_at, actual_at, orders(order_no, customer_name, lifecycle_status)')
      .is('actual_at', null)
      .lt('due_at', new Date(nowMs).toISOString())
      .in('step_key', [...CRITICAL_STEP_KEYS])
    if (odErr) return err(`读取逾期 milestones 失败: ${odErr.message}`)

    type OverdueNode = {
      orderId: string; orderNo: string | null
      stepKey: string; stepName: string; dueAt: string; overdueDays: number
    }
    const nodesByCustomer = new Map<string, OverdueNode[]>()
    for (const m of overdueRows || []) {
      const o = m.orders
      if (!o?.customer_name || TERMINAL_LIFECYCLE.has(o.lifecycle_status || '')) continue
      const overdueDays = Math.floor((nowMs - new Date(m.due_at).getTime()) / 86400000)
      if (overdueDays < 3) continue // 轻于 3 天不计入
      const list = nodesByCustomer.get(o.customer_name) || []
      list.push({
        orderId: m.order_id, orderNo: o.order_no || null,
        stepKey: m.step_key, stepName: m.name || m.step_key,
        dueAt: m.due_at, overdueDays,
      })
      nodesByCustomer.set(o.customer_name, list)
    }

    for (const [customer, nodes] of nodesByCustomer) {
      const overdueCount = nodes.length
      const overdueOrderCount = new Set(nodes.map(n => n.orderId)).size
      const maxOverdueDays = Math.max(...nodes.map(n => n.overdueDays))
      const highOverdueCount = nodes.filter(n => n.overdueDays >= 15).length
      const mediumOverdueCount = nodes.filter(n => n.overdueDays >= 3 && n.overdueDays <= 14).length

      let severity: 'high' | 'medium' | null = null
      if (maxOverdueDays >= 15 || overdueCount >= 10 || overdueOrderCount >= 5) severity = 'high'
      else if (maxOverdueDays >= 3 || overdueCount >= 3) severity = 'medium'
      if (!severity) continue

      // Top 5 节点类型（按 step_name 计数）
      const stepCounts = new Map<string, number>()
      for (const n of nodes) stepCounts.set(n.stepName, (stepCounts.get(n.stepName) || 0) + 1)
      const topSteps = [...stepCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([step_name, count]) => ({ step_name, count }))

      // Top 5 订单（按订单聚合，最长超期优先）
      const orderAgg = new Map<string, { order_id: string; order_no: string | null; max_overdue_days: number; overdue_count: number }>()
      for (const n of nodes) {
        const agg = orderAgg.get(n.orderId) || { order_id: n.orderId, order_no: n.orderNo, max_overdue_days: 0, overdue_count: 0 }
        agg.max_overdue_days = Math.max(agg.max_overdue_days, n.overdueDays)
        agg.overdue_count += 1
        orderAgg.set(n.orderId, agg)
      }
      const topOrders = [...orderAgg.values()]
        .sort((a, b) => (b.max_overdue_days - a.max_overdue_days) || (b.overdue_count - a.overdue_count))
        .slice(0, 5)

      // detected_at：最严重超期节点的 due_at（稳定，重建不漂移）
      const worst = nodes.reduce((w, n) => (n.overdueDays > w.overdueDays ? n : w), nodes[0])

      matters.push({
        customer_name: customer,
        order_id: null,
        order_no: null,
        matter_type: 'overdue_summary',
        severity,
        title: severity === 'high'
          ? `${customer} 有 ${overdueCount} 个关键节点超期，涉及 ${overdueOrderCount} 个订单`
          : `${customer} 有 ${overdueCount} 个节点临近/轻度超期`,
        evidence: {
          aggregation: 'customer_overdue_summary',
          overdue_count: overdueCount,
          overdue_order_count: overdueOrderCount,
          max_overdue_days: maxOverdueDays,
          high_overdue_count: highOverdueCount,
          medium_overdue_count: mediumOverdueCount,
          top_steps: topSteps,
          top_orders: topOrders,
        },
        source: 'order',
        source_ref: customer,
        matter_key: `overdue_summary:${customer}`,
        detected_at: worst.dueAt,
      })
    }

    // ════════ 统计 ════════
    const countBy = (type: CustomerMatterDraft['matter_type']) => ({
      high: matters.filter(x => x.matter_type === type && x.severity === 'high').length,
      medium: matters.filter(x => x.matter_type === type && x.severity === 'medium').length,
    })
    const stats: MaterializeStats = {
      customers: new Set(matters.map(x => x.customer_name)).size,
      total: matters.length,
      suspected_complaint: countBy('suspected_complaint'),
      delivery_risk: countBy('delivery_risk'),
      overdue_summary: countBy('overdue_summary'),
      emails_scanned: emailsScanned,
      emails_matched_customer: emailsMatchedCustomer,
    }

    if (opts.mode === 'dry_run') {
      return ok({ stats, matters })
    }

    // ════════ execute：upsert(matter_key) + 清理本轮未检出的行 ════════
    const runTs = new Date().toISOString()
    if (matters.length > 0) {
      const rows = matters.map(x => ({ ...x, materialized_at: runTs }))
      const { error: upErr } = await (supabase.from('customer_matters') as any)
        .upsert(rows, { onConflict: 'matter_key' })
      if (upErr) return err(`写入 customer_matters 失败: ${upErr.message}`)
    }
    const { count: deleted, error: delErr } = await (supabase.from('customer_matters') as any)
      .delete({ count: 'exact' })
      .lt('materialized_at', runTs)
    if (delErr) return err(`清理过期 customer_matters 失败: ${delErr.message}`)

    stats.written = matters.length
    stats.deleted = deleted ?? 0
    return ok({ stats, matters })
  } catch (e: any) {
    return err(`materializeCustomerMatters exception: ${e?.message}`)
  }
}
