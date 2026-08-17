// ============================================================
// Supabase Procurement Adapter —— 采购纵切里**唯一**碰表的地方
//
// 本文件位于 lib/adapters/(ADR-006 白名单层),允许直连表。
// 业务层(app/**、lib/services、lib/domain …)不许再出现 .from('procurement_*')。
//
// 硬规矩(Architecture Cut §4):
//   ① 所有 DB error 转 RepositoryError,PostgrestError 不许泄漏到上层;
//   ② 高危写回读行数(P0 无写路径,P1 接 safe-mutation);
//   ③ 列漂移降级只允许发生在本文件内,不把降级语义暴露给 Domain;
//   ④ 零 migration、零历史数据改写。
// ============================================================

import { createClient } from '@/lib/supabase/server';
import {
  RepositoryError,
  type OrderIdentity,
  type OrderStyleMatrixCell,
  type ProcurementDraft,
  type ProcurementRepositoryP0,
  type ProcurementSource,
} from '@/lib/repositories/contracts/procurement';

type Client = Awaited<ReturnType<typeof createClient>>;

/** PostgrestError → RepositoryError(单一转换点)。 */
function toRepoError(err: unknown, what: string): RepositoryError {
  const e = err as { message?: string; code?: string } | null;
  const msg = e?.message || String(err);
  // 42501 = insufficient_privilege;PGRST116 = 0 行(交给调用方按 not_found 处理)
  const code: RepositoryError['code'] =
    e?.code === '42501' ? 'permission' : /duplicate key|conflict/i.test(msg) ? 'conflict' : 'io';
  return new RepositoryError(code, `${what}失败:${msg}`, err);
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};

export function createProcurementAdapter(client: Client): ProcurementRepositoryP0 {
  return {
    async getOrderIdentity(orderId: string): Promise<OrderIdentity | null> {
      const { data, error } = await (client.from('orders') as any)
        .select('id, order_no, internal_order_no')
        .eq('id', orderId)
        .maybeSingle();
      // ③ internal_order_no 列在部分环境可能未建 → 降级只取 order_no,不把这件事泄漏给上层
      if (error && /internal_order_no/.test(error.message || '')) {
        const retry = await (client.from('orders') as any)
          .select('id, order_no')
          .eq('id', orderId)
          .maybeSingle();
        if (retry.error) throw toRepoError(retry.error, '读取订单身份');
        if (!retry.data) return null;
        return { id: retry.data.id, orderNo: str(retry.data.order_no), internalOrderNo: null };
      }
      if (error) throw toRepoError(error, '读取订单身份');
      if (!data) return null;
      return {
        id: (data as any).id,
        orderNo: str((data as any).order_no),
        internalOrderNo: str((data as any).internal_order_no),
      };
    },

    async getOrderProcurementSource(orderId: string): Promise<ProcurementSource> {
      const [orderRes, bomRes, reqRes] = await Promise.all([
        (client.from('orders') as any)
          .select('id, order_no, quantity, factory_date, etd')
          .eq('id', orderId)
          .maybeSingle(),
        (client.from('materials_bom') as any)
          .select('id, material_name, material_code, qty_per_piece, unit, color, spec, style_no, total_qty, consumption_basis, allocation_mode, material_master_id')
          .eq('order_id', orderId),
        (client.from('material_requirements') as any)
          .select('id', { count: 'exact', head: true })
          .eq('order_id', orderId),
      ]);

      if (orderRes.error) throw toRepoError(orderRes.error, '读取订单');
      if (!orderRes.data) throw new RepositoryError('not_found', `订单不存在:${orderId}`);
      // ③ consumption_basis / allocation_mode 列未建的环境:降级重读。
      //    缺列 = 口径全部未确认 + 分配意图全部为空 → Domain 按「未确认/整单」处理,不会静默算错。
      let bomRows = bomRes.data as any[] | null;
      if (bomRes.error) {
        if (/consumption_basis|allocation_mode/.test(bomRes.error.message || '')) {
          const retry = await (client.from('materials_bom') as any)
            .select('id, material_name, material_code, qty_per_piece, unit, color, spec, style_no, total_qty, material_master_id')
            .eq('order_id', orderId);
          if (retry.error) throw toRepoError(retry.error, '读取 BOM');
          bomRows = retry.data as any[];
        } else {
          throw toRepoError(bomRes.error, '读取 BOM');
        }
      }
      if (reqRes.error) throw toRepoError(reqRes.error, '读取物料需求');

      const o = orderRes.data as any;
      return {
        order: {
          id: o.id,
          orderNo: str(o.order_no),
          quantity: num(o.quantity),
          factoryDate: str(o.factory_date),
          etd: str(o.etd),
        },
        bom: (bomRows || []).map((b) => ({
          id: b.id,
          materialName: str(b.material_name),
          materialCode: str(b.material_code),
          qtyPerPiece: num(b.qty_per_piece),
          unit: str(b.unit),
          color: str(b.color),
          spec: str(b.spec),
          styleNo: str(b.style_no),
          totalQty: num(b.total_qty),
          consumptionBasis: str(b.consumption_basis),
          allocationMode: str(b.allocation_mode),
          materialMasterId: str(b.material_master_id),
        })),
        requirementCount: reqRes.count || 0,
      };
    },

    /**
     * 订单逐款明细矩阵:一行一款一色,sizes 是 {尺码:套数} 的 jsonb → 摊平成逐格。
     *
     * 数量语义(2026-08-16 生产库校准,与 20260622 迁移注释相反 —— 以实测为准):
     *   sizes 格 = **套数**(商业数量),qty_pcs == Σsizes;件数 = 套数 × set_multiplier。
     *   实证 QM-20260717-002:(960+480+480+480) × 2 = 4800 = orders.quantity ✓
     * 本层只搬运不换算 —— 换算按口径走 Domain(resolveQuantityForBasis)。
     *
     * ⚠️ 不 select 价格列:本方法喂采购分配,po_unit_price 是财务红线,一个字节都不取。
     */
    async getOrderStyleMatrix(orderId: string): Promise<OrderStyleMatrixCell[]> {
      const { data, error } = await (client.from('order_line_items') as any)
        .select('style_no, product_name, color_cn, color_en, sizes, qty_pcs, set_multiplier')
        .eq('order_id', orderId);
      if (error) throw toRepoError(error, '读取订单逐款明细');

      const out: OrderStyleMatrixCell[] = [];
      for (const r of ((data as any[]) || [])) {
        const styleNo = str(r.style_no);
        if (!styleNo) continue;   // 无款号的行进不了分配(分配键以款为首)
        const setMultiplier = Number(r.set_multiplier) > 0 ? Number(r.set_multiplier) : 1;
        const sizes = r.sizes && typeof r.sizes === 'object' && !Array.isArray(r.sizes)
          ? (r.sizes as Record<string, unknown>)
          : {};
        const common = {
          styleNo,
          productName: str(r.product_name),
          colorCn: str(r.color_cn),
          colorEn: str(r.color_en),
          setMultiplier,
        };
        let any = false;
        for (const [size, qty] of Object.entries(sizes)) {
          const q = num(qty);
          if (q == null || q <= 0) continue;
          any = true;
          out.push({ ...common, size: str(size), commercialQty: q });
        }
        // 该款没录尺码:退到行级 qty_pcs(== Σsizes 的同一口径),给一格 size=null。
        // 这样按款/按色分配照常可用;按码分配时 Domain 会因缺码返回 NO_MATRIX,
        // 明确交回跟单去补尺码 —— 不静默出 0,也不拿总量硬当某个码的量。
        if (!any) {
          const rowQty = num(r.qty_pcs);
          if (rowQty != null && rowQty > 0) out.push({ ...common, size: null, commercialQty: rowQty });
        }
      }
      return out;
    },

    async getProcurementDraft(orderId: string): Promise<ProcurementDraft> {
      const [itemRes, lineRes] = await Promise.all([
        (client.from('procurement_items') as any)
          .select('id, consolidation_key, material_name, color, unit, final_purchase_qty, suggested_purchase_qty, needs_reconfirm, status')
          .eq('order_id', orderId),
        (client.from('procurement_line_items') as any)
          .select('id, procurement_item_id, size, ordered_qty, line_status, status, purchase_order_id')
          .eq('order_id', orderId),
      ]);
      if (itemRes.error) throw toRepoError(itemRes.error, '读取采购项');
      if (lineRes.error) throw toRepoError(lineRes.error, '读取采购执行行');

      return {
        items: ((itemRes.data as any[]) || []).map((i) => ({
          id: i.id,
          consolidationKey: String(i.consolidation_key ?? ''),
          materialName: str(i.material_name),
          color: str(i.color),
          unit: str(i.unit),
          finalPurchaseQty: num(i.final_purchase_qty),
          suggestedPurchaseQty: num(i.suggested_purchase_qty),
          needsReconfirm: Boolean(i.needs_reconfirm),
          status: String(i.status ?? 'draft'),
        })),
        executionLines: ((lineRes.data as any[]) || []).map((l) => ({
          id: l.id,
          procurementItemId: str(l.procurement_item_id),
          size: str(l.size),
          orderedQty: num(l.ordered_qty),
          lineStatus: str(l.line_status),
          legacyStatus: str(l.status),
          purchaseOrderId: str(l.purchase_order_id),
        })),
      };
    },
  };
}

/** 默认工厂:用当前请求的 session 客户端(RLS 生效)。 */
export async function procurementRepo(): Promise<ProcurementRepositoryP0> {
  return createProcurementAdapter(await createClient());
}
