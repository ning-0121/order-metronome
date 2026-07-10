'use server';

/**
 * 出货单据 → 财务(阶段一 · 文件送达,2026-07-10)。
 * 触发:出运节点(shipment_execute)完成时,fire-and-forget 调 fireShippingDocsToFinance。
 * 做什么:服务端就地生成 装箱单 / CI / 报关 / PI 四张 Excel(复用与下载同一份 builder,以 canSeeFin=true
 *        装载,财务有权看价)→ 落 Supabase Storage(order-docs/shipping-docs/…)→ getPublicUrl 取持久 URL
 *        → 逐张发 file.uploaded 到财务(财务侧已有处理器,零改动,写 uploaded_documents)。
 * 幂等:storage upsert 覆盖同 path;file.uploaded 的 id 由 (order,kind,batch) 内容确定性生成 → 财务按 id 去重。
 * 不阻塞主链路:整个过程 try/catch 吞错(同 fireRuntimeRecompute 口径);PI 仅在业务已保存 order_pi 时才发。
 * 阶段二(CI 金额 → 应收账款 / PI 定金入账)另走 shipping_invoice.issued,需财务侧新处理器,后续单独上线。
 */

import { createHash } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { loadShippingDocModel } from '@/lib/services/shipping-docs';
import {
  buildPackingListWorkbook, buildCommercialInvoiceWorkbook, buildCustomsWorkbook, buildPIWorkbook,
} from '@/lib/services/shipping-doc-builders';
import { syncFileToFinance } from '@/lib/integration/finance-sync';
import type { PIData } from '@/app/actions/order-pi';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// 内容确定性 UUID(供财务按 id upsert 去重):同一 (order, kind, batch) 恒得同 id,重发不重复建。
function deterministicDocId(orderId: string, kind: string, batchId: string | null): string {
  const h = createHash('sha256').update(`shipdoc|${orderId}|${kind}|${batchId || 'whole'}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

type DocKind = 'packing_list' | 'commercial_invoice' | 'customs' | 'proforma_invoice';

// storage key 用 ascii 稳定名(避免中文/空格污染 URL);file_name 用面向财务的展示名。
const STORAGE_KEY: Record<DocKind, string> = {
  packing_list: 'packing-list.xlsx',
  commercial_invoice: 'commercial-invoice.xlsx',
  customs: 'customs-docs.xlsx',
  proforma_invoice: 'proforma-invoice.xlsx',
};

/**
 * 生成 + 落存储 + 发财务。返回明细供上层记日志。永不抛(内部吞错)。
 */
export async function syncShippingDocsToFinance(
  orderId: string, batchId?: string | null,
): Promise<{ ok: boolean; sent: string[]; skipped: string[]; error?: string }> {
  const sent: string[] = [];
  const skipped: string[] = [];
  try {
    const svc = createServiceRoleClient();

    // 待发清单。scopeBatchId 决定 storage/id 归属:PL/CI/报关 属本批(batchId);
    // PI 是整单形式发票 → 固定 whole(null),否则分批订单每批都推一份同样的 PI,财务侧堆 N 份。
    const docs: Array<{ kind: DocKind; fileName: string; wb: import('exceljs').Workbook; scopeBatchId: string | null }> = [];

    // canSeeFin=true:财务有权看价,CI/报关需要价列。一次装载,三张单同源。
    const { data: m } = await loadShippingDocModel(svc, orderId, true, batchId ?? null);
    let order: any = null;
    if (m) {
      order = m.order;
      const idNo = m.order.internal_order_no || m.order.order_no || m.order.po_number || orderId;
      docs.push({ kind: 'packing_list', fileName: `Packing List - ${idNo}.xlsx`, wb: await buildPackingListWorkbook(m), scopeBatchId: batchId ?? null });
      docs.push({ kind: 'commercial_invoice', fileName: `CI - ${idNo}.xlsx`, wb: await buildCommercialInvoiceWorkbook(m), scopeBatchId: batchId ?? null });
      docs.push({ kind: 'customs', fileName: `报关资料 - ${idNo}.xlsx`, wb: await buildCustomsWorkbook(m), scopeBatchId: batchId ?? null });
    } else {
      skipped.push('packing_list/commercial_invoice/customs(尚未录入出货装箱数据)');
    }

    // PI:仅在业务已保存 order_pi 时才发(未保存的现算草稿不作为出货凭证)。固定 whole 归属。
    const { data: piRow } = await (svc.from('order_pi') as any).select('data').eq('order_id', orderId).maybeSingle();
    const piData = (piRow as any)?.data as PIData | undefined;
    if (piData && Array.isArray(piData.lines) && piData.lines.length > 0) {
      if (!order) {
        const { data: o } = await (svc.from('orders') as any)
          .select('order_no, internal_order_no, po_number, customer_name').eq('id', orderId).maybeSingle();
        order = o;
      }
      const idNo = order?.internal_order_no || order?.order_no || order?.po_number || orderId;
      docs.push({ kind: 'proforma_invoice', fileName: `PI - ${idNo}.xlsx`, wb: await buildPIWorkbook(piData), scopeBatchId: null });
    } else {
      skipped.push('proforma_invoice(未保存 PI)');
    }

    if (docs.length === 0) return { ok: true, sent, skipped };

    const customerName = order?.customer_name ?? null;
    for (const d of docs) {
      try {
        const scope = d.scopeBatchId ? `batch-${d.scopeBatchId}` : 'whole';
        const buf = Buffer.from(await d.wb.xlsx.writeBuffer());
        const path = `shipping-docs/${orderId}/${scope}/${STORAGE_KEY[d.kind]}`;
        const { error: upErr } = await svc.storage.from('order-docs').upload(path, buf, { contentType: XLSX_MIME, upsert: true });
        if (upErr) { skipped.push(`${d.kind}(存储失败:${upErr.message})`); continue; }
        const { data: pub } = svc.storage.from('order-docs').getPublicUrl(path);
        await syncFileToFinance({
          id: deterministicDocId(orderId, d.kind, d.scopeBatchId),
          file_name: d.fileName,
          file_type: 'excel',   // 财务 uploaded_documents.file_type CHECK 仅收 excel/pdf/image/word
          file_size: buf.length,
          file_url: pub.publicUrl,
          matched_customer: customerName,
          extracted_fields: {
            source: 'order-metronome/shipping-docs',
            doc_kind: d.kind,
            order_id: orderId,
            order_no: order?.order_no ?? null,
            internal_order_no: order?.internal_order_no ?? null,
            po_number: order?.po_number ?? null,
            batch_id: d.scopeBatchId,
          },
        });
        sent.push(d.kind);
      } catch (e: any) {
        skipped.push(`${d.kind}(异常:${e?.message || e})`);
      }
    }
    return { ok: true, sent, skipped };
  } catch (e: any) {
    console.warn('[shipdoc-sync] 出货单据同步财务失败(不阻断):', e?.message);
    return { ok: false, sent, skipped, error: e?.message || String(e) };
  }
}
