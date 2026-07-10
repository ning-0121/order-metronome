// ============================================================
// GET /api/integration/order-attachments/{orderNo}
// 财务系统拉取某订单的附件列表(F2 方案A:on-demand 拉取,总是最新)。
// 附件在节拍器私有桶 order-docs;这里逐个签发【即时签名 URL(1h)】返回,财务不存过期链接。
// 鉴权同 /api/integration/orders/{orderNo}(verifyInboundGet,签名串 "GET:{orderNo}:{ts}")。只读、service-role。
// ============================================================

import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { verifyInboundGet } from '@/lib/integration/inbound-auth';

export async function GET(request: Request, ctx: { params: Promise<{ orderNo: string }> }) {
  const { orderNo } = await ctx.params;
  const decoded = decodeURIComponent(orderNo || '');

  const auth = verifyInboundGet(request, decoded);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: auth.status });
  if (!decoded || !/^[A-Za-z0-9._-]+$/.test(decoded)) return NextResponse.json({ error: 'bad_order_no' }, { status: 400 });

  try {
    const supabase = createServiceRoleClient();
    // 按 order_no 或 internal_order_no 命中订单
    const { data: order } = await (supabase.from('orders') as any)
      .select('id')
      .or(`order_no.eq.${decoded},internal_order_no.eq.${decoded}`)
      .limit(1)
      .maybeSingle();
    if (!order?.id) return NextResponse.json({ data: [] });

    const { data: atts, error } = await (supabase.from('order_attachments') as any)
      .select('id, file_name, file_type, mime_type, file_size, storage_path, file_url, created_at')
      .eq('order_id', order.id)
      .order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // 逐个签发即时签名 URL(1h)。storage_path 优先;老数据从 file_url 反解;都无则回退 file_url。
    const out = [];
    for (const a of atts || []) {
      let path: string | null = a.storage_path || null;
      if (!path && a.file_url) {
        try { const u = new URL(a.file_url); const m = u.pathname.match(/order-docs\/(.+)$/); if (m) path = decodeURIComponent(m[1]); } catch { /* ignore */ }
      }
      let url: string | null = a.file_url || null;
      if (path) {
        const { data: signed } = await supabase.storage.from('order-docs').createSignedUrl(path, 3600);
        if (signed?.signedUrl) url = signed.signedUrl;
      }
      out.push({
        id: a.id,
        file_name: a.file_name || '未命名',
        file_type: a.file_type || null,
        mime_type: a.mime_type || null,
        file_size: a.file_size ?? null,
        url,
        created_at: a.created_at,
      });
    }
    return NextResponse.json({ data: out });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'internal_error' }, { status: 500 });
  }
}
