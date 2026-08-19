'use server';

/**
 * 经销单「大货采购单」(2026-07-26)
 * 经销单(order_purpose='trade')买成品、无原辅料 → 采购核料 tab 隐藏。
 * 这里把成品款(order_line_items 的进价 purchase_unit_cost)物化成"成品大货"采购行
 * (category='成品大货', procurement_item_id=null,绕开原辅料专属逻辑),复用现有:
 *   业务建草稿 → 采购 placePurchaseOrder 下达 → 财务前置审批 → 建应付/付款计划(零改动)。
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { listSuppliers } from '@/app/actions/suppliers';
import { savePurchaseOrderProof } from '@/app/actions/purchase-orders';
// 单一来源:贸易单执行行的品类标记(Pilot 不变量按它识别合法例外)
import { TRADE_BULK_CATEGORY } from '@/lib/procurement/advance';

const CAN_CREATE = ['admin', 'sales', 'merchandiser', 'procurement', 'procurement_manager']; // 业务建
const CAN_PLACE = ['admin', 'procurement', 'procurement_manager'];                            // 采购下达

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, roles: [] as string[] };
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (p?.roles?.length > 0 ? p.roles : [p?.role].filter(Boolean)) as string[];
  return { supabase, user, roles };
}

export interface TradeBulkLine { id: string; style_no: string | null; color: string | null; qty: number; purchase_unit_cost: number | null; sale_unit_price: number | null; }

/** 经销单大货采购面板数据:成品款行 + 已建大货采购单 + 供应商 + 权限。 */
export async function getTradeBulkData(orderId: string): Promise<{
  isTrade?: boolean; lines?: TradeBulkLine[]; pos?: any[]; suppliers?: any[];
  canCreate?: boolean; canPlace?: boolean; canCost?: boolean; costTotal?: number; error?: string;
}> {
  const { supabase, user, roles } = await auth();
  if (!user) return { error: '请先登录' };

  // 订单级访问控制 + 成本/售价红线(P0 审计 2026-07-24:原来任何登录人可拉任意经销单的进价+客户售价)
  const { canUserAccessOrder } = await import('@/lib/domain/orderAccess');
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权查看此订单' };
  const { hasRoleInGroup } = await import('@/lib/domain/roles');
  const canCost = hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR') || hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS'); // 采购/财务可见进价
  const canSale = hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS');   // 客户售价仅财务口径可见

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_purpose').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };
  if ((order as any).order_purpose !== 'trade') return { isTrade: false };

  // 修:order_line_items 的颜色列是 color_cn/color_en,没有 color 列 —— 原来 select 'color' 整条查询报
  //   「column order_line_items.color does not exist」,error 被忽略 → 返 0 行 → 大货采购误显示"无成品款明细/未录进价"
  //   (实际明细和进价都在)。改用真实列名,color 取中文优先回落英文。
  const { data: liRows, error: liErr } = await (supabase.from('order_line_items') as any)
    .select('id, style_no, color_cn, color_en, qty_pcs, purchase_unit_cost, po_unit_price').eq('order_id', orderId);
  if (liErr) return { error: `读取逐款明细失败:${liErr.message}` };
  const lines: TradeBulkLine[] = ((liRows || []) as any[]).map((l) => ({
    id: l.id,
    style_no: l.style_no ?? null,
    color: l.color_cn || l.color_en || null,
    qty: Number(l.qty_pcs) || 0,
    purchase_unit_cost: canCost && l.purchase_unit_cost != null ? Number(l.purchase_unit_cost) : null,
    sale_unit_price: canSale && l.po_unit_price != null ? Number(l.po_unit_price) : null,
  }));
  const costTotal = canCost ? Math.round(lines.reduce((s, l) => s + (l.purchase_unit_cost || 0) * l.qty, 0) * 100) / 100 : 0;

  // 直查本单大货采购单;total_amount(采购花费)对非成本可见角色剥离
  const svc = createServiceRoleClient();
  const { data: pos } = await (svc.from('purchase_orders') as any)
    .select('id, po_no, status, approval_status, total_amount, order_proof_paths, supplier_id, suppliers(name)')
    .contains('order_ids', [orderId]).order('created_at', { ascending: false });
  const posOut = ((pos || []) as any[]).map((p) => ({ ...p, total_amount: canCost ? p.total_amount : null, supplier_name: p.suppliers?.name || null }));
  const suppliers = roles.some((r) => CAN_CREATE.includes(r)) ? (await listSuppliers()).data || [] : [];

  return {
    isTrade: true, lines, costTotal,
    pos: posOut,
    suppliers,
    canCreate: roles.some((r) => CAN_CREATE.includes(r)),
    canPlace: roles.some((r) => CAN_PLACE.includes(r)),
    canCost,   // 能看进价的角色(采购/财务/admin)→ 大货采购页可直接录进价
  };
}

/**
 * 直接在大货采购页录/改逐款成品进价(2026-07-26 CEO:不该踢去生产任务单填)。
 * 写 order_line_items.purchase_unit_cost;仅能看底价的角色(采购/财务/admin)可改。已建采购单不影响(改的是明细成本源)。
 */
export async function saveTradeLineCosts(
  orderId: string,
  updates: Array<{ id: string; purchase_unit_cost: number | null }>,
): Promise<{ ok?: boolean; updated?: number; error?: string }> {
  const { supabase, user, roles } = await auth();
  if (!user) return { error: '请先登录' };
  const { canUserAccessOrder } = await import('@/lib/domain/orderAccess');
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权操作此订单' };
  const { hasRoleInGroup } = await import('@/lib/domain/roles');
  const canCost = hasRoleInGroup(roles, 'CAN_SEE_PROCUREMENT_FLOOR') || hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS');
  if (!canCost) return { error: '仅采购/财务/管理员可录入成品进价' };
  const clean = (updates || []).filter((u) => u && u.id);
  if (clean.length === 0) return { ok: true, updated: 0 };
  for (const u of clean) {
    if (u.purchase_unit_cost != null && (!Number.isFinite(u.purchase_unit_cost) || u.purchase_unit_cost < 0)) {
      return { error: '进价必须是 ≥0 的数字' };
    }
  }
  // service-role 写(canCost 已门禁);逐行按 id+order_id 更新,防跨单误改
  const svc = createServiceRoleClient();
  let updated = 0;
  for (const u of clean) {
    const { data, error } = await (svc.from('order_line_items') as any)
      .update({ purchase_unit_cost: u.purchase_unit_cost, updated_at: new Date().toISOString() })
      .eq('id', u.id).eq('order_id', orderId).select('id');
    if (error) return { error: `保存进价失败:${error.message}` };
    updated += (data || []).length;
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, updated };
}

/** 业务建大货采购单草稿:成品款→成品大货采购行 + 采购单(draft)。下达由采购走 placePurchaseOrder。 */
export async function createTradeBulkPurchaseOrder(orderId: string, input: {
  supplierId: string; paymentTerms?: string; deliveryDate?: string;
}): Promise<{ poId?: string; poNo?: string; error?: string }> {
  const { supabase, user, roles } = await auth();
  if (!user) return { error: '请先登录' };
  if (!roles.some((r) => CAN_CREATE.includes(r))) return { error: '仅业务/采购/管理员可建大货采购单' };
  if (!input.supplierId) return { error: '请选择供应商' };

  const { data: order } = await (supabase.from('orders') as any)
    .select('id, order_purpose, order_no, internal_order_no').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };
  if ((order as any).order_purpose !== 'trade') return { error: '仅经销单可建大货采购单' };

  const svc = createServiceRoleClient();

  // 防重:本单已有未作废的大货采购单 → 不再重复建(避免同一批成品重复采购/重复应付)
  const { data: existPos } = await (svc.from('purchase_orders') as any)
    .select('id, po_no, status').contains('order_ids', [orderId]);
  const activeExist = ((existPos || []) as any[]).some((p) => p.status !== 'cancelled');
  if (activeExist) return { error: '本单已有大货采购单(如需拆供应商/改单,请先作废原单再建)' };

  // 读成品款(进价>0、数量>0 才入采购)。修:颜色列是 color_cn/color_en,没有 color 列 ——
  //   原来 select 'color' 报错被忽略 → buyable 恒空 → 误报"没有可采购的成品款"(实际明细/进价都在)。
  const { data: liRows, error: liReadErr } = await (svc.from('order_line_items') as any)
    .select('style_no, color_cn, color_en, qty_pcs, purchase_unit_cost').eq('order_id', orderId);
  if (liReadErr) return { error: `读取逐款明细失败:${liReadErr.message}` };
  const buyable = ((liRows || []) as any[])
    .map((l) => ({ style_no: l.style_no || '成品', color: l.color_cn || l.color_en || null, qty: Number(l.qty_pcs) || 0, cost: l.purchase_unit_cost != null ? Number(l.purchase_unit_cost) : 0 }))
    .filter((l) => l.qty > 0 && l.cost > 0);
  if (buyable.length === 0) return { error: '没有可采购的成品款:请先在订单逐款录入采购进价(purchase_unit_cost)和数量' };

  // 供应商名(冗余上行,队列直读)
  const { data: sup } = await (svc.from('suppliers') as any).select('name').eq('id', input.supplierId).maybeSingle();
  const supplierName = (sup as any)?.name || null;

  // 1) 物化成品大货采购行(procurement_item_id=null → 绕开原辅料 needs_reconfirm/布料折叠)
  const lineRows = buyable.map((l) => ({
    order_id: orderId,
    material_name: `${l.style_no}${l.color ? `·${l.color}` : ''} (成品大货)`,
    category: TRADE_BULK_CATEGORY,
    ordered_qty: l.qty,
    ordered_unit: '件',
    unit_price: l.cost,       // ordered_amount = qty×unit_price 由 DB 生成列自动算
    // 修(2026-08-16):此前写 'active' —— 这个值**从来不在** line_status 的 CHECK 枚举里
    //   (draft/pending_order/ordered/confirmed/in_production/ready_to_ship/shipped/arrived/
    //    accepted/concession/rejected/closed/cancelled),所以「生成大货采购单」从上线起
    //   每次都撞 procurement_line_items_line_status_check,一单都没建成过。
    // 用 pending_order 而不是 draft:采购中心队列的 PRE_ARRIVAL_STATUSES 不含 draft
    //   (lib/services/procurement-matters.service.ts),写 draft 这批行会从采购中心静默消失,
    //   采购根本不知道要去下达 —— 那是把报错换成更难查的"看不见"。
    //   pending_order = 待下单桶 + 有红黄绿灯监控;placeCore 下达时 pending_order → ordered。
    line_status: 'pending_order',
    procurement_item_id: null,
    supplier_name: supplierName,
    supplier_id: input.supplierId,
  }));
  let { data: insertedLines, error: liErr } = await (svc.from('procurement_line_items') as any).insert(lineRows).select('id, ordered_amount');
  // 降级兜底:supplier_id 外键若指错表,去掉它重试(供应商真相在采购单头)。
  // 2026-08-17:外键原本指向 factories,而这里传的是 suppliers.id → 每次都命中这条降级,
  //   结果采购行的 supplier_id 恒为空(20260703 那个 repoint 迁移从没跑成功过,
  //   见 supabase/migrations/20260817_supplier_fkey_repoint_redo.sql)。外键已改指 suppliers,
  //   正常路径不再进这里;保留它纯粹当防御,别再把"没有 supplier_id"当成正常现象。
  if (liErr && /supplier_id_fkey|foreign key/i.test(liErr.message || '')) {
    const degraded = lineRows.map(({ supplier_id, ...rest }) => rest);
    ({ data: insertedLines, error: liErr } = await (svc.from('procurement_line_items') as any).insert(degraded).select('id, ordered_amount'));
  }
  if (liErr) return { error: '生成大货采购行失败:' + liErr.message };
  const lineIds = ((insertedLines || []) as any[]).map((r) => r.id);
  const total = Math.round(((insertedLines || []) as any[]).reduce((s, r) => s + (Number(r.ordered_amount) || 0), 0) * 100) / 100;

  // 2) 建采购单(draft),po_no = PO-YYYYMMDD-NNN(取当天最大序号+1,冲突自增重试)
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const poPrefix = `PO-${today}-`;
  const nextSeq = async (bump: number): Promise<string> => {
    const { data: ex } = await (svc.from('purchase_orders') as any).select('po_no').like('po_no', `${poPrefix}%`);
    let maxN = 0;
    for (const r of (ex || []) as any[]) { const m = /-(\d+)$/.exec(String(r.po_no || '')); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); }
    return `${poPrefix}${String(maxN + 1 + bump).padStart(3, '0')}`;
  };
  let po: any = null, poErr: any = null, poNo = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    poNo = await nextSeq(attempt);
    const res = await (svc.from('purchase_orders') as any).insert({
      po_no: poNo, supplier_id: input.supplierId, order_ids: [orderId], status: 'draft',
      total_amount: total, payment_terms: input.paymentTerms || null,
      delivery_date: input.deliveryDate || null, created_by: user.id,
      notes: '经销单大货采购(成品)',
    }).select('id').single();
    po = res.data; poErr = res.error;
    if (!poErr) break;
    if (!/po_no_key|duplicate key/i.test(poErr.message || '')) break;
  }
  if (poErr) {
    // 采购单建失败 → 回滚刚建的采购行,避免留孤儿
    await (svc.from('procurement_line_items') as any).delete().in('id', lineIds);
    return { error: '建大货采购单失败:' + poErr.message };
  }
  const poId = (po as any).id;

  // 3) 归行到单
  await (svc.from('procurement_line_items') as any)
    .update({ purchase_order_id: poId }).in('id', lineIds);

  revalidatePath(`/orders/${orderId}`);
  return { poId, poNo };
}

/**
 * 修改草稿大货采购单的供应商(2026-08-19 CEO 要求)。
 *
 * 边界:
 * · 仅 status='draft' 可改 —— 已下达的单供应商是既成商业事实,改走 删除重建/退货。
 * · 若已提交财务前置审批(approval_status='pending'):供应商一变,财务批的对象就失效,
 *   重置 approval_status=null,下达时按新供应商重新走审批(place 会重新评估)。
 * · 单头 + 本单全部执行行的 supplier_id/supplier_name 同步改(供应商真相在两处都有读者)。
 * · A2 审计留痕(money):改供应商 = 改钱要付给谁。
 */
export async function changeTradePoSupplier(orderId: string, poId: string, supplierId: string): Promise<{ ok?: boolean; error?: string; supplierName?: string }> {
  const { user, roles } = await auth();
  if (!user) return { error: '请先登录' };
  if (!roles.some((r) => CAN_PLACE.includes(r) || CAN_CREATE.includes(r))) return { error: '无权修改供应商' };
  if (!supplierId) return { error: '请选择供应商' };

  const { readTradePoForSupplierChange, readSupplierName, syncPoLinesSupplier } = await import('@/lib/repositories/purchaseOrdersRepo');
  const { po, error: poErr } = await readTradePoForSupplierChange(poId);
  if (poErr) return { error: poErr };
  if (!po) return { error: '采购单不存在' };
  if (po.status !== 'draft') return { error: '仅草稿状态可改供应商;已下达的单请删除重建或走退货' };
  if (po.supplierId === supplierId) return { ok: true };

  const supRead = await readSupplierName(supplierId);
  if (supRead.error) return { error: supRead.error };
  if (!supRead.exists) return { error: '供应商不存在,请先在「供应商」里创建' };
  const supplierName = supRead.name;

  const svc = createServiceRoleClient();
  const wasPending = po.approvalStatus === 'pending';
  // 高危写走 safeMutation(lint:writes):断言恰好 1 行生效 —— CAS(status='draft')没命中
  // (并发已下达/单不存在)时要报错,而不是静默 0 行让人以为改成功了。
  const { safeMutation } = await import('@/lib/db/safe-mutation');
  const w = await safeMutation({
    client: svc, table: 'purchase_orders', operation: 'update',
    payload: {
      supplier_id: supplierId,
      ...(wasPending ? { approval_status: null, approval_reasons: null } : {}),
      updated_at: new Date().toISOString(),
    },
    predicate: { id: poId, status: 'draft' },   // CAS:防并发下达后被改
  });
  if (!(w as any).ok) return { error: `供应商修改未生效(${(w as any).status}):${(w as any).error || '可能已被下达'}` };

  // 行同步:本单全部执行行(供应商真相单头/行两处都有读者,不同步会出现单头新行旧)
  const liSync = await syncPoLinesSupplier(poId, supplierId, supplierName);
  if (liSync.error) return { error: '单头已改,但执行行供应商同步失败:' + liSync.error };

  try {
    const { writeAuditEvent } = await import('@/lib/audit/write-audit-event');
    await writeAuditEvent({
      eventType: 'trade_po_supplier_changed', level: 'A2', riskLevel: 'money',
      actor: { actorType: 'user', actorId: user.id },
      entity: { entityType: 'purchase_order', entityId: poId, orderId },
      commandName: 'changeTradePoSupplier',
      reason: wasPending ? '草稿改供应商;原财务审批作废,下达时重新评估' : '草稿改供应商',
      beforeState: { supplier_id: po.supplierId },
      afterState: { supplier_id: supplierId, supplier_name: supplierName },
    } as any);
  } catch { /* 审计失败不回滚业务改动 */ }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true, supplierName };
}

/** 上传大货采购单的下单凭证(给供应商的下单截图/回单),下达前必传。base64 上传到 order-docs → 存路径。 */
export async function uploadTradePoProof(orderId: string, poId: string, fileBase64: string, fileName: string): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, user, roles } = await auth();
  if (!user) return { error: '请先登录' };
  if (!roles.some((r) => CAN_PLACE.includes(r) || CAN_CREATE.includes(r))) return { error: '无权上传凭证' };
  try {
    const ext = (fileName.split('.').pop() || 'bin').toLowerCase();
    const path = `${orderId}/trade-po/${poId}_${Date.now()}.${ext}`;
    const bin = Buffer.from(fileBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    // contentType 必须显式给(2026-08-18 修):传 Buffer 时 supabase-js 默认标成
    // text/plain;charset=UTF-8,而 order-docs 桶的白名单没有它 →
    // 「上传失败:mime type text/plain;charset=UTF-8 is not supported」,凭证永远传不上。
    // 全站其它 8 处上传都传了 contentType,只有这里漏了。
    // 取值优先级:data URL 自带的 MIME(浏览器给的最准)→ 按扩展名兜底 → 八进制流。
    const dataUrlMime = /^data:([^;]+);base64,/.exec(fileBase64)?.[1] || null;
    const EXT_MIME: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      pdf: 'application/pdf',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
      doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const contentType = dataUrlMime || EXT_MIME[ext] || 'application/octet-stream';
    const { error: upErr } = await supabase.storage.from('order-docs').upload(path, bin, { contentType, upsert: false });
    if (upErr) return { error: `上传失败:${upErr.message}` };
    // 合并已有凭证路径
    const svc = createServiceRoleClient();
    const { data: cur } = await (svc.from('purchase_orders') as any).select('order_proof_paths').eq('id', poId).maybeSingle();
    const prev: string[] = Array.isArray((cur as any)?.order_proof_paths) ? (cur as any).order_proof_paths : [];
    const res = await savePurchaseOrderProof(poId, [...prev, path]);
    if (res.error) return { error: res.error };
    revalidatePath(`/orders/${orderId}`);
    return { ok: true };
  } catch (e: any) {
    return { error: e?.message || '上传异常' };
  }
}
