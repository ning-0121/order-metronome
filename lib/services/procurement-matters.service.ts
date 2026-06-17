// ============================================================
// Procurement Matters Service — 采购风险物化（V1 §11 第7件 / 设计契约 §3.6 §8）
// 职责：纯规则物化（零 AI），把采购行/到货数据投影成 CEO/PM 可读的风险事项。
//   信号1 material_shortage — 待下单行红/黄灯：再不下单/到不了，订单缺料
//   信号2 supplier_delay    — 在途行红/黄灯：供应商交期晚于需到日（催货次数未达升级阈值）
//   信号3 chase_stalled     — 在途行已催 N 次仍未到：催货停滞
//   信号4 price_anomaly     — price_variance_pct 超历史中位阈值（决策4：只提示）
//   信号5 quality_reject    — 近期到货验收拒收/让步
//   信号6 risk_schedule     — V2（kit/APS 联动）才发，V1 不产出
// 模式：dry_run（只算不写，供人审误报）/ execute（upsert + 清理本轮未检出的行）。
// 红线：表无 authenticated 写策略 → 调用方必须传 service-role client；不发通知、不写 daily_tasks。
// 完全复用 customer-matters.service 的物化纪律（upsert matter_key + sweep stale）。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { ok, err, type ServiceResult } from './types'
import {
  computeLineLamp,
  priceVarianceLevel,
  CHASE_ESCALATION_THRESHOLD,
  type LineLamp,
} from '@/lib/domain/procurement'

const TERMINAL_LIFECYCLE = new Set(['completed', '已完成', 'cancelled', '已取消'])
const QUALITY_LOOKBACK_DAYS = 45 // 质量拒收/让步只看近 45 天，避免陈年旧账刷屏
const CHASE_STALLED_HIGH = CHASE_ESCALATION_THRESHOLD * 2 // 催 6 次仍未到 = high

// 缺料/延期监控状态（arrived 已到厂，不算缺料/延期；但价格异常仍看 arrived）
const PRE_ARRIVAL_STATUSES = ['pending_order', 'ordered', 'confirmed', 'in_production', 'shipped']
const PRICE_WATCH_STATUSES = [...PRE_ARRIVAL_STATUSES, 'arrived']

export type ProcurementMatterType =
  | 'material_shortage'
  | 'supplier_delay'
  | 'chase_stalled'
  | 'price_anomaly'
  | 'quality_reject'
  | 'risk_schedule'

export interface ProcurementMatterDraft {
  order_id: string | null
  order_no: string | null
  supplier_id: string | null
  line_item_id: string | null
  matter_type: ProcurementMatterType
  severity: 'high' | 'medium'
  title: string
  evidence: Record<string, unknown>
  source: string
  source_ref: string
  matter_key: string
  detected_at: string
}

export interface ProcurementMaterializeStats {
  total: number
  orders_affected: number
  suppliers_affected: number
  lines_scanned: number
  receipts_scanned: number
  material_shortage: { high: number; medium: number }
  supplier_delay: { high: number; medium: number }
  chase_stalled: { high: number; medium: number }
  price_anomaly: { high: number; medium: number }
  quality_reject: { high: number; medium: number }
  written?: number
  deleted?: number
}

const CAT_LABEL: Record<string, string> = {
  fabric: '面料', trim: '辅料', packing: '包装', print: '印花', other: '其他',
}

function fmtDate(d: string | null | undefined): string {
  return d ? String(d).slice(0, 10) : '未定'
}

export async function materializeProcurementMatters(
  supabase: SupabaseClient,
  opts: { mode: 'dry_run' | 'execute' },
): Promise<ServiceResult<{ stats: ProcurementMaterializeStats; matters: ProcurementMatterDraft[] }>> {
  try {
    const now = new Date()
    const nowMs = now.getTime()
    const matters: ProcurementMatterDraft[] = []

    // ════════ 采购行：缺料 / 供应商延期 / 催货停滞 / 价格异常 ════════
    const { data: lines, error: lineErr } = await (supabase.from('procurement_line_items') as any)
      .select('id, order_id, line_status, material_name, category, supplier_id, supplier_name, required_by, promised_date, expected_arrival, po_no, unit_price, price_baseline, price_variance_pct, chase_count, last_chased_at, ordered_qty, ordered_unit, ordered_at, created_at, orders(order_no, customer_name, lifecycle_status)')
      .in('line_status', PRICE_WATCH_STATUSES)
    if (lineErr) return err(`读取 procurement_line_items 失败: ${lineErr.message}`)

    const activeLines = (lines || []).filter(
      (l: any) => !TERMINAL_LIFECYCLE.has(l.orders?.lifecycle_status || ''),
    )
    const linesScanned = activeLines.length

    for (const l of activeLines) {
      const orderNo = l.orders?.order_no ?? null
      const catLabel = CAT_LABEL[l.category || 'other'] || l.category || ''
      const lamp: LineLamp = computeLineLamp(l, { now })
      const isPreArrival = PRE_ARRIVAL_STATUSES.includes(l.line_status)
      const eta = l.expected_arrival || l.promised_date

      // ── 信号1/2/3：缺料 / 供应商延期 / 催货停滞（仅未到厂行，且灯为红/黄）──
      if (isPreArrival && (lamp === 'red' || lamp === 'yellow')) {
        const baseSeverity: 'high' | 'medium' = lamp === 'red' ? 'high' : 'medium'

        if (l.line_status === 'pending_order') {
          // 还没下单就快/已晚 → 缺料风险
          matters.push({
            order_id: l.order_id, order_no: orderNo,
            supplier_id: l.supplier_id ?? null, line_item_id: l.id,
            matter_type: 'material_shortage', severity: baseSeverity,
            title: `缺料风险：${l.material_name}（${catLabel}）需 ${fmtDate(l.required_by)} 前到，尚未下单`,
            evidence: {
              lamp, line_status: l.line_status, required_by: l.required_by,
              supplier_name: l.supplier_name, category: l.category,
              ordered_qty: l.ordered_qty, ordered_unit: l.ordered_unit,
            },
            source: 'line', source_ref: `line:${l.id}`,
            matter_key: `material_shortage:line:${l.id}`,
            detected_at: l.required_by || l.created_at || new Date(nowMs).toISOString(),
          })
        } else {
          // 在途行：催货达阈值 → 催货停滞；否则 → 供应商延期
          const chaseCount = l.chase_count || 0
          if (chaseCount >= CHASE_ESCALATION_THRESHOLD) {
            matters.push({
              order_id: l.order_id, order_no: orderNo,
              supplier_id: l.supplier_id ?? null, line_item_id: l.id,
              matter_type: 'chase_stalled',
              severity: chaseCount >= CHASE_STALLED_HIGH ? 'high' : 'medium',
              title: `催货停滞：${l.material_name} 已催 ${chaseCount} 次仍未到（${l.supplier_name || '未填供应商'}）`,
              evidence: {
                lamp, chase_count: chaseCount, last_chased_at: l.last_chased_at,
                required_by: l.required_by, expected_arrival: eta,
                supplier_name: l.supplier_name, line_status: l.line_status,
              },
              source: 'line', source_ref: `line:${l.id}`,
              matter_key: `chase_stalled:line:${l.id}`,
              detected_at: l.required_by || l.last_chased_at || new Date(nowMs).toISOString(),
            })
          } else {
            matters.push({
              order_id: l.order_id, order_no: orderNo,
              supplier_id: l.supplier_id ?? null, line_item_id: l.id,
              matter_type: 'supplier_delay', severity: baseSeverity,
              title: `供应商交期风险：${l.supplier_name || '供应商'} 的 ${l.material_name} 预计 ${fmtDate(eta)}，需 ${fmtDate(l.required_by)} 前到`,
              evidence: {
                lamp, line_status: l.line_status, required_by: l.required_by,
                expected_arrival: l.expected_arrival, promised_date: l.promised_date,
                chase_count: chaseCount, supplier_name: l.supplier_name,
              },
              source: 'line', source_ref: `line:${l.id}`,
              matter_key: `supplier_delay:line:${l.id}`,
              detected_at: l.required_by || l.created_at || new Date(nowMs).toISOString(),
            })
          }
        }
      }

      // ── 信号4：价格异常（独立，决策4 只提示不阻断）──
      const pv = priceVarianceLevel(l.price_variance_pct)
      if (pv) {
        matters.push({
          order_id: l.order_id, order_no: orderNo,
          supplier_id: l.supplier_id ?? null, line_item_id: l.id,
          matter_type: 'price_anomaly', severity: pv === 'red' ? 'high' : 'medium',
          title: `价格异常：${l.material_name} 高于历史中位 ${Number(l.price_variance_pct).toFixed(0)}%（本次 ${l.unit_price}，基线 ${l.price_baseline}）`,
          evidence: {
            unit_price: l.unit_price, price_baseline: l.price_baseline,
            price_variance_pct: l.price_variance_pct, supplier_name: l.supplier_name,
            po_no: l.po_no ?? null, line_status: l.line_status,
          },
          source: 'line', source_ref: `line:${l.id}:price`,
          matter_key: `price_anomaly:line:${l.id}`,
          detected_at: l.ordered_at || l.created_at || new Date(nowMs).toISOString(),
        })
      }
    }

    // ════════ 到货验收：质量拒收 / 让步 ════════
    const sinceIso = new Date(nowMs - QUALITY_LOOKBACK_DAYS * 86400000).toISOString()
    const { data: receipts, error: grErr } = await (supabase.from('goods_receipts') as any)
      .select('id, line_item_id, order_id, inspection_result, defect_notes, received_at, return_status, procurement_line_items(material_name, supplier_id, supplier_name), orders(order_no, customer_name, lifecycle_status)')
      .in('inspection_result', ['reject', 'concession'])
      .gte('received_at', sinceIso)
      .order('received_at', { ascending: false })
    if (grErr) return err(`读取 goods_receipts 失败: ${grErr.message}`)

    const receiptsScanned = (receipts || []).length
    for (const r of receipts || []) {
      if (TERMINAL_LIFECYCLE.has(r.orders?.lifecycle_status || '')) continue
      const isReject = r.inspection_result === 'reject'
      const li = r.procurement_line_items
      const material = li?.material_name || '物料'
      matters.push({
        order_id: r.order_id, order_no: r.orders?.order_no ?? null,
        supplier_id: li?.supplier_id ?? null, line_item_id: r.line_item_id,
        matter_type: 'quality_reject',
        severity: isReject ? 'high' : 'medium',
        title: isReject
          ? `质量拒收：${material}${r.defect_notes ? `（${r.defect_notes}）` : ''}`
          : `让步接收：${material}${r.defect_notes ? `（${r.defect_notes}）` : ''}`,
        evidence: {
          inspection_result: r.inspection_result, defect_notes: r.defect_notes,
          return_status: r.return_status, received_at: r.received_at,
          supplier_name: li?.supplier_name ?? null,
        },
        source: 'receipt', source_ref: `receipt:${r.id}`,
        matter_key: `quality_reject:receipt:${r.id}`,
        detected_at: r.received_at || new Date(nowMs).toISOString(),
      })
    }

    // ════════ 统计 ════════
    const countBy = (type: ProcurementMatterType) => ({
      high: matters.filter(x => x.matter_type === type && x.severity === 'high').length,
      medium: matters.filter(x => x.matter_type === type && x.severity === 'medium').length,
    })
    const stats: ProcurementMaterializeStats = {
      total: matters.length,
      orders_affected: new Set(matters.map(x => x.order_id).filter(Boolean)).size,
      suppliers_affected: new Set(matters.map(x => x.supplier_id).filter(Boolean)).size,
      lines_scanned: linesScanned,
      receipts_scanned: receiptsScanned,
      material_shortage: countBy('material_shortage'),
      supplier_delay: countBy('supplier_delay'),
      chase_stalled: countBy('chase_stalled'),
      price_anomaly: countBy('price_anomaly'),
      quality_reject: countBy('quality_reject'),
    }

    if (opts.mode === 'dry_run') {
      return ok({ stats, matters })
    }

    // ════════ execute：upsert(matter_key) + 清理本轮未检出的行 ════════
    const runTs = new Date().toISOString()
    if (matters.length > 0) {
      const rows = matters.map(x => ({ ...x, materialized_at: runTs }))
      const { error: upErr } = await (supabase.from('procurement_matters') as any)
        .upsert(rows, { onConflict: 'matter_key' })
      if (upErr) return err(`写入 procurement_matters 失败: ${upErr.message}`)
    }
    const { count: deleted, error: delErr } = await (supabase.from('procurement_matters') as any)
      .delete({ count: 'exact' })
      .lt('materialized_at', runTs)
    if (delErr) return err(`清理过期 procurement_matters 失败: ${delErr.message}`)

    stats.written = matters.length
    stats.deleted = deleted ?? 0
    return ok({ stats, matters })
  } catch (e: any) {
    return err(`materializeProcurementMatters exception: ${e?.message}`)
  }
}
