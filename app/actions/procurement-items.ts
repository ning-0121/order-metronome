'use server';

/**
 * Procurement Item(采购核料项)—— P1′。
 * 同订单内按 物料身份+颜色+单位 自动归并 material_requirements → 采购确认 → 生命周期。
 * Constitution 02(需求量 live 引用不复制)/ 03(生命周期)/ 04(本表=采购层)。
 * 红线:不改 O1/O2/B1/material_requirements/procurement_line_items/现有采购中心;只读 join 引用上游;不接 AI。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { friendlyError } from '@/lib/utils/db-error';
import { consolidationKey, computeSuggestedPurchaseQty, type IdentityInput } from '@/lib/services/procurement-consolidation';
import {
  buildExecutionLineRow, canGenerateExecution, resolveReceivingStatus, resolveOrderedStatus, deriveFulfillment,
} from '@/lib/services/procurement-execution';
import { getOrderLeftover } from '@/app/actions/inventory';

const num = (v: any) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));

/** 列出某订单的采购核料项。 */
export async function listProcurementItems(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data, error } = await (supabase.from('procurement_items') as any)
    .select('*').eq('order_id', orderId).order('item_no');
  if (error) return { error: friendlyError(error) };
  // 录入留痕:创建/确认/补采购申请/财务审批 → 姓名(一次查全,失败不阻断)
  try {
    const uids = [...new Set((data || []).flatMap((r: any) =>
      [r.created_by, r.confirmed_by, r.supplement_requested_by, r.finance_approved_by]).filter(Boolean))];
    if (uids.length > 0) {
      const { data: profs } = await (supabase.from('profiles') as any).select('user_id, name').in('user_id', uids);
      const nameMap = new Map<string, string>((profs || []).map((p: any) => [p.user_id, p.name]));
      const nm = (uid: any) => (uid ? nameMap.get(uid) || null : null);
      for (const r of (data || [])) {
        (r as any).created_by_name = nm(r.created_by);
        (r as any).confirmed_by_name = nm(r.confirmed_by);
        (r as any).supplement_requested_by_name = nm(r.supplement_requested_by);
        (r as any).finance_approved_by_name = nm(r.finance_approved_by);
      }
    }
  } catch { /* 姓名解析失败不影响列表 */ }
  return { data: data || [] };
}

/**
 * 核料归并:读 material_requirements ⋈ snapshot_lines ⋈ materials_bom → 按 key 分组 → upsert 采购项。
 * 分步查询 + JS join(避开深层 PostgREST 嵌套 join 脆弱)。保留采购已填决策,仅刷新系统字段。
 */
export async function consolidateOrderProcurementItems(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: order } = await (supabase.from('orders') as any).select('order_no').eq('id', orderId).single();
  const orderNo = (order as any)?.order_no || orderId.slice(0, 8);

  // 补采购判定(品类补):订单已过「采购下单」节点后核料出的【新】采购项 = 漏采补录
  // → 自动标补采购 + 待财务审批(存量项/未下单前的核料完全不受影响)。
  let afterProcurementPlaced = false;
  {
    const { data: poMs } = await (supabase.from('milestones') as any)
      .select('status').eq('order_id', orderId).eq('step_key', 'procurement_order_placed').maybeSingle();
    const st = String((poMs as any)?.status || '').toLowerCase();
    afterProcurementPlaced = st === 'done' || st === '已完成';
  }

  // 1) 需求
  const { data: reqs, error: rErr } = await (supabase.from('material_requirements') as any)
    .select('id, snapshot_line_id, material_name, material_code, category, unit, net_purchase_qty, version')
    .eq('order_id', orderId);
  if (rErr) return { error: friendlyError(rErr) };
  if (!reqs || reqs.length === 0) return { error: '该订单暂无物料需求(请先在「原辅料和包装」提交采购,跑出 MRP)' };

  // 2) snapshot_lines(color/spec/开发单耗/bom_id)
  const slIds = Array.from(new Set(reqs.map((r: any) => r.snapshot_line_id).filter(Boolean)));
  const slMap = new Map<string, any>();
  if (slIds.length) {
    const { data: sls } = await (supabase.from('material_package_snapshot_lines') as any)
      .select('id, color, specification, qty_per_piece, bom_id, material_name, loss_rate').in('id', slIds);
    for (const s of (sls || [])) slMap.set(s.id, s);
  }
  // 3) materials_bom（master_id + 色卡/辅料图,图随归并流转到采购）
  const bomIds = Array.from(new Set([...slMap.values()].map((s: any) => s.bom_id).filter(Boolean)));
  const bomMaster = new Map<string, string | null>();
  const bomImages = new Map<string, string[]>();
  if (bomIds.length) {
    const { data: bs } = await (supabase.from('materials_bom') as any).select('id, material_master_id, image_urls').in('id', bomIds);
    for (const b of (bs || [])) {
      bomMaster.set(b.id, b.material_master_id);
      if (Array.isArray(b.image_urls) && b.image_urls.length) bomImages.set(b.id, b.image_urls);
    }
  }

  // 4) 按 key 分组
  const groups = new Map<string, any>();
  for (const r of reqs) {
    const sl = r.snapshot_line_id ? slMap.get(r.snapshot_line_id) : null;
    const master_id = sl?.bom_id ? (bomMaster.get(sl.bom_id) || null) : null;
    const identity: IdentityInput = {
      material_master_id: master_id,
      material_name: r.material_name || sl?.material_name || null,
      specification: sl?.specification || null,
      category: r.category || null,
      color: sl?.color || null,
      unit: r.unit || null,
    };
    const key = consolidationKey(identity);
    const net = Number(r.net_purchase_qty) || 0;
    const dev = sl?.qty_per_piece != null ? Number(sl.qty_per_piece) : null;
    const loss = sl?.loss_rate != null ? Number(sl.loss_rate) : null;
    let g = groups.get(key);
    if (!g) { g = { key, ...identity, total: 0, count: 0, devTop: null, devTopNet: -1, lossTop: null, imgs: [] as string[] }; groups.set(key, g); }
    g.total += net; g.count += 1;
    if (net > g.devTopNet) { g.devTopNet = net; g.devTop = dev; g.lossTop = loss; }   // 主导来源的开发单耗/损耗作代表值
    // 汇集来源图(去重,封顶 8 张)
    const imgs = sl?.bom_id ? (bomImages.get(sl.bom_id) || []) : [];
    for (const u of imgs) if (g.imgs.length < 8 && !g.imgs.includes(u)) g.imgs.push(u);
  }

  // 5) 现有采购项(select * :image_urls 等新列迁移未执行时也不报缺列)
  const { data: existing } = await (supabase.from('procurement_items') as any)
    .select('*').eq('order_id', orderId);
  const exMap = new Map<string, any>((existing || []).map((e: any) => [e.consolidation_key, e]));

  let created = 0, updated = 0, flagged = 0, removed = 0;
  let seq = (existing || []).length;
  const now = new Date().toISOString();

  for (const g of groups.values()) {
    const ex = exMap.get(g.key);
    if (ex) {
      const devRep = ex.development_consumption ?? g.devTop;
      // 采购没填过损耗 → 预填来源损耗参考(原基线3%),从此损耗只在这一处明算
      const lossRep = ex.procurement_loss_pct ?? g.lossTop;
      const suggested = computeSuggestedPurchaseQty({
        total_required_qty: g.total, development_consumption: devRep,
        production_consumption: ex.production_consumption, procurement_loss_pct: lossRep,
        safety_stock_qty: ex.safety_stock_qty, moq: ex.moq,
      });
      const upd: any = {
        total_required_qty: g.total, source_count: g.count, development_consumption: devRep,
        procurement_loss_pct: lossRep,
        suggested_purchase_qty: suggested, updated_at: now,
      };
      // 图片合并:来源 BOM 新增的图并进去,采购已补拍的保留(union 去重,封顶 8)
      if (g.imgs.length > 0 && 'image_urls' in (ex as any)) {
        const cur: string[] = Array.isArray((ex as any).image_urls) ? (ex as any).image_urls : [];
        const merged = [...cur];
        for (const u of g.imgs) if (merged.length < 8 && !merged.includes(u)) merged.push(u);
        if (merged.length !== cur.length) upd.image_urls = merged;
      }
      if (Number(ex.total_required_qty) !== g.total && ex.status !== 'draft') { upd.needs_reconfirm = true; flagged++; }
      await (supabase.from('procurement_items') as any).update(upd).eq('id', ex.id);
      updated++;
    } else {
      seq++;
      const suggested = computeSuggestedPurchaseQty({
        total_required_qty: g.total, development_consumption: g.devTop, procurement_loss_pct: g.lossTop,
      });
      const row: any = {
        order_id: orderId, consolidation_key: g.key,
        item_no: `PI-${orderNo}-${String(seq).padStart(3, '0')}`,
        material_master_id: g.material_master_id, material_name: g.material_name, specification: g.specification,
        category: g.category, color: g.color, unit: g.unit,
        purchase_unit: g.unit,                // 采购计量单位默认=需求单位(物料录入时选过,买法不同采购再改)
        total_required_qty: g.total, source_count: g.count, development_consumption: g.devTop,
        procurement_loss_pct: g.lossTop,      // 预填损耗参考(可见可改;总需求已是裸数,不再暗含)
        suggested_purchase_qty: suggested, status: 'draft', created_by: user.id,
      };
      if (g.imgs.length > 0) row.image_urls = g.imgs;   // 业务传的色卡/辅料图随归并流转
      // 品类补:采购下单后才冒出来的新项 = 漏采补录 → 标补采购,待财务审批
      if (afterProcurementPlaced) {
        row.is_supplement = true;
        row.supplement_reason = '采购下单后核料新增(品类补录)';
        row.supplement_requested_by = user.id;
        row.supplement_requested_at = now;
        row.finance_approval_status = 'pending';
      }
      let { error: iErr } = await (supabase.from('procurement_items') as any).insert(row);
      if (iErr && /column .* does not exist|is_supplement|finance_approval|image_urls/i.test(iErr.message || '')) {
        // 补采购/图片迁移未执行 → 降级为普通项插入(不 brick 核料),提醒执行迁移
        console.warn('[consolidate] 新列缺失,降级插入。请执行 20260703 系列迁移(supplement/images)');
        const { is_supplement, supplement_reason, supplement_requested_by, supplement_requested_at, finance_approval_status, image_urls, ...plain } = row;
        ({ error: iErr } = await (supabase.from('procurement_items') as any).insert(plain));
      }
      if (iErr) return { error: friendlyError(iErr) };
      created++;
      if (afterProcurementPlaced) {
        const { notifyFinanceSupplement } = await import('@/app/actions/procurement-supplement');
        await notifyFinanceSupplement(supabase, orderId, g.material_name || '物料', g.total, g.unit, '采购下单后核料新增(品类补录)');
      }
    }
  }

  // 6) 旧项不再有来源(物料被删/改) —— 二次提交后清孤儿(审计🟠:此前草稿孤儿被无视,滞留成过期垃圾项)
  //    - 草稿孤儿 且 无执行行引用 → 直接删(未下游,无痕移除)
  //    - 已确认/在采购中的孤儿(或草稿却已挂执行行)→ 保留 + 标 needs_reconfirm(已下游动过,人来决策)
  const liveKeys = new Set(groups.keys());
  const orphans = (existing || []).filter((e: any) => !liveKeys.has(e.consolidation_key));
  if (orphans.length > 0) {
    const draftIds = orphans.filter((e: any) => e.status === 'draft').map((e: any) => e.id);
    const flagIds = orphans.filter((e: any) => e.status !== 'draft').map((e: any) => e.id);
    let deletable = draftIds;
    if (draftIds.length > 0) {
      // 双保险:草稿本不该有执行行,但若有(曾确认→生成→退回)则不删,降级为标记
      const { data: refd } = await (supabase.from('procurement_line_items') as any)
        .select('procurement_item_id').in('procurement_item_id', draftIds);
      const refSet = new Set((refd || []).map((r: any) => r.procurement_item_id));
      deletable = draftIds.filter((id: string) => !refSet.has(id));
      flagIds.push(...draftIds.filter((id: string) => refSet.has(id)));
    }
    if (deletable.length > 0) {
      // 保险丝(2026-07-03):带 .select 验证真删了;缺 DELETE 策略时静默 0 行 → 孤儿清理空转
      const { data: reallyDeleted } = await (supabase.from('procurement_items') as any)
        .delete().in('id', deletable).select('id');
      removed += (reallyDeleted || []).length;
      if ((reallyDeleted || []).length < deletable.length) {
        console.warn(`[consolidate] 草稿孤儿清理不完整(${(reallyDeleted || []).length}/${deletable.length}),疑缺 DELETE 策略,请执行 20260703_delete_policies_fix.sql`);
      }
    }
    if (flagIds.length > 0) {
      await (supabase.from('procurement_items') as any).update({ needs_reconfirm: true, updated_at: now }).in('id', flagIds);
      flagged += flagIds.length;
    }
  }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true, created, updated, flagged, removed, total_items: groups.size };
}

/** 来源明细(live):该采购项归并键命中的 requirements ⋈ snapshot_lines。粒度=物料行(产品维度缺口见 P1.md §5.1)。 */
export async function getProcurementItemSources(itemId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: item } = await (supabase.from('procurement_items') as any)
    .select('order_id, consolidation_key').eq('id', itemId).single();
  if (!item) return { error: '采购项不存在' };

  const { data: reqs } = await (supabase.from('material_requirements') as any)
    .select('id, snapshot_line_id, material_name, category, unit, net_purchase_qty')
    .eq('order_id', (item as any).order_id);
  const slIds = Array.from(new Set((reqs || []).map((r: any) => r.snapshot_line_id).filter(Boolean)));
  const slMap = new Map<string, any>();
  if (slIds.length) {
    const { data: sls } = await (supabase.from('material_package_snapshot_lines') as any)
      .select('id, color, specification, qty_per_piece, bom_id, material_name, loss_rate').in('id', slIds);
    for (const s of (sls || [])) slMap.set(s.id, s);
  }
  const bomIds = Array.from(new Set([...slMap.values()].map((s: any) => s.bom_id).filter(Boolean)));
  const bomMaster = new Map<string, string | null>();
  if (bomIds.length) {
    const { data: bs } = await (supabase.from('materials_bom') as any).select('id, material_master_id').in('id', bomIds);
    for (const b of (bs || [])) bomMaster.set(b.id, b.material_master_id);
  }

  const sources = (reqs || []).map((r: any) => {
    const sl = r.snapshot_line_id ? slMap.get(r.snapshot_line_id) : null;
    const master_id = sl?.bom_id ? (bomMaster.get(sl.bom_id) || null) : null;
    const key = consolidationKey({
      material_master_id: master_id, material_name: r.material_name || sl?.material_name,
      specification: sl?.specification, category: r.category, color: sl?.color, unit: r.unit,
    });
    return { key, material_name: r.material_name || sl?.material_name, color: sl?.color || null,
      development_consumption: sl?.qty_per_piece ?? null, net_demand: r.net_purchase_qty ?? null };
  }).filter((s: any) => s.key === (item as any).consolidation_key);

  return { data: sources };
}

/** 采购确认:填大货单耗/损耗/安全库存/MOQ/供应商/价/决策,重算 suggested。 */
/** 核料确认/参数编辑 = 采购的职权(2026-07-03 用户拍板:归并后必须采购确认才安全) */
async function requireProcurementRole(supabase: any, userId: string): Promise<string | null> {
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', userId).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  return roles.some(r => ['procurement', 'procurement_manager', 'admin'].includes(r))
    ? null : '仅采购/采购经理/管理员可编辑和确认核料(业务执行请走「补数量申请」)';
}

export async function updateProcurementItem(itemId: string, orderId: string, fields: Record<string, any>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roleErr = await requireProcurementRole(supabase, user.id);
  if (roleErr) return { error: roleErr };

  const { data: item } = await (supabase.from('procurement_items') as any)
    .select('total_required_qty, development_consumption').eq('id', itemId).single();
  if (!item) return { error: '采购项不存在' };

  const numFields = ['production_consumption', 'procurement_loss_pct', 'safety_stock_qty', 'final_purchase_qty', 'lead_days', 'moq', 'unit_price', 'tax_rate'];
  const boolFields = ['is_substitute', 'is_split', 'is_outsourced', 'risk_flag', 'price_inclusive_tax'];
  const textFields = ['confirmed_supplier_name', 'backup_supplier_name', 'supplier_contact', 'purchase_unit', 'currency', 'substitute_reason', 'risk_note', 'procurement_notes'];

  const upd: any = { updated_at: new Date().toISOString() };
  for (const k of numFields) if (k in fields) upd[k] = num(fields[k]);
  for (const k of boolFields) if (k in fields) upd[k] = !!fields[k];
  for (const k of textFields) if (k in fields) upd[k] = fields[k] || null;
  if ('quote_date' in fields) upd.quote_date = fields.quote_date || null;

  // 重算 suggested(用新输入)
  upd.suggested_purchase_qty = computeSuggestedPurchaseQty({
    total_required_qty: (item as any).total_required_qty,
    development_consumption: (item as any).development_consumption,
    production_consumption: upd.production_consumption ?? undefined,
    procurement_loss_pct: upd.procurement_loss_pct ?? undefined,
    safety_stock_qty: upd.safety_stock_qty ?? undefined,
    moq: upd.moq ?? undefined,
  });

  const { error } = await (supabase.from('procurement_items') as any).update(upd).eq('id', itemId);
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/**
 * 更新采购项图片(色卡/辅料参考图)。
 * 与核料参数不同:图片是证据,业务执行和采购都可增删(2026-07-03 用户拍板)。
 */
export async function updateProcurementItemImages(itemId: string, orderId: string, imageUrls: string[]) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!roles.some(r => ['sales', 'sales_manager', 'order_manager', 'merchandiser', 'procurement', 'procurement_manager', 'admin'].includes(r))) {
    return { error: '无权更新图片' };
  }
  const clean = (Array.isArray(imageUrls) ? imageUrls : [])
    .filter(u => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 8);
  const { error } = await (supabase.from('procurement_items') as any)
    .update({ image_urls: clean, updated_at: new Date().toISOString() }).eq('id', itemId);
  if (error) {
    if (/image_urls|column .* does not exist/i.test(error.message || '')) {
      return { error: '图片列尚未建立:请先在 Supabase 执行 20260703_procurement_item_images.sql' };
    }
    return { error: friendlyError(error) };
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

/** 生命周期推进。confirmed→记确认留痕 + 来源版本快照 + 清 needs_reconfirm。 */
export async function updateProcurementItemStatus(itemId: string, orderId: string, status: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const roleErr = await requireProcurementRole(supabase, user.id);
  if (roleErr) return { error: roleErr };
  const VALID = ['draft', 'reviewing', 'confirmed', 'ordered', 'partially_received', 'completed', 'closed'];
  if (!VALID.includes(status)) return { error: '非法状态' };

  // 补采购闸:未获财务批准的补采购项,不允许推进到 confirmed 及之后(生成执行行只认 confirmed)
  if (['confirmed', 'ordered', 'partially_received', 'completed'].includes(status)) {
    const { data: it } = await (supabase.from('procurement_items') as any)
      .select('is_supplement, finance_approval_status, finance_reject_reason').eq('id', itemId).maybeSingle();
    if ((it as any)?.is_supplement) {
      const fs = (it as any).finance_approval_status;
      if (fs === 'pending') return { error: '🟠 补采购待财务审批,批准后才能确认采购(财务已收到通知)' };
      if (fs === 'rejected') return { error: `补采购已被财务驳回:${(it as any).finance_reject_reason || '无原因'}。如仍需采购请重新提交申请` };
    }
  }

  const now = new Date().toISOString();
  const upd: any = { status, updated_at: now };
  if (status === 'confirmed') {
    upd.confirmed_by = user.id; upd.confirmed_at = now; upd.needs_reconfirm = false;
    // 来源快照(审计/判过期)
    const src = await getProcurementItemSources(itemId);
    if ((src as any).data) upd.confirmed_source_snapshot = (src as any).data;
  }
  const { error } = await (supabase.from('procurement_items') as any).update(upd).eq('id', itemId);
  if (error) return { error: friendlyError(error) };

  // 转复核 → 通知全体采购经理(拿不准的项由经理拍板;fire-and-forget 不阻塞)
  if (status === 'reviewing') {
    try {
      const { data: it } = await (supabase.from('procurement_items') as any)
        .select('item_no, material_name, color').eq('id', itemId).maybeSingle();
      const { data: order } = await (supabase.from('orders') as any)
        .select('order_no, customer_name').eq('id', orderId).maybeSingle();
      const { data: profs } = await (supabase.from('profiles') as any).select('user_id, role, roles');
      const managers = (profs || []).filter((p: any) => {
        const rs: string[] = p.roles?.length > 0 ? p.roles : [p.role].filter(Boolean);
        return rs.includes('procurement_manager') || rs.includes('admin');
      });
      if (managers.length > 0) {
        await (supabase.from('notifications') as any).insert(managers.map((m: any) => ({
          user_id: m.user_id,
          type: 'procurement_review',
          title: `⏳ 核料待复核:${(order as any)?.order_no || ''}`,
          message: `采购项「${(it as any)?.material_name || ''}${(it as any)?.color ? ' · ' + (it as any).color : ''}」(${(it as any)?.item_no || ''})被转来复核,请到订单「采购核料」查看并确认。`,
          related_order_id: orderId,
        })));
      }
    } catch { /* 通知失败不阻塞转复核 */ }
  }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
}

// ════════════════════════════════════════════════════════════════════════
// B3a 执行链打通:采购项(确认)→ 执行行 · 收货状态联动 · 领料核销派生
// ADR-004 第3层→第4层。本阶段起本 action 可写 procurement_line_items(桥),
// 老手工建行入口不动(并存);FK=procurement_item_id(不锚易失 requirement_id)。
// ════════════════════════════════════════════════════════════════════════

/** 桥:已确认(confirmed)且未生成过的采购项 → 生成采购执行行(挂 procurement_item_id)。幂等。 */
export async function generateExecutionLines(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: items, error: iErr } = await (supabase.from('procurement_items') as any)
    .select('id, order_id, consolidation_key, material_name, specification, category, unit, purchase_unit, total_required_qty, suggested_purchase_qty, final_purchase_qty, confirmed_supplier_name, unit_price, status')
    .eq('order_id', orderId).eq('status', 'confirmed');
  if (iErr) return { error: friendlyError(iErr) };
  if (!items || items.length === 0) return { error: '无已确认的采购项(请先在采购项上「确认」)' };

  // 已生成过执行行的 item(幂等,不重建)
  const { data: existLines } = await (supabase.from('procurement_line_items') as any)
    .select('procurement_item_id').eq('order_id', orderId).not('procurement_item_id', 'is', null);
  const done = new Set((existLines || []).map((l: any) => l.procurement_item_id));

  const now = new Date().toISOString();
  const rows = (items as any[])
    .filter((it) => !done.has(it.id) && canGenerateExecution(it))
    .map((it) => ({ ...buildExecutionLineRow(it, user.id), ordered_at: now }));
  if (rows.length === 0) return { ok: true, created: 0, message: '已确认项均已生成执行行' };

  const { error: insErr } = await (supabase.from('procurement_line_items') as any).insert(rows);
  if (insErr) return { error: friendlyError(insErr) };
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, created: rows.length };
}

/** 领料核销派生视图:逐采购项 需求/下单/收货/消耗/尾货(单一来源,不落库)。 */
export async function getOrderProcurementFulfillment(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: items } = await (supabase.from('procurement_items') as any)
    .select('id, consolidation_key, material_name, unit, total_required_qty, status').eq('order_id', orderId);
  if (!items || items.length === 0) return { data: [] };

  const itemIds = (items as any[]).map((i) => i.id);
  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('procurement_item_id, ordered_qty, received_qty').eq('order_id', orderId).in('procurement_item_id', itemIds);
  const lo = await getOrderLeftover(orderId);
  const leftoverRows = (lo as any).data || [];
  return { data: deriveFulfillment(items as any[], (lines || []) as any[], leftoverRows) };
}

/** 状态联动:按执行行收货量重算该订单关联采购项收货状态(只进不退)。收货钩子 fire-and-forget 调用。 */
export async function syncProcurementItemReceivingStatus(orderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: items } = await (supabase.from('procurement_items') as any)
    .select('id, status').eq('order_id', orderId);
  if (!items || items.length === 0) return { ok: true, changed: 0 };
  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('procurement_item_id, ordered_qty, received_qty').eq('order_id', orderId).not('procurement_item_id', 'is', null);

  const agg = new Map<string, { ordered: number; received: number }>();
  for (const l of (lines || []) as any[]) {
    const a = agg.get(l.procurement_item_id) || { ordered: 0, received: 0 };
    a.ordered += Number(l.ordered_qty) || 0; a.received += Number(l.received_qty) || 0;
    agg.set(l.procurement_item_id, a);
  }
  let changed = 0;
  const now = new Date().toISOString();
  for (const it of (items as any[])) {
    const a = agg.get(it.id); if (!a) continue;
    const next = resolveReceivingStatus(it.status, a.received, a.ordered);
    if (next !== it.status) {
      await (supabase.from('procurement_items') as any).update({ status: next, updated_at: now }).eq('id', it.id);
      changed++;
    }
  }
  return { ok: true, changed };
}

/** 状态联动:采购单 placed → 该单执行行关联采购项 confirmed→ordered。下单钩子 fire-and-forget 调用。 */
export async function syncProcurementItemsOrderedForPO(purchaseOrderId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  const { data: lines } = await (supabase.from('procurement_line_items') as any)
    .select('procurement_item_id').eq('purchase_order_id', purchaseOrderId).not('procurement_item_id', 'is', null);
  const ids = Array.from(new Set((lines || []).map((l: any) => l.procurement_item_id).filter(Boolean)));
  if (ids.length === 0) return { ok: true, changed: 0 };

  const { data: items } = await (supabase.from('procurement_items') as any).select('id, status').in('id', ids);
  let changed = 0;
  const now = new Date().toISOString();
  for (const it of (items || []) as any[]) {
    const next = resolveOrderedStatus(it.status);
    if (next !== it.status) {
      await (supabase.from('procurement_items') as any).update({ status: next, updated_at: now }).eq('id', it.id);
      changed++;
    }
  }
  return { ok: true, changed };
}
