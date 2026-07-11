// POST /api/contract/v1/products —— araos 打样「建立产品信息」写入共享产品库。
// 仅 araos 消费者(HMAC + body hash)。service role 建 products(+多角度图) + product_definitions v1
// + product_bom_templates(引用采购部 material_master 的面料/辅料)。全 OS 共用同一款/同一物料。
// araos 永不写价：本端点不接收/不落任何价格。
import { NextResponse } from 'next/server';
import { verifyContractRequest, sha256Hex } from '../_lib/auth';
import { fail } from '../_lib/response';
import { createServiceRoleClient } from '@/lib/supabase/server';

interface BomLine {
  material_master_id?: string | null;
  material_name?: string;
  category?: string;      // 采购分类(fabric/trim/…)
  bom_role?: string;      // main_fabric/lining/trim/packing/print/embroidery/washing/service/other
  unit?: string;
  consumption?: number | null;
  color?: string;
  placement?: string;
  special_requirements?: string;
}
const VALID_ROLE = new Set(['main_fabric', 'lining', 'trim', 'packing', 'print', 'embroidery', 'washing', 'service', 'other']);

export async function POST(request: Request) {
  const url = new URL(request.url);
  const path = url.pathname + (url.search || '');
  const rawBody = await request.text();
  const auth = verifyContractRequest({
    method: 'POST', path,
    apiKey: request.headers.get('x-api-key'),
    timestamp: request.headers.get('x-timestamp'),
    signature: request.headers.get('x-signature'),
    now: Date.now(),
    bodyHash: sha256Hex(rawBody),
  });
  if (!auth.ok) return fail(auth.code, auth.status);
  if (auth.keyId !== 'araos') return fail('insufficient_scope', 403, '仅限 araos 消费者');

  let body: any;
  try { body = JSON.parse(rawBody || '{}'); } catch { return fail('invalid_body', 400, 'body 非合法 JSON'); }

  const product_name = String(body.product_name || '').trim();
  if (!product_name) return fail('invalid_body', 400, '缺 product_name');
  const image_urls: string[] = Array.isArray(body.image_urls) ? body.image_urls.filter((u: any) => typeof u === 'string').slice(0, 12) : [];
  const bom: BomLine[] = Array.isArray(body.bom) ? body.bom : [];

  const svc = createServiceRoleClient();
  try {
    // 1) 建款（新列未迁移时降级重试，不带 image_urls/created_via/source_ref）
    const core = {
      product_code: String(body.product_code || '').trim() || null,
      product_name,
      category: body.category || null,
      brand: body.brand || null,
      target_customer: body.target_customer || null,
      season: body.season || null,
      status: 'developing',
    };
    let ins = await (svc.from('products') as any).insert({ ...core, image_urls, created_via: 'araos', source_ref: body.source_ref || null }).select('id, product_code').single();
    if (ins.error && /image_urls|created_via|source_ref|column/i.test(ins.error.message || '')) {
      ins = await (svc.from('products') as any).insert(core).select('id, product_code').single();
    }
    const p = ins.data;
    if (ins.error || !p) return fail('internal_error', 500, ins.error?.message || '建款失败');

    // 2) 建 v1 定义(草稿)
    const { data: def } = await (svc.from('product_definitions') as any)
      .insert({ product_id: p.id, version: 1, status: 'draft' }).select('id').single();

    // 3) BOM 模板行(引用 material_master)
    if (def?.id && bom.length) {
      const rows = bom.filter((b) => b.material_name || b.material_master_id).map((b) => ({
        definition_id: def.id,
        material_master_id: b.material_master_id || null,
        material_name: b.material_name || null,
        category: b.category || null,
        bom_role: VALID_ROLE.has(String(b.bom_role)) ? b.bom_role : 'other',
        unit: b.unit || null,
        development_consumption: typeof b.consumption === 'number' ? b.consumption : null,
        default_color: b.color || null,
        default_placement: b.placement || null,
        special_requirements: b.special_requirements || null,
      }));
      if (rows.length) await (svc.from('product_bom_templates') as any).insert(rows);
    }

    return NextResponse.json({ schema_version: 'v1', ok: true, qimo_product_id: p.id, product_code: p.product_code });
  } catch (e: any) {
    return fail('internal_error', 500, e?.message || '写入失败');
  }
}
