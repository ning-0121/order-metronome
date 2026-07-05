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

export const dynamic = 'force-dynamic';

const ROUTE_PATH = '/api/contract/v1/handoff/araos';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code: string, status: number, message?: string) {
  return NextResponse.json({ schema_version: 'v1', error: { code, message: message ?? code } }, { status });
}

interface HandoffCustomer {
  name?: string; company_name?: string; contact_name?: string; email?: string; phone?: string; country?: string;
}
interface HandoffBody {
  event_type?: string;
  araos_order_id?: string;
  araos_company_id?: string;
  customer?: HandoffCustomer;
  deal?: { po_number?: string; style?: string; quantity?: number; target_delivery?: string; currency?: string; note?: string };
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

  // 2) 解析 + 校验必填
  let body: HandoffBody;
  try { body = JSON.parse(rawBody || '{}'); } catch { return fail('invalid_body', 400, 'body 非合法 JSON'); }
  const araosOrderId = (body.araos_order_id || '').trim();
  const customerName = (body.customer?.name || '').trim();
  if (!araosOrderId) return fail('invalid_body', 400, '缺 araos_order_id(幂等键)');
  if (!customerName) return fail('invalid_body', 400, '缺 customer.name');

  const araosCompanyId = (body.araos_company_id || '').trim();
  const sourceUuid = UUID_RE.test(araosCompanyId) ? araosCompanyId : null; // source_araos_company_id 为 uuid 列
  const svc = createServiceRoleClient();

  try {
    // 3) 幂等:已处理过 → 直接返回已存结果(不重复建客户/不重复通知)
    const { data: existing } = await (svc.from('araos_handoffs_inbox') as any)
      .select('status, qimo_customer_id, customer_matched, match_path').eq('araos_order_id', araosOrderId).maybeSingle();
    if (existing?.status === 'processed' && existing.qimo_customer_id) {
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
        company_name: body.customer?.company_name || null,
        contact_name: body.customer?.contact_name || null,
        email: body.customer?.email || null,
        phone: body.customer?.phone || null,
        country: body.customer?.country || null,
        source_araos_company_id: sourceUuid,
      };
      const { data: created, error: cErr } = await (svc.from('customers') as any)
        .insert(insert).select('id').single();
      if (cErr || !created?.id) throw new Error('客户建立失败:' + (cErr?.message || 'unknown'));
      customerId = created.id; matchPath = 'created';
    }

    // 5) 通知业务:赢单来建单(不自动建单)
    const d = body.deal || {};
    const dealBits = [
      d.po_number ? `PO ${d.po_number}` : null,
      d.style ? `款 ${d.style}` : null,
      d.quantity ? `${d.quantity} 件` : null,
      d.target_delivery ? `交期 ${String(d.target_delivery).slice(0, 10)}` : null,
    ].filter(Boolean).join(' · ');
    await notifyUsersByRole(svc, ['sales', 'sales_manager', 'order_manager', 'admin'], {
      type: 'araos_deal_won',
      title: `🎉 araos 赢单:${customerName}`,
      message: `${dealBits || '新赢单'} —— 客户已${matchPath === 'created' ? '新建' : '匹配'}到系统,请在报价/建单流程录 PO 建单(生产链不自动建单)。${d.note ? ' 备注:' + d.note : ''}`,
      relatedOrderId: null,
    });

    // 6) 落收件箱(幂等键 upsert;error/received 态在此升级为 processed)
    await (svc.from('araos_handoffs_inbox') as any).upsert({
      araos_order_id: araosOrderId,
      araos_company_id: araosCompanyId || null,
      event_type: body.event_type || 'deal_won',
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
        event_type: body.event_type || 'deal_won', payload: body, status: 'error',
        error: String(e?.message || e).slice(0, 500),
      }, { onConflict: 'araos_order_id' });
    } catch {}
    return fail('internal_error', 500, '建客户/通知失败,请重试');
  }
}
