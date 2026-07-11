'use server';

/**
 * 订单逐款明细(order_line_items)存取 —— S1 富录入表。
 * 形状:styles[{ style_no, product_name, image_url, fabric_name/width/consumption/unit, colors:[{color_cn,color_en,sizes:{S:qty},qty,remark}] }]
 * 与 createOrder 的 line_items 形状一致;喂生产任务单 / 客户 PI。整单替换(删旧插新)。
 * S1.2:每款布料自动同步成该款 BOM 第一行(materials_bom, source='line_items_sync')。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { syncStyleFabricsToBom } from '@/lib/services/style-fabric-sync';
import { normalizeStyleFabrics, primaryFabricColumns } from '@/lib/services/style-fabrics';
import { canUserAccessOrder } from '@/lib/domain/orderAccess';
import { hasRoleInGroup } from '@/lib/domain/roles';

/** 取当前用户角色 + 是否可见客户成交价(CAN_SEE_FINANCIALS)。 */
async function financialsVisibility(supabase: any, userId: string): Promise<{ roles: string[]; canSeeFin: boolean }> {
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', userId).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return { roles, canSeeFin: hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS') };
}

/** 读 AI 原始识别冻结底档(建单时 PO 解析原文)。 */
export async function getPoParseSnapshot(orderId: string): Promise<{ snapshot?: any; at?: string | null; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权查看此订单' };
  const { data, error } = await (supabase.from('orders') as any)
    .select('po_parse_snapshot, po_parse_snapshot_at').eq('id', orderId).maybeSingle();
  if (error) return { error: error.message };
  return { snapshot: (data as any)?.po_parse_snapshot ?? null, at: (data as any)?.po_parse_snapshot_at ?? null };
}

/** 再冻结:用当前逐款明细覆盖冻结底档(业务纠正后固化)。权限同 saveOrderLineItems。 */
export async function refreezePoParseSnapshot(orderId: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: order } = await (supabase.from('orders') as any).select('created_by, owner_user_id').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const canEdit = roles.includes('admin')
    || (order as any).created_by === user.id || (order as any).owner_user_id === user.id
    || roles.some((r) => ['order_manager', 'sales_manager', 'admin_assistant'].includes(r))
    // 审计 P0:跟单不再全局放行,须与该订单相关(创建者/负责人/被指派人)
    || (roles.includes('merchandiser') && await canUserAccessOrder(supabase, user.id, orderId));
  if (!canEdit) return { error: '无权操作(仅创建者/负责人/被指派跟单/理单/管理员)' };

  const res = await getOrderLineItems(orderId);
  if ((res as any).error) return { error: (res as any).error };
  const styles = (res as any).data || [];
  const snapshot = { styles, _refrozen: true };
  const { error } = await (supabase.from('orders') as any)
    .update({ po_parse_snapshot: snapshot, po_parse_snapshot_at: new Date().toISOString() }).eq('id', orderId);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 读订单明细 → 按款分组返回。 */
export async function getOrderLineItems(orderId: string): Promise<{ data?: any[]; sizeOrder?: string[] | null; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权查看此订单' };
  // 尺码列手排顺序(业务在富录入表拖排);为空则前端回落标准自动排序
  const { data: ord } = await (supabase.from('orders') as any).select('size_order').eq('id', orderId).maybeSingle();
  const sizeOrder: string[] | null = Array.isArray((ord as any)?.size_order) ? (ord as any).size_order : null;
  // 客户成交价(po_unit_price)红线:仅 CAN_SEE_FINANCIALS 可读,server 端剥离(生产/QC/物流看生产任务单不含此列)
  const { canSeeFin } = await financialsVisibility(supabase, user.id);
  // select * :双语/箱数列(20260703 迁移)未执行时也不报缺列
  const { data, error } = await (supabase.from('order_line_items') as any)
    .select('*').eq('order_id', orderId).order('line_no', { ascending: true });
  if (error) return { error: error.message };

  const map = new Map<string, any>();
  for (const r of (data || [])) {
    const key = `${r.style_no || ''}¦${r.product_name || ''}`;
    let st = map.get(key);
    if (!st) {
      st = {
        style_no: r.style_no || '', product_name: r.product_name || '',
        product_name_en: r.product_name_en || '', image_url: r.image_url || '',
        fabric_name: r.fabric_name || '', fabric_width: r.fabric_width || '',
        fabric_consumption: r.fabric_consumption ?? '', fabric_unit: r.fabric_unit || 'kg',
        fabrics: normalizeStyleFabrics(r),   // 多布料:优先 fabrics 列,缺则由旧 fabric_* 合成单条
        set_multiplier: Number(r.set_multiplier) > 0 ? Number(r.set_multiplier) : 1,  // 套装每套件数(1=非套装)
        ...(canSeeFin ? { po_unit_price: r.po_unit_price ?? '' } : {}),   // 客户成交价(款级,仅财务口径可见)
        colors: [],
      };
      map.set(key, st);
    }
    if (!st.image_url && r.image_url) st.image_url = r.image_url;
    if (!st.product_name_en && r.product_name_en) st.product_name_en = r.product_name_en;
    if (!st.fabric_name && r.fabric_name) {
      st.fabric_name = r.fabric_name; st.fabric_width = r.fabric_width || '';
      st.fabric_consumption = r.fabric_consumption ?? ''; st.fabric_unit = r.fabric_unit || 'kg';
    }
    if (canSeeFin && (st.po_unit_price === '' || st.po_unit_price == null) && r.po_unit_price != null) st.po_unit_price = r.po_unit_price;
    if ((!st.fabrics || st.fabrics.length === 0)) {   // 款级同值写每行:布料在任一行齐了就采纳
      const f = normalizeStyleFabrics(r);
      if (f.length > 0) st.fabrics = f;
    }
    st.colors.push({ color_cn: r.color_cn || '', color_en: r.color_en || '', sizes: r.sizes || {}, qty: Number(r.qty_pcs) || 0, remark: r.remark || '', carton_count: r.carton_count ?? '' });
  }
  return { data: [...map.values()], sizeOrder };
}

/**
 * 步骤2b:客户订单 Excel(合同/生产单式)→ 零 token 解析 → 归组成富录入表 Style[] 形状。
 * 只返回款/色/尺码/数量(不带价),天然无泄价;不写库 —— 业务在富录入表预览、核对、改后再保存。
 * 权限:业务/理单/跟单/管理员(生产/QC 不解析客户订单)。
 */
export async function parseOrderFile(base64: string): Promise<{
  styles?: any[]; sizeNames?: string[]; headerRow?: number; note?: string; error?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const allowed = ['admin', 'sales', 'order_manager', 'sales_manager', 'admin_assistant', 'merchandiser'];
  if (!roles.some((r) => allowed.includes(r))) return { error: '无权解析客户订单文件(仅业务/理单/跟单/管理员)' };

  try {
    const buf = Buffer.from(base64.replace(/^data:.*base64,/, ''), 'base64');
    // 统一走 SheetJS:exceljs 读不了老 .xls(BIFF)会静默返回空表 → 客户订单被读成空。
    const { readFirstSheetRows } = await import('@/lib/services/excel-read');
    const rows = readFirstSheetRows(buf);
    if (rows.length === 0) return { error: '空文件' };
    const { parseOrderSheet } = await import('@/lib/services/order-sheet-parser');
    const res = parseOrderSheet(rows);
    if (res.headerRow === -1) return { error: '没识别到尺码表头(需含 S/M/L 或 XS-XXL 等尺码列)。请确认上传的是含尺码数量的客户订单/生产单。' };
    if (res.lines.length === 0) return { error: '识别到表头但没读到订单行,请检查文件或手工录入兜底。' };

    // 归组:每款一个 Style,同款多色汇入 colors[]。解析出的 color 落 color_cn。
    // 客户成交价(po_unit_price,款级)仅带给可见财务的角色;解析出即预填,人在录入表确认后保存冻结。
    const canSeeFin = hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS');
    const map = new Map<string, any>();
    for (const l of res.lines) {
      const key = l.style_no || '（未识别款号）';
      let st = map.get(key);
      if (!st) {
        st = { style_no: l.style_no || '', product_name: '', image_url: '', fabric_name: '', fabric_width: '', fabric_consumption: '', fabric_unit: 'kg', ...(canSeeFin ? { po_unit_price: '' } : {}), colors: [] };
        map.set(key, st);
      }
      // 款级单价:取该款首个非空解析价(客户 PO 常一款一价)
      if (canSeeFin && (st.po_unit_price === '' || st.po_unit_price == null) && l.unit_price != null) st.po_unit_price = l.unit_price;
      st.colors.push({ color_cn: l.color || '', color_en: l.color_ref || '', sizes: l.sizes || {}, qty: l.qty_total || 0, remark: '' });
    }
    return { styles: [...map.values()], sizeNames: res.sizeNames, headerRow: res.headerRow, note: res.note };
  } catch (e) {
    return { error: '解析失败:' + (e instanceof Error ? e.message : String(e)) + '。可手工录入兜底。' };
  }
}

/** 轻量取订单尺码列手排顺序(供下游客户端组件排序用;无值/列缺失返回 null)。 */
export async function getOrderSizeOrder(orderId: string): Promise<{ sizeOrder?: string[] | null; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  if (!(await canUserAccessOrder(supabase, user.id, orderId))) return { error: '无权查看此订单' };
  const { data } = await (supabase.from('orders') as any).select('size_order').eq('id', orderId).maybeSingle();
  return { sizeOrder: Array.isArray((data as any)?.size_order) ? (data as any).size_order : null };
}

/** 整单替换订单明细(删旧插新)。权限:管理员/理单类角色/该单创建者·负责人。 */
export async function saveOrderLineItems(orderId: string, styles: any[], sizeOrder?: string[] | null): Promise<{ ok?: boolean; styles?: number; lines?: number; total?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: order } = await (supabase.from('orders') as any).select('created_by, owner_user_id').eq('id', orderId).maybeSingle();
  if (!order) return { error: '订单不存在' };
  const { data: profile } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const canEdit = roles.includes('admin')
    || (order as any).created_by === user.id
    || (order as any).owner_user_id === user.id
    || roles.some((r) => ['order_manager', 'sales_manager', 'admin_assistant'].includes(r))
    // 审计 P0:跟单不再全局放行,须与该订单相关(创建者/负责人/被指派人)
    || (roles.includes('merchandiser') && await canUserAccessOrder(supabase, user.id, orderId));
  if (!canEdit) return { error: '无权编辑该订单明细(仅创建者/负责人/被指派跟单/理单/管理员)' };

  // 客户成交价(po_unit_price)红线:仅 CAN_SEE_FINANCIALS 可写;其他角色(如生产编辑生产任务单)保存时
  // 保留库里旧值,绝不用被剥离的空值抹掉(server 端读时已剥离 → 提交里本就没有此字段)。
  const canSeeFin = hasRoleInGroup(roles, 'CAN_SEE_FINANCIALS');
  const existingPrice = new Map<string, number>();
  if (!canSeeFin) {
    const { data: old } = await (supabase.from('order_line_items') as any).select('style_no, po_unit_price').eq('order_id', orderId);
    for (const o of (old || [])) { const k = (o.style_no || '').trim(); if (o.po_unit_price != null && !existingPrice.has(k)) existingPrice.set(k, Number(o.po_unit_price)); }
  }

  // 组装行:每款每色一行,qty = Σsizes;布料字段款级同值写每行
  const rows: any[] = [];
  let lineNo = 0;
  for (const st of (styles || [])) {
    const submittedPrice = st?.po_unit_price === '' || st?.po_unit_price == null ? null : Number(st.po_unit_price);
    const poUnitPrice = canSeeFin
      ? (submittedPrice != null && !isNaN(submittedPrice) ? submittedPrice : null)   // 财务口径角色:用提交值
      : (existingPrice.get((st?.style_no || '').trim()) ?? null);                     // 其他角色:保留旧值
    const fabrics = normalizeStyleFabrics(st);                 // 多布料(优先 fabrics,缺则旧 fabric_* 合成)
    const prim = primaryFabricColumns(fabrics);                // 第一条镜像回旧列做兼容
    for (const c of (st?.colors || [])) {
      lineNo++;
      const sizesIn = c?.sizes || {};
      const sizes: Record<string, number> = {};
      let qty = 0;
      for (const [k, v] of Object.entries(sizesIn)) {
        const n = Number(v) || 0;
        if (n > 0) { sizes[k] = n; qty += n; }
      }
      const cartons = c?.carton_count === '' || c?.carton_count == null ? null : Number(c.carton_count);
      rows.push({
        order_id: orderId, line_no: lineNo,
        style_no: st?.style_no?.trim() || null, product_name: st?.product_name?.trim() || null,
        product_name_en: st?.product_name_en?.trim() || null,     // 款式英文描述(双语)
        color_cn: c?.color_cn?.trim() || null, color_en: c?.color_en?.trim() || null,
        sizes, unit: 'pcs', set_multiplier: Number(st?.set_multiplier) > 0 ? Number(st.set_multiplier) : 1,
        qty_pcs: qty || null, qty_raw: qty || null,
        carton_count: cartons != null && !isNaN(cartons) ? cartons : null,   // 箱数(该色行)
        image_url: st?.image_url?.trim() || null, remark: c?.remark?.trim() || null,
        fabric_name: prim.fabric_name,
        fabric_width: prim.fabric_width,
        fabric_consumption: prim.fabric_consumption,
        fabric_unit: prim.fabric_unit,
        fabrics: fabrics.length > 0 ? fabrics : null,   // 多布料明细(JSONB);列缺失时降级剔除见下
        po_unit_price: poUnitPrice,   // 客户成交价(款级同值写每行)
        source: 'manual',
        created_by: user.id,        // 录入留痕(整单替换式保存=最后保存人)
      });
    }
  }

  // ── 保险丝(2026-07-03 事故:表缺 DELETE 策略 → 删除静默 0 行 → 每次保存明细翻倍)──
  // 先数旧行,再带 .select 删,删不掉就中止 —— 宁可报错,绝不叠加。
  const { count: beforeCount } = await (supabase.from('order_line_items') as any)
    .select('id', { count: 'exact', head: true }).eq('order_id', orderId);
  const { data: deletedRows, error: delErr } = await (supabase.from('order_line_items') as any)
    .delete().eq('order_id', orderId).select('id');
  if (delErr) return { error: '清旧明细失败:' + delErr.message };
  if ((beforeCount || 0) > 0 && (deletedRows || []).length === 0) {
    return { error: '保存中止:旧明细删不掉(数据库缺 DELETE 权限,会导致数量翻倍)。请先在 Supabase 执行 20260703_delete_policies_fix.sql' };
  }
  if (rows.length > 0) {
    let { error: insErr } = await (supabase.from('order_line_items') as any).insert(rows);
    if (insErr && /product_name_en|carton_count|created_by|po_unit_price|fabrics|column .* does not exist/i.test(insErr.message || '')) {
      // 新列迁移未执行 → 降级去掉新列重插(不 brick 保存),提醒执行迁移
      console.warn('[saveOrderLineItems] 双语/箱数/录入人/PO价/多布料列缺失,降级保存。请执行 20260703/20260706/20260710 系列迁移');
      const plain = rows.map(({ product_name_en, carton_count, created_by, po_unit_price, fabrics, ...rest }) => rest);
      ({ error: insErr } = await (supabase.from('order_line_items') as any).insert(plain));
    }
    if (insErr) return { error: '写明细失败:' + insErr.message };
  }

  // 尺码列手排顺序 → 持久化订单级(orders.size_order);列缺失(迁移未执行)则静默跳过不阻断保存
  if (Array.isArray(sizeOrder)) {
    const cleaned = sizeOrder.map((s) => String(s).trim()).filter(Boolean);
    const { error: soErr } = await (supabase.from('orders') as any).update({ size_order: cleaned.length > 0 ? cleaned : null }).eq('id', orderId);
    if (soErr && !/size_order|column .* does not exist/i.test(soErr.message || '')) {
      console.warn('[saveOrderLineItems] 写 size_order 失败(不阻断):', soErr.message);
    }
  }

  // S1.2:每款布料 → 同步 materials_bom(fire-and-forget,失败不阻断保存)
  try { await syncStyleFabricsToBom(supabase, orderId, user.id, styles || []); } catch (e: any) {
    console.warn('[saveOrderLineItems] 布料同步 BOM 失败(不阻断):', e?.message);
  }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true, styles: (styles || []).length, lines: rows.length, total: rows.reduce((s, r) => s + (r.qty_pcs || 0), 0) };
}
