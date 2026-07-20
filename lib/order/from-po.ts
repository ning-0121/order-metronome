/**
 * QIMO OS — PO → Order Adapter v1（继承映射，纯函数）
 *
 * 由 customer_po 绑定 + quote 冻结快照 → Order 草稿（继承字段）。
 *
 * NON-NEGOTIABLE：
 *   - 逐字继承快照，绝不重算 price/cost/margin（不 import RAG/成本引擎）。
 *   - ❌ 不 OCR 覆盖 · ❌ 不 AI override · ❌ 不写库（纯映射，供既有 createOrder 消费）。
 *   - fail-closed：快照版本 ≠ PO 绑定版本 → 抛错（订单必须绑 PO 引用的那一冻结版）。
 *
 * 注意：本适配器产出的是**继承草稿**；将 PO↔Order 绑定**持久化**到 orders 行
 * （customer_po_id / quote_snapshot_version 等列）需要一次加法 migration，
 * 不在"禁改 schema"范围内 —— 见交付说明。
 */

import type { QuoteSnapshot } from '@/lib/quoter/types';
import type { CompareBasis } from '@/lib/quoter/consumption';

export interface CustomerPoLike {
  id: string;
  po_number: string;
  customer_id: string;
  quote_id: string;
  quote_snapshot_version: number;
}

export interface OrderDraftFromPO {
  source: 'PO';
  customer_id: string;
  customer_name: string | null;
  customer_po_number: string;
  /** 血缘引用（只引用，不复制业务逻辑） */
  origin_quote_id: string;
  customer_po_id: string;
  quote_snapshot_version: number;
  approved_version: number;
  price_floor: number | null;
  currency: string | null;
  /** 逐字继承的快照行（pricing truth，绝不重算） */
  lines: unknown[];
  inherited_from: { snapshot_version: number; po_id: string };
}

/**
 * @throws Error('snapshot_version_mismatch') 当 snapshot.version ≠ po.quote_snapshot_version
 */
export function buildOrderDraftFromPO(
  po: CustomerPoLike,
  snapshot: QuoteSnapshot,
  envelope: { priceFloor: number | null } = { priceFloor: null },
): OrderDraftFromPO {
  if (snapshot.version !== po.quote_snapshot_version) {
    throw new Error('snapshot_version_mismatch');
  }
  const header = (snapshot.header ?? {}) as Record<string, unknown>;

  return {
    source: 'PO',
    customer_id: po.customer_id,
    customer_name: (header.customer_name as string) ?? null,
    customer_po_number: po.po_number,
    origin_quote_id: po.quote_id, // REFERENCE，非复制
    customer_po_id: po.id,
    quote_snapshot_version: po.quote_snapshot_version,
    approved_version: po.quote_snapshot_version, // PO 绑定的即 Approved 冻结版
    price_floor: envelope.priceFloor,
    currency: (header.currency as string) ?? null,
    lines: snapshot.lines, // 逐字继承，NEVER 重算
    inherited_from: { snapshot_version: snapshot.version, po_id: po.id },
  };
}

/**
 * 快照行 → 逐款明细(line_items)结构,供 createOrder 写 order_line_items + 同步布料到 BOM。
 * 纯函数、可单测。按 style_no 分组(无款号则各自成款);每行一个颜色,size_distribution 即尺码×件数。
 * 布料信息(名/门幅/单耗)取该款首行,喂 syncStyleFabricsToBom → 生产任务单用料 + 该款 BOM 第一行。
 * 2026-07-02:补「从 PO 创建」路径此前不写明细、不同步布料的断点(审计 R-PO)。
 */
export function buildLineItemsFromSnapshot(lines: unknown[]): any[] {
  const groups = new Map<string, any>();
  let seq = 0;
  for (const raw of (lines || [])) {
    const l = raw as Record<string, any>;
    const styleNo = (l.style_no ?? '').toString().trim();
    const key = styleNo || `__line_${seq++}`;   // 无款号 → 每行独立成款
    let g = groups.get(key);
    if (!g) {
      const fabricName = [l.fabric_type, l.fabric_composition].filter(Boolean).join(' ').trim();
      g = {
        style_no: styleNo,
        product_name: (l.style_name ?? '').toString().trim(),
        image_url: '',
        fabric_name: fabricName,
        fabric_width: l.fabric_width_cm != null ? `${l.fabric_width_cm}cm` : '',
        fabric_consumption: l.fabric_consumption_kg != null ? Number(l.fabric_consumption_kg) : '',
        fabric_unit: 'kg',
        // 资金流红线(2026-07-20 全链审计 · 业务开发 P0):携带 approved 冻结快照的成交价
        // → createOrder 写 order_line_items.po_unit_price → PI 单价 / 应收 total_amount 自洽。
        // 此前丢弃 quoted_price_per_piece → PO-first 建单的订单 PI 单价一律 0、应收为 0。
        // 是「逐字继承快照」,非重算,不违反防火墙铁律。
        po_unit_price: (l.quoted_price_per_piece != null && !isNaN(Number(l.quoted_price_per_piece)))
          ? Number(l.quoted_price_per_piece) : null,
        colors: [],
      };
      groups.set(key, g);
    }
    const color = (l.color ?? '').toString().trim();
    const sizes: Record<string, number> = {};
    const sd = l.size_distribution && typeof l.size_distribution === 'object' ? l.size_distribution : {};
    for (const [k, v] of Object.entries(sd)) {
      const n = Number(v) || 0;
      if (n > 0) sizes[k] = n;
    }
    const sizeSum = Object.values(sizes).reduce((a, v) => a + v, 0);
    g.colors.push({
      color_cn: color,
      color_en: '',
      sizes,
      qty: sizeSum || (Number(l.quantity) || 0),   // 无尺码分布 → 用行总数
      remark: '',
    });
  }
  return [...groups.values()];
}

/**
 * 从消费闸门结果（CompareBasis）派生 Order 草稿 —— 带 **approval 硬门**。
 * snapshot 非 approved / 不可消费 / 版本不符 → HARD FAIL（抛错）。
 * 这是 createOrder PO 路径的入口映射：真相只从 approved 冻结快照来。
 *
 * @throws Error('snapshot_not_approved') 当 basis 非 consumable/approved
 * @throws Error('snapshot_version_mismatch') 当版本与 PO 绑定版不一致
 */
export function buildOrderFromPO(po: CustomerPoLike, basis: CompareBasis): OrderDraftFromPO {
  if (!basis.consumable || !basis.isApproved || basis.basis !== 'approved' || !basis.snapshot) {
    throw new Error('snapshot_not_approved');
  }
  if (basis.snapshotVersion !== po.quote_snapshot_version) {
    throw new Error('snapshot_version_mismatch');
  }
  return buildOrderDraftFromPO(po, basis.snapshot, { priceFloor: basis.priceFloor });
}
