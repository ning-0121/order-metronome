// ============================================================
// Contract API v1 — araos 赢单交接接收端(POST 写)· 客户同步 Phase 1 · 方案1
// araos 赢单 → 签名推「客户 + 赢单事件」→ QIMO 落客户(写 source_araos_company_id)
//              + 通知业务手动建单。**不自动建 PO/订单**(Order 是 PO 派生物,定价建单仍人工)。
// 幂等键 = araos_order_id;重投同单已处理 → 返回已存 qimo_customer_id,不重复建/不重复通知。
// 鉴权:契约 HMAC + body sha256(§3.1);仅 araos 消费者可写。GET 只读路由不受影响。
// ============================================================

import { NextResponse } from 'next/server';
import { verifyContractRequest, sha256Hex } from '../../_lib/auth';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { notifyUsersByRole } from '@/lib/utils/notifications';
import { deriveOrderQuantityContext, formatQuantityDisplay } from '@/lib/domain/quantity-engine';

export const dynamic = 'force-dynamic';

const ROUTE_PATH = '/api/contract/v1/handoff/araos';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code: string, status: number, message?: string) {
  return NextResponse.json({ schema_version: 'v1', error: { code, message: message ?? code } }, { status });
}

/**
 * araos 出站真实 body(见 araos lib/metronome/client.ts):
 *   { source, entity_type:'order'|'sample', entity_id, company_id, idempotency_key, data:{...}, sent_at }
 * data = buildOrderPayload/buildSamplePayload:{ type, araos_order_id/araos_sample_id, company_name,
 *        contact_name, contact_email, contact_phone, order_ref/quantity/required_delivery/product_lines/... }
 * 本端点向后兼容一个扁平 { araos_order_id, customer:{...}, deal:{...} } 形态。
 */
type AnyObj = Record<string, any>;

const str = (v: any): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};
const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** product_lines(数组/对象/字符串)→ 简短款式摘要,用于通知文案。 */
function stylesSummary(pl: any): string | null {
  if (!pl) return null;
  if (typeof pl === 'string') return str(pl);
  if (Array.isArray(pl)) {
    const parts = pl.map((x) => (typeof x === 'string' ? x : x?.style || x?.name || x?.style_no)).filter(Boolean);
    return parts.length ? parts.slice(0, 4).join('、') + (parts.length > 4 ? ` 等${parts.length}款` : '') : null;
  }
  return null;
}

interface Normalized {
  araosOrderId: string | null;
  araosCompanyId: string | null;
  entityType: string;              // order | sample
  eventType: string;               // deal_won | sample_request
  customerName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  deal: { po_number: string | null; style: string | null; quantity: number | null; target_delivery: string | null; currency: string | null; note: string | null };
}

/** 归一化 araos 包裹体 / 扁平体 → 统一字段。 */
function normalize(body: AnyObj): Normalized {
  const d: AnyObj = body && typeof body.data === 'object' && body.data ? body.data : body;
  const c: AnyObj = body?.customer && typeof body.customer === 'object' ? body.customer : {};
  const entityType = str(body?.entity_type) || (d?.type === 'sample_request' ? 'sample' : 'order') || 'order';
  return {
    araosOrderId: str(body?.idempotency_key) || str(body?.entity_id) || str(d?.araos_order_id) || str(d?.araos_sample_id),
    araosCompanyId: str(body?.company_id) || str(d?.araos_company_id),
    entityType,
    eventType: str(body?.event_type) || (entityType === 'sample' ? 'sample_request' : 'deal_won'),
    customerName: str(d?.company_name) || str(c?.name) || str(c?.company_name),
    contactName: str(d?.contact_name) || str(c?.contact_name),
    email: str(d?.contact_email) || str(c?.email),
    phone: str(d?.contact_phone) || str(d?.shipping?.phone) || str(c?.phone),
    country: str(d?.shipping?.country) || str(d?.country) || str(c?.country),
    deal: {
      po_number: str(d?.order_ref) || str(body?.deal?.po_number),
      style: stylesSummary(d?.product_lines) || str(d?.styles_requested) || str(body?.deal?.style),
      quantity: num(d?.quantity) ?? num(body?.deal?.quantity),
      target_delivery: str(d?.required_delivery) || str(d?.target_delivery) || str(body?.deal?.target_delivery),
      currency: str(d?.currency) || str(body?.deal?.currency),
      note: str(d?.spec_notes) || str(d?.brand_requirements) || str(body?.deal?.note),
    },
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const now = Date.now();
  const url = new URL(request.url);
  const path = url.pathname + (url.search || '');

  // 1) 原始 body + 签名校验(含 body hash)
  const rawBody = await request.text();
  const auth = verifyContractRequest({
    method: 'POST',
    path,
    apiKey: request.headers.get('x-api-key'),
    timestamp: request.headers.get('x-timestamp'),
    signature: request.headers.get('x-signature'),
    now,
    bodyHash: sha256Hex(rawBody),
  });
  if (!auth.ok) return fail(auth.code, auth.status);
  if (auth.keyId !== 'araos') return fail('insufficient_scope', 403, 'handoff 仅限 araos 消费者');

  // 2) 解析 + 归一化(araos 包裹体/扁平体)+ 校验必填
  let body: AnyObj;
  try { body = JSON.parse(rawBody || '{}'); } catch { return fail('invalid_body', 400, 'body 非合法 JSON'); }
  const n = normalize(body);
  const araosOrderId = n.araosOrderId || '';
  const customerName = n.customerName || '';
  if (!araosOrderId) return fail('invalid_body', 400, '缺 araos entity id(幂等键)');
  if (!customerName) return fail('invalid_body', 400, '缺客户名(company_name)');

  const araosCompanyId = n.araosCompanyId || '';
  const sourceUuid = UUID_RE.test(araosCompanyId) ? araosCompanyId : null; // source_araos_company_id 为 uuid 列
  const svc = createServiceRoleClient();

  try {
    // 3) 幂等:已处理/已转单过 → 直接返回已存结果(不重复建客户/不重复通知)
    //    角色审计修:补 'converted' —— 订单已建后 inbox 是 converted,之前只认 'processed' → 重发 deal_won
    //    穿透幂等闸,重复通知业务「赢单」+ 把 status 从 converted 翻回 processed。
    const { data: existing } = await (svc.from('araos_handoffs_inbox') as any)
      .select('status, qimo_customer_id, customer_matched, match_path').eq('araos_order_id', araosOrderId).maybeSingle();
    if (existing && ['processed', 'converted'].includes(existing.status) && existing.qimo_customer_id) {
      return NextResponse.json({
        schema_version: 'v1', idempotent: true,
        qimo_customer_id: existing.qimo_customer_id, customer_matched: existing.customer_matched, match_path: existing.match_path,
      });
    }

    // 4) 客户 upsert(source_araos_company_id 命中优先 → 同名且无冲突 source → 否则新建)
    let customerId: string | null = null;
    let matched = false;
    let matchPath: 'source' | 'name' | 'created' = 'created';

    if (sourceUuid) {
      const { data: bySource } = await (svc.from('customers') as any)
        .select('id, source_araos_company_id').eq('source_araos_company_id', sourceUuid).limit(1).maybeSingle();
      if (bySource?.id) { customerId = bySource.id; matched = true; matchPath = 'source'; }
    }
    if (!customerId) {
      const { data: byName } = await (svc.from('customers') as any)
        .select('id, source_araos_company_id').ilike('customer_name', customerName).limit(1).maybeSingle();
      // 同名可复用:仅当该客户尚未绑定别的 araos source(防不同 araos 公司撞名合并)
      if (byName?.id && (!byName.source_araos_company_id || byName.source_araos_company_id === sourceUuid)) {
        customerId = byName.id; matched = true; matchPath = 'name';
        if (sourceUuid && !byName.source_araos_company_id) {
          await (svc.from('customers') as any).update({ source_araos_company_id: sourceUuid }).eq('id', byName.id);
        }
      }
    }
    if (!customerId) {
      const insert: Record<string, unknown> = {
        customer_name: customerName,
        company_name: customerName,
        contact_name: n.contactName,
        email: n.email,
        phone: n.phone,
        country: n.country,
        source_araos_company_id: sourceUuid,
      };
      const { data: created, error: cErr } = await (svc.from('customers') as any)
        .insert(insert).select('id').single();
      if (cErr || !created?.id) throw new Error('客户建立失败:' + (cErr?.message || 'unknown'));
      customerId = created.id; matchPath = 'created';
    }

    // 5) 通知业务:赢单/寄样来建单(不自动建单)
    const d = n.deal;
    const isSample = n.entityType === 'sample';
    const dealBits = [
      d.po_number ? `单号 ${d.po_number}` : null,
      d.style ? `款 ${d.style}` : null,
      d.quantity ? formatQuantityDisplay(deriveOrderQuantityContext({
        physicalQuantity: d.quantity,
        quantityUnit: d.quantity_unit || null,
      })) : null,
      d.target_delivery ? `交期 ${String(d.target_delivery).slice(0, 10)}` : null,
    ].filter(Boolean).join(' · ');
    await notifyUsersByRole(svc, ['sales', 'sales_manager', 'order_manager', 'merchandiser', 'admin'], {
      // 角色审计修:补 merchandiser(业务执行=真正接手一键建单的角色,含在 CAN_CREATE_ORDER),之前漏发
      type: isSample ? 'araos_sample_request' : 'araos_deal_won',
      title: `${isSample ? '🧵 araos 打样/寄样' : '🎉 araos 赢单'}:${customerName}`,
      message: `${dealBits || (isSample ? '新样单' : '新赢单')} —— 客户已${matchPath === 'created' ? '新建' : '匹配'}到系统。${isSample ? '请在报价/样单流程处理。' : '到「订单中心 · araos 待建单」一键建单(客户/款色/数量/PO原件已预填,补运营字段即可;生产链不自动建单)。'}${d.note ? ' 备注:' + d.note : ''}`,
      relatedOrderId: null,
    });

    // 6) 落收件箱(幂等键 upsert;error/received 态在此升级为 processed)
    await (svc.from('araos_handoffs_inbox') as any).upsert({
      araos_order_id: araosOrderId,
      araos_company_id: araosCompanyId || null,
      event_type: n.eventType,
      payload: body,
      status: 'processed',
      qimo_customer_id: customerId,
      customer_matched: matched,
      match_path: matchPath,
      processed_at: new Date().toISOString(),
      error: null,
    }, { onConflict: 'araos_order_id' });

    return NextResponse.json({
      schema_version: 'v1', ok: true, qimo_customer_id: customerId, customer_matched: matched, match_path: matchPath,
    });
  } catch (e: any) {
    // 失败落 error 态(可见/可重投),返回 5xx 让 araos 重试
    try {
      await (svc.from('araos_handoffs_inbox') as any).upsert({
        araos_order_id: araosOrderId, araos_company_id: araosCompanyId || null,
        event_type: n.eventType, payload: body, status: 'error',
        error: String(e?.message || e).slice(0, 500),
      }, { onConflict: 'araos_order_id' });
    } catch {}
    return fail('internal_error', 500, '建客户/通知失败,请重试');
  }
}
