/**
 * 采购单「单头金额 = 明细合计」配平校验(财务契约 v1,2026-08-03)。
 *
 * 【为什么在源头拦,而不是只等财务驳回】
 * 2026-08-02 事故:小吴提交的对账单金额与供应商汇总不一致 → 海莲签了字、圆圆没发现 → 一路批过。
 * Yoga 的原话:「依赖我来最终发现问题」。
 *
 * 财务侧已经把闸门做成硬的(Σlines ≠ total 就禁用「批准放行」)。但如果节拍器这边
 * 照样让不配平的单送出去,结果是采购提了、财务驳了、来回扯 —— 问题只是换个地方发现。
 * 在下单/送审那一刻就拦住,采购当场改到一致,财务那道闸永远用不上,这才是对的。
 *
 * 【容差 0.01 元】老板决策:金额对不上**绝对不能过**,必须改到一致。
 * 谈好的零头折让也不例外 —— 必须落成一条具名的扣款/折让行使总额配平,
 * 而不是"点个确认放过"。差额不能消失在一句「差 ¥156」里。
 *
 * 【为什么单独成文件】三个推送点(placeCore / 重新送审 / resync)都要用同一套判断,
 * 各写一遍必然分叉 —— 这个项目已经因为"同一件事两处各算一遍"栽过好几次。
 */

/** 金额容差:0.01 元。浮点相加会有 1e-10 级误差,但真实差额都 ≥ 0.01。 */
export const PO_AMOUNT_TOLERANCE = 0.01

export interface PoLineLike {
  ordered_amount?: number | string | null
  amount?: number | string | null
  ordered_qty?: number | string | null
  unit_price?: number | string | null
  material_name?: string | null
}

export interface ReconcileResult {
  ok: boolean
  /** 明细合计 */
  linesTotal: number
  /** 单头金额 */
  headerTotal: number
  /** 单头 − 明细。正数=单头多,负数=明细多 */
  diff: number
  lineCount: number
  /** 不通过时给人看的一句话(直接可当报错文案) */
  message: string | null
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 单行金额:优先 ordered_amount,其次 amount,最后 qty × price 兜底 */
export function lineAmount(l: PoLineLike): number {
  if (l?.ordered_amount != null) return num(l.ordered_amount)
  if (l?.amount != null) return num(l.amount)
  return num(l?.ordered_qty) * num(l?.unit_price)
}

/**
 * 校验配平。
 *
 * ⚠️ 无底价单(price_tbd / 单头金额为 0 或空)**不校验** —— 那是「价待定」的合法状态,
 * 财务侧也按 amount_pending 处理,补价后再由 resync 走一次。
 * 把它一起拦住会把正常流程堵死。
 */
export function reconcilePoAmount(
  headerAmount: unknown,
  lines: PoLineLike[] | null | undefined,
  opts?: { priceTbd?: boolean },
): ReconcileResult {
  const rows = Array.isArray(lines) ? lines : []
  const linesTotal = +rows.reduce((a, l) => a + lineAmount(l), 0).toFixed(2)
  const headerTotal = +num(headerAmount).toFixed(2)
  const diff = +(headerTotal - linesTotal).toFixed(2)
  const base = { linesTotal, headerTotal, diff, lineCount: rows.length }

  // 价待定:合法,放行
  if (opts?.priceTbd || headerTotal <= 0) return { ...base, ok: true, message: null }

  if (rows.length === 0) {
    return {
      ...base,
      ok: false,
      message: `这张采购单没有明细行,财务无从判断钱花在什么上,无法送审。请先录入原辅料明细行。`,
    }
  }

  if (Math.abs(diff) > PO_AMOUNT_TOLERANCE) {
    const more = diff > 0 ? '单头比明细多' : '明细比单头多'
    return {
      ...base,
      ok: false,
      message:
        `金额对不上:单头 ¥${headerTotal.toFixed(2)},明细合计 ¥${linesTotal.toFixed(2)},` +
        `${more} ¥${Math.abs(diff).toFixed(2)}。\n` +
        `请改到完全一致再送审 —— 若是谈好的折让/扣款,请**落成一条具名的明细行**(如「折让」-¥${Math.abs(diff).toFixed(2)}),` +
        `不要留在单头差额里。财务侧不接受不配平的采购单。`,
    }
  }

  return { ...base, ok: true, message: null }
}
