'use server';

/**
 * 采购对账 — 订购 vs 实收 → 差异分析 → Excel 对账单
 *
 * 流程：
 *   采购下单时 → 录入/导入订购明细（物料名、数量、单价、供应商）
 *   原辅料到货时 → 跟单录入实收数量
 *   系统自动计算差异 → 标红偏差 >3%
 *   财务导出对账单 Excel → 发给供应商对账
 */

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import {
  isValidLineTransition,
  LINE_STATUS_LABELS,
  CHASE_ESCALATION_THRESHOLD,
  ACTIVE_LINE_STATUSES,
  overReceiptCheck,
  type ProcurementLineStatus,
} from '@/lib/domain/procurement';

/** 超量收货 → 通知全体财务(三个收货入口共用)。fire-and-forget,失败不影响拦截。 */
async function notifyFinanceOverReceipt(supabase: any, line: any, gate: { ordered: number; projected: number; cap: number }) {
  try {
    const { data: order } = await (supabase.from('orders') as any).select('order_no, internal_order_no').eq('id', line.order_id).maybeSingle();
    const { data: profs } = await (supabase.from('profiles') as any).select('user_id, role, roles');
    const fin = (profs || []).filter((p: any) => { const rs = p.roles?.length ? p.roles : [p.role]; return rs.includes('finance'); });
    if (fin.length) await (supabase.from('notifications') as any).insert(fin.map((f: any) => ({
      user_id: f.user_id, type: 'over_receipt',
      title: `⚠ 超量收货待处理:${order?.internal_order_no || order?.order_no || ''}`,
      message: `「${line.material_name || ''}」累计收货 ${gate.projected}${line.ordered_unit || ''} 将超采购量 ${gate.ordered} 的 10%(上限 ${gate.cap})。请裁决:审批放行 / 退回布行 / 布行补足 / 超出搁置。`,
      related_order_id: line.order_id,
    })));
  } catch { /* 通知失败不影响拦截 */ }
}
import { isAdminRole, hasRoleInGroup } from '@/lib/domain/roles';
import { maskFloorForLines } from '@/lib/procurement/purchaseOrder';
import { orderSizeKeys } from '@/lib/utils/size-sort';
import { fetchOrderSizeOrder } from '@/lib/services/orderSizeOrder';
import { canUserAccessOrder } from '@/lib/domain/orderAccess';
import { fetchLineCostsByIds } from '@/lib/procurement/floorCosts';

export interface ProcurementLineItem {
  id: string;
  order_id: string;
  material_name: string;
  material_code: string | null;
  specification: string | null;
  supplier_name: string | null;
  category: string;
  ordered_qty: number;
  ordered_unit: string;
  unit_price: number | null;
  ordered_amount: number | null;
  ordered_by: string | null;
  ordered_at: string | null;
  received_qty: number | null;
  received_unit: string | null;
  received_at: string | null;
  received_by: string | null;
  difference_qty: number | null;
  difference_pct: number | null;
  difference_amount: number | null;
  status: string;
  notes: string | null;
}

// TODO(Sprint-1): 此清单与 lib/domain/roles.ts 任一现成 group 都不完全等价（缺 sales 的 group 没有，
//                 含 production_manager 的 EXECUTION 没有 finance/sales）。
//                 保留本地常量，待评估后整合到 ROLE_GROUPS（建议命名 CAN_VIEW_PROCUREMENT）。
// 复审 P1 修:补 procurement_manager(此前漏,给谁分配"采购经理"单角色谁就进不去采购中心/不能催货收货)。
const ALLOWED_ROLES = ['admin', 'sales', 'merchandiser', 'finance', 'procurement', 'procurement_manager', 'production_manager'];

async function checkAccess(): Promise<{ ok: boolean; userId?: string; roles?: string[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!roles.some(r => ALLOWED_ROLES.includes(r))) return { ok: false, error: '无权限' };
  return { ok: true, userId: user.id, roles };
}

/**
 * 获取订单的采购明细
 */
export async function getProcurementItems(orderId: string): Promise<{
  data?: ProcurementLineItem[];
  error?: string;
  summary?: {
    totalOrdered: number;
    totalReceived: number;
    totalDifference: number;
    itemCount: number;
    discrepancyCount: number;
    budgetTotal: number;            // 预算总额 = 面料预算(逐行单价×量) + 辅料整单一口价
    fabricBudgetAmount: number;     // 其中面料预算
    accessoryBudgetTotal: number;   // 其中辅料整单一口价
  };
}> {
  const auth = await checkAccess();
  if (!auth.ok || !auth.userId) return { error: auth.error };
  const canSeeFloor = hasRoleInGroup(auth.roles || [], 'CAN_SEE_PROCUREMENT_FLOOR');

  const supabase = await createClient();
  // 价列已列级封锁 → 改走 service-role 读全列(免枚举/漏列);service-role 绕过 RLS,
  // 故先补订单级鉴权,再读;非 floor 角色的底价由下方 maskFloorForLines 剥离。
  if (!(await canUserAccessOrder(supabase, auth.userId, orderId)))
    return { error: '无权查看此订单的采购信息' };
  const { data, error } = await (createServiceRoleClient().from('procurement_line_items') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('category', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) return { error: error.message };

  const rawLines = (data || []) as any[];

  // 对账按物料合并(2026-07-08 用户:对账是跟供应商按物料核总量,不该被 N1 拆码拆成 21 行还看不出码)。
  //  合并键:有采购项按采购项(分色);辅料无采购项按 料+规格+供应商;布料无采购项各自成行(避免误并色)。
  //  数量/金额求和,收集尺码;收货以采购中心为单一真相,这里合并行只读汇总,不在对账页逐行录。
  const nrm = (s: any) => String(s ?? '').trim().toLowerCase();
  const isFabricCat = (c: any) => c === 'fabric' || c === 'lining';
  const piIds = [...new Set(rawLines.map((l) => l.procurement_item_id).filter(Boolean))];
  const colorByPi = new Map<string, string | null>();
  if (piIds.length) {
    const { data: pis } = await (createServiceRoleClient().from('procurement_items') as any).select('id, color').in('id', piIds);
    for (const p of (pis || [])) colorByPi.set((p as any).id, (p as any).color ?? null);
  }
  const grouped = new Map<string, any>();
  for (const l of rawLines) {
    const color = l.procurement_item_id ? (colorByPi.get(l.procurement_item_id) ?? null) : null;
    const key = l.procurement_item_id ? `pi_${l.procurement_item_id}`
      : isFabricCat(l.category) ? `row_${l.id}`
      : `mat_${nrm(l.material_name)}¦${nrm(l.specification)}¦${nrm(l.supplier_name)}`;
    const g = grouped.get(key);
    if (!g) {
      grouped.set(key, { ...l, color, _line_ids: [l.id], _sizes: l.size ? new Set([l.size]) : new Set(), _n: 1 });
      continue;
    }
    g.ordered_qty = (Number(g.ordered_qty) || 0) + (Number(l.ordered_qty) || 0);
    g.ordered_amount = (Number(g.ordered_amount) || 0) + (Number(l.ordered_amount) || 0);
    if (l.received_qty !== null && l.received_qty !== undefined) g.received_qty = (Number(g.received_qty) || 0) + Number(l.received_qty);
    g.difference_amount = (Number(g.difference_amount) || 0) + (Number(l.difference_amount) || 0);
    g._line_ids.push(l.id);
    if (l.size) g._sizes.add(l.size);
    g._n++;
  }
  const sizeOrder = await fetchOrderSizeOrder(supabase, orderId);   // 业务手排的尺码顺序(优先);无则标准自动排
  const rawItems = [...grouped.values()].map((g) => {
    const ordered = Number(g.ordered_qty) || 0;
    const recv = g.received_qty ?? null;
    const diffQty = recv !== null ? recv - ordered : null;
    const diffPct = recv !== null && ordered > 0 ? Number(((diffQty! / ordered) * 100).toFixed(1)) : null;
    return {
      ...g,
      received_qty: recv,
      difference_qty: diffQty,
      difference_pct: diffPct,
      sizes: orderSizeKeys([...(g._sizes || [])] as string[], sizeOrder),
      size_count: g._n, line_ids: g._line_ids,
    };
  }) as ProcurementLineItem[];

  // 汇总(用原始底价算,但对非底价角色不返回金额)
  const totalOrdered = rawItems.reduce((s, i) => s + (i.ordered_amount || 0), 0);
  const totalReceived = rawItems
    .filter(i => i.received_qty !== null)
    .reduce((s, i) => s + ((i.received_qty || 0) * (i.unit_price || 0)), 0);
  const totalDifference = rawItems.reduce((s, i) => s + (i.difference_amount || 0), 0);
  const discrepancyCount = rawItems.filter(
    i => i.received_qty !== null && Math.abs(i.difference_pct || 0) > 3,
  ).length;

  // 底价剥离(红线③):非可见底价角色 → 剥 unit_price/金额;汇总金额也归零
  const items = maskFloorForLines(rawItems as any[], canSeeFloor) as ProcurementLineItem[];

  // 预算接线(2026-07-09):对账「预算」列此前读死字段 budget_qty(旧报价基线模型,新流程从不写)→ 恒空。
  // 改接 7-8 新预算模型:面料逐行预算单价来自 materials_bom.budget_unit_price;辅料整单一口价来自
  // order_cost_baseline.accessory_budget_total。预算是业务自设目标价(≠供应商底价)→ 不做 floor 剥离,全员可见。
  const svcBudget = createServiceRoleClient();
  const [{ data: bomRows }, { data: costBase }] = await Promise.all([
    (svcBudget.from('materials_bom') as any).select('material_name, material_type, color, budget_unit_price').eq('order_id', orderId),
    (svcBudget.from('order_cost_baseline') as any).select('accessory_budget_total').eq('order_id', orderId).maybeSingle(),
  ]);
  const fabricBudgetPrice = new Map<string, number>();
  for (const b of (bomRows || []) as any[]) {
    if (b.budget_unit_price == null) continue;
    const p = Number(b.budget_unit_price);
    fabricBudgetPrice.set(`${nrm(b.material_name)}¦${nrm(b.color)}`, p);
    if (!fabricBudgetPrice.has(nrm(b.material_name))) fabricBudgetPrice.set(nrm(b.material_name), p);  // 颜色对不上 → 按料名兜底
  }
  const accessoryBudgetTotal = Number((costBase as any)?.accessory_budget_total) || 0;
  let fabricBudgetAmount = 0;
  for (const it of items) {
    if (!isFabricCat(it.category)) continue;
    const bp = fabricBudgetPrice.get(`${nrm(it.material_name)}¦${nrm((it as any).color)}`)
      ?? fabricBudgetPrice.get(nrm(it.material_name)) ?? null;
    (it as any).budget_unit_price = bp;
    if (bp != null) fabricBudgetAmount += bp * (Number(it.ordered_qty) || 0);
  }
  const budgetTotal = Math.round((fabricBudgetAmount + accessoryBudgetTotal) * 100) / 100;

  return {
    data: items,
    summary: {
      totalOrdered: canSeeFloor ? Number(totalOrdered.toFixed(2)) : 0,
      totalReceived: canSeeFloor ? Number(totalReceived.toFixed(2)) : 0,
      totalDifference: canSeeFloor ? Number(totalDifference.toFixed(2)) : 0,
      itemCount: rawItems.length,
      discrepancyCount,
      // 预算是业务目标价,业务/采购/财务都该看到 → 不受 canSeeFloor 限制
      budgetTotal,
      fabricBudgetAmount: Math.round(fabricBudgetAmount * 100) / 100,
      accessoryBudgetTotal,
    },
  };
}

/**
 * 添加采购明细行（采购下单时）
 */
export async function addProcurementItem(
  orderId: string,
  item: {
    material_name: string;
    material_code?: string;
    specification?: string;
    supplier_name?: string;
    category?: string;
    ordered_qty: number;
    ordered_unit?: string;
    unit_price?: number;
    qty_per_piece?: number; // 辅料：每件产品用多少（标签 2 个/件、拉链 1 条/件）
  },
): Promise<{ error?: string; data?: ProcurementLineItem }> {
  const auth = await checkAccess();
  if (!auth.ok || !auth.userId) return { error: auth.error };
  // 泄价红线③同源:执行层增行/手填底价仅限采购角色(业务执行走「补数量申请」)
  if (!hasRoleInGroup(auth.roles || [], 'CAN_EDIT_PROCUREMENT_EXEC'))
    return { error: '仅采购/采购经理/管理员可编辑采购执行层(业务执行请走「补数量申请」)' };

  const supabase = await createClient();

  // 预算计算 — 分面料和辅料两种逻辑
  // P0-5 修复：orderQuantity 初始为 0 而非 null，避免 TS18047 'possibly null' 警告
  // 业务上"未计算"和"数量=0"等价（未传 quantity 字段当作 0 处理）
  let budgetQty: number | null = null;
  let orderQuantity: number = 0;
  let budgetWarning: string | null = null;

  const { data: order } = await (supabase.from('orders') as any)
    .select('quantity, order_no').eq('id', orderId).single();
  orderQuantity = (order as any)?.quantity || 0;
  const orderNo = (order as any)?.order_no || '?';

  // 辅料：单件用量 × 订单数量 × 1.03 损耗
  if (item.qty_per_piece && item.qty_per_piece > 0 && orderQuantity > 0) {
    budgetQty = Number((item.qty_per_piece * orderQuantity * 1.03).toFixed(2));
  }

  // 面料：从成本基线读取预算
  if (item.category === 'fabric' || (!item.category && !item.qty_per_piece)) {
    const { data: baseline } = await (supabase.from('order_cost_baseline') as any)
      .select('budget_fabric_kg').eq('order_id', orderId).maybeSingle();

    if (baseline?.budget_fabric_kg) {
      // 查已有面料采购总量
      const { data: existingFabric } = await (supabase.from('procurement_line_items') as any)
        .select('ordered_qty').eq('order_id', orderId).eq('category', 'fabric');
      const existingTotal = (existingFabric || []).reduce((s: number, r: any) => s + (r.ordered_qty || 0), 0);
      const newTotal = existingTotal + item.ordered_qty;
      budgetQty = baseline.budget_fabric_kg;

      const overPct = ((newTotal - budgetQty) / budgetQty) * 100;
      if (overPct > 10) {
        budgetWarning = `🔴 面料采购累计 ${newTotal.toFixed(1)} KG，超出预算 ${budgetQty.toFixed(1)} KG 的 ${overPct.toFixed(1)}%`;
      } else if (overPct > 5) {
        budgetWarning = `🟡 面料采购累计 ${newTotal.toFixed(1)} KG，超出预算 ${budgetQty.toFixed(1)} KG 的 ${overPct.toFixed(1)}%（注意控制）`;
      }
    }
  }

  // insert 后 .select('*') 返回价列 → 经 service-role(本函数已 CAN_EDIT_PROCUREMENT_EXEC 门禁)
  const { data, error } = await (createServiceRoleClient().from('procurement_line_items') as any)
    .insert({
      order_id: orderId,
      material_name: item.material_name,
      material_code: item.material_code || null,
      specification: item.specification || null,
      supplier_name: item.supplier_name || null,
      category: item.category || 'fabric',
      ordered_qty: item.ordered_qty,
      ordered_unit: item.ordered_unit || 'KG',
      unit_price: item.unit_price || null,
      qty_per_piece: item.qty_per_piece || null,
      order_quantity: orderQuantity,
      budget_qty: budgetQty,
      ordered_by: auth.userId,
      ordered_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error) return { error: error.message };

  // 自动告警：超预算时通知财务+CEO
  const shouldAlert = budgetWarning ||
    (budgetQty && item.ordered_qty > budgetQty * 1.05);

  if (shouldAlert) {
    try {
      const { sendCostAlert } = await import('@/app/actions/cost-control');
      const alertMsg = budgetWarning ||
        `${orderNo}: ${item.material_name} 采购 ${item.ordered_qty} ${item.ordered_unit || ''} 超出预算 ${budgetQty}（+${(((item.ordered_qty - (budgetQty || 0)) / (budgetQty || 1)) * 100).toFixed(1)}%）`;
      await sendCostAlert(orderId, 'procurement_over_budget', alertMsg, auth.userId);
    } catch (e: any) { console.warn(`[procurement] 采购次要操作 200:`, e?.message); }
  }

  revalidatePath(`/orders/${orderId}`);
  return { data: data as ProcurementLineItem, warning: budgetWarning || undefined };
}

/**
 * 从采购进度（procurement_tracking）同步到对账明细
 * 将采购进度里的条目转为对账明细的"订购数量"，跳过已存在的物料名（去重）
 */
export async function syncFromProcurementTracking(
  orderId: string,
): Promise<{ added: number; skipped: number; error?: string }> {
  const auth = await checkAccess();
  if (!auth.ok || !auth.userId) return { added: 0, skipped: 0, error: auth.error };
  // 泄价红线③同源:同步进执行层含价行仅限采购角色
  if (!hasRoleInGroup(auth.roles || [], 'CAN_EDIT_PROCUREMENT_EXEC'))
    return { added: 0, skipped: 0, error: '仅采购/采购经理/管理员可编辑采购执行层' };

  const supabase = await createClient();

  // 只有跟单/采购/管理员可以同步
  const { data: profile } = await supabase
    .from('profiles')
    .select('roles')
    .eq('id', auth.userId)
    .maybeSingle();
  const roles: string[] = (profile as any)?.roles || [];
  const canSync = roles.some(r => ['merchandiser', 'procurement', 'admin'].includes(r));
  if (!canSync) return { added: 0, skipped: 0, error: '仅跟单/采购/管理员可同步' };

  // 取采购进度里的条目
  const { data: tracking, error: tErr } = await (supabase.from('procurement_tracking') as any)
    .select('item_name, supplier, quantity, category, notes')
    .eq('order_id', orderId)
    .eq('is_supplement', false)
    .not('quantity', 'is', null);
  if (tErr) return { added: 0, skipped: 0, error: tErr.message };
  if (!tracking || tracking.length === 0) return { added: 0, skipped: 0, error: '采购进度里暂无数据' };

  // 取已有对账明细（去重用）
  const { data: existing } = await (supabase.from('procurement_line_items') as any)
    .select('material_name')
    .eq('order_id', orderId);
  const existingNames = new Set((existing || []).map((e: any) => e.material_name));

  const CATEGORY_MAP: Record<string, string> = {
    fabric: 'fabric', trims: 'trim', packaging: 'packing', other: 'other',
  };

  const toInsert = (tracking as any[])
    .filter(t => !existingNames.has(t.item_name))
    .map(t => ({
      order_id: orderId,
      material_name: t.item_name,
      supplier_name: t.supplier || null,
      category: CATEGORY_MAP[t.category] || 'other',
      ordered_qty: Number(t.quantity) || 0,
      ordered_unit: 'KG',
      notes: t.notes || null,
      ordered_by: auth.userId,
      ordered_at: new Date().toISOString(),
    }));

  const skipped = tracking.length - toInsert.length;
  if (toInsert.length === 0) return { added: 0, skipped, error: '所有采购进度条目已存在于对账明细中' };

  const { error: iErr } = await (supabase.from('procurement_line_items') as any).insert(toInsert);
  if (iErr) return { added: 0, skipped, error: iErr.message };

  revalidatePath(`/orders/${orderId}`);
  return { added: toInsert.length, skipped };
}

/**
 * 录入实收数据（原辅料到货时）
 */
export async function recordReceipt(
  itemId: string,
  orderId: string,
  receivedQty: number,
  notes?: string,
  allowOver = false,
): Promise<{ error?: string; needsApproval?: boolean }> {
  // O4(2026-07-02 审计):收货是库存动作,收紧到操作角色(采购/管理员),
  // 与 recordGoodsReceipt 同一门槛;此前用 checkAccess 让 sales/finance 也能记收货。
  const auth = await checkOperator();
  if (!auth.ok || !auth.userId) return { error: auth.error };

  const supabase = await createClient();

  // 获取原始订购数据
  const { data: item } = await (supabase.from('procurement_line_items') as any)
    .select('ordered_qty, ordered_unit, po_no, material_name, purchase_order_id')
    .eq('id', itemId)
    .single();
  if (!item) return { error: '明细不存在' };

  // 内控(2026-07-06):对账页收货此前零校验就置 arrived —— 待审批采购单的货能绕过审批闸溜进待验收。
  // 与 recordGoodsReceipt/transitionProcurementLine 同款闸:采购单尚未下单(草稿/待审批/驳回)不得收货。
  if ((item as any).purchase_order_id) {
    const svcGate = createServiceRoleClient();
    const { data: gatePo } = await (svcGate.from('purchase_orders') as any)
      .select('status, approval_status').eq('id', (item as any).purchase_order_id).maybeSingle();
    if (gatePo && ((gatePo as any).status === 'draft' || ['pending', 'rejected'].includes((gatePo as any).approval_status))) {
      return { error: '该采购行所在采购单尚未下单(需先审批通过并下单),不能收货。请到采购单页完成审批+下单。' };
    }
  }

  // 审计修(2026-07-04):止血双真相。此入口是"覆盖写 received_qty 且不写 goods_receipts",
  // 一旦该行已有 goods_receipts 批次(经「收货登记」录过),覆盖写会抹掉批次汇总、甚至写负库存。
  // → 已有批次的行禁止走本覆盖入口,统一去「收货登记」(goods_receipts 单一真相 + 质检闸)。
  const { count: grCount } = await (supabase.from('goods_receipts') as any)
    .select('id', { count: 'exact', head: true }).eq('line_item_id', itemId);
  if ((grCount || 0) > 0) {
    return { error: '该行已有收货批次记录,请用采购中心「收货登记」继续录入/验收(单一真相),不要在对账页覆盖写。' };
  }

  // 收货 ±10% 硬闸(此入口为覆盖写=总量,故 prev=0、thisQty=总量;超量拦截通知财务)
  if (receivedQty > 0) {
    const gate = overReceiptCheck((item as any).ordered_qty, 0, receivedQty);
    if (gate.over) {
      const isFinance = auth.roles?.some(r => ['finance', 'admin'].includes(r));
      if (!allowOver) {
        await notifyFinanceOverReceipt(supabase, { order_id: orderId, material_name: null, ordered_unit: (item as any).ordered_unit }, gate);
        return { error: `⚠ 收货 ${gate.projected}${(item as any).ordered_unit || ''} 超采购量 ${gate.ordered} 的 10%(上限 ${gate.cap})。已拦截并通知财务:审批放行 / 退回布行 / 布行补足 / 超出搁置。超量请走「收货登记」批次录入由财务放行。`, needsApproval: true };
      }
      if (!isFinance) return { error: '超采购量 10% 需财务放行' };
    }
  }

  // 判断状态（旧 status 列保留;line_status 不再直接跳 accepted）
  // 审计修(2026-07-04):对账页收货只登记"到货"→ 一律进 arrived(待验收),
  // 验收结论(accepted/让步/拒收)统一走 QC 验收 recordGoodsReceipt(AQL+让步审批闸),
  // 不再从这里绕过质检直接置 accepted。
  let status = 'complete';
  let lineStatus = 'arrived';          // 到货待验收
  const diff = receivedQty - (item as any).ordered_qty;
  if (receivedQty === 0) { status = 'cancelled'; lineStatus = 'cancelled'; }
  else if (diff < -((item as any).ordered_qty * 0.03)) status = 'partial';   // 短缺>3%
  else if (diff > (item as any).ordered_qty * 0.03) status = 'over';         // 超发>3%

  const { error } = await (supabase.from('procurement_line_items') as any)
    .update({
      received_qty: receivedQty,
      received_unit: (item as any).ordered_unit,
      received_at: new Date().toISOString(),
      received_by: auth.userId,
      status,
      line_status: lineStatus,
      notes: notes || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId);

  if (error) return { error: error.message };

  // W0: 采购收货 → 自动入库(增量 delta)。fire-and-forget，不阻断收货主流程。
  try {
    const { recordInventoryReceipt } = await import('@/app/actions/inventory');
    await recordInventoryReceipt(itemId);
  } catch (e: any) { console.warn('[recordReceipt] 自动入库失败(不阻断收货,库存可能滞后):', e?.message); }

  // B3a: 收货 → 联动关联采购项收货状态(fire-and-forget)。
  try {
    const { syncProcurementItemReceivingStatus } = await import('@/app/actions/procurement-items');
    await syncProcurementItemReceivingStatus(orderId);
  } catch (e: any) { console.warn('[recordReceipt] 采购项状态联动失败(不阻断收货):', e?.message); }

  // 收货回财务(审计修 2026-07-04):按实收冲销/核销应付
  try {
    const { syncGoodsReceiptToFinance } = await import('@/lib/integration/finance-sync');
    await syncGoodsReceiptToFinance({ po_no: (item as any).po_no ?? null, line_id: itemId, order_id: orderId,
      material_name: (item as any).material_name ?? null, ordered_qty: (item as any).ordered_qty ?? null,
      received_qty_total: receivedQty, line_status: lineStatus });
  } catch (e: any) { console.warn('[recordReceipt] 收货回财务失败(不阻断):', e?.message); }

  // 到货 vs 预算校验:原读 procurement_line_items.budget_qty —— 该列在新流程恒空(见 memory
  // budget-model-field-map),故此告警从不触发,是给「有到货超预算监控」的假象。移除死码。
  // 真要做需改读真实预算源(materials_bom.budget_unit_price × 单耗 或 order_cost_baseline),另立项。

  revalidatePath(`/orders/${orderId}`);
  return {};
}

/**
 * 删除采购明细行
 */
export async function deleteProcurementItem(
  itemId: string,
  orderId: string,
): Promise<{ error?: string }> {
  const auth = await checkAccess();
  if (!auth.ok) return { error: auth.error };
  // 泄价红线③同源:执行层删行仅限采购角色
  if (!hasRoleInGroup(auth.roles || [], 'CAN_EDIT_PROCUREMENT_EXEC'))
    return { error: '仅采购/采购经理/管理员可编辑采购执行层' };

  const supabase = await createClient();
  const { error } = await (supabase.from('procurement_line_items') as any)
    .delete()
    .eq('id', itemId);
  if (error) return { error: error.message };

  revalidatePath(`/orders/${orderId}`);
  return {};
}

/**
 * 导出对账单 Excel（给财务发给供应商）
 */
export async function exportReconciliationSheet(orderId: string): Promise<{
  error?: string;
  base64?: string;
  fileName?: string;
}> {
  const auth = await checkAccess();
  if (!auth.ok) return { error: auth.error };
  // 对账单含底价/金额,仅可见底价角色可导出(业务/生产不得导出含价对账单)
  if (!hasRoleInGroup(auth.roles || [], 'CAN_SEE_PROCUREMENT_FLOOR'))
    return { error: '仅采购/财务/管理员可导出含价对账单' };

  const supabase = await createClient();

  // 获取订单信息
  const { data: order } = await (supabase.from('orders') as any)
    .select('order_no, customer_name, factory_name, internal_order_no')
    .eq('id', orderId)
    .single();
  if (!order) return { error: '订单不存在' };

  // 获取采购明细(含底价 → 已列级封锁,经 service-role 读;本函数已 CAN_SEE_PROCUREMENT_FLOOR 门禁)
  const { data: items } = await (createServiceRoleClient().from('procurement_line_items') as any)
    .select('*')
    .eq('order_id', orderId)
    .order('category')
    .order('created_at');

  if (!items || items.length === 0) return { error: '暂无采购明细' };

  // 对账单也按物料合并(和页面一致:供应商按物料核总量,不逐尺码;尺码并进物料名括注)
  const _piIds = [...new Set((items as any[]).map((l) => l.procurement_item_id).filter(Boolean))];
  const _colorByPi = new Map<string, string | null>();
  if (_piIds.length) {
    const { data: _pis } = await (createServiceRoleClient().from('procurement_items') as any).select('id, color').in('id', _piIds);
    for (const p of (_pis || [])) _colorByPi.set((p as any).id, (p as any).color ?? null);
  }
  const _nrm = (s: any) => String(s ?? '').trim().toLowerCase();
  const _isFabric = (c: any) => c === 'fabric' || c === 'lining';
  // 预算(2026-07-09):面料逐行预算单价 materials_bom.budget_unit_price;辅料整单一口价 order_cost_baseline.accessory_budget_total
  const [{ data: _bom }, { data: _cb }] = await Promise.all([
    (createServiceRoleClient().from('materials_bom') as any).select('material_name, material_type, color, budget_unit_price').eq('order_id', orderId),
    (createServiceRoleClient().from('order_cost_baseline') as any).select('accessory_budget_total').eq('order_id', orderId).maybeSingle(),
  ]);
  const _fabBudget = new Map<string, number>();
  for (const b of (_bom || []) as any[]) {
    if (b.budget_unit_price == null) continue;
    const p = Number(b.budget_unit_price);
    _fabBudget.set(`${_nrm(b.material_name)}¦${_nrm(b.color)}`, p);
    if (!_fabBudget.has(_nrm(b.material_name))) _fabBudget.set(_nrm(b.material_name), p);   // 颜色对不上 → 按料名兜底
  }
  const _accBudgetTotal = Number((_cb as any)?.accessory_budget_total) || 0;
  const _grp = new Map<string, any>();
  for (const l of (items as any[])) {
    const color = l.procurement_item_id ? (_colorByPi.get(l.procurement_item_id) ?? null) : null;
    const key = l.procurement_item_id ? `pi_${l.procurement_item_id}` : _isFabric(l.category) ? `row_${l.id}` : `mat_${_nrm(l.material_name)}¦${_nrm(l.specification)}¦${_nrm(l.supplier_name)}`;
    const g = _grp.get(key);
    if (!g) { _grp.set(key, { ...l, color, _sizes: l.size ? new Set([l.size]) : new Set() }); continue; }
    g.ordered_qty = (Number(g.ordered_qty) || 0) + (Number(l.ordered_qty) || 0);
    g.ordered_amount = (Number(g.ordered_amount) || 0) + (Number(l.ordered_amount) || 0);
    if (l.received_qty != null) g.received_qty = (Number(g.received_qty) || 0) + Number(l.received_qty);
    g.difference_amount = (Number(g.difference_amount) || 0) + (Number(l.difference_amount) || 0);
    if (l.size) g._sizes.add(l.size);
  }
  const recItems = [...(_grp.values())].map((g) => {
    const ordered = Number(g.ordered_qty) || 0;
    const recv = g.received_qty ?? null;
    const diffQty = recv !== null ? recv - ordered : null;
    const diffPct = recv !== null && ordered > 0 ? Number(((diffQty! / ordered) * 100).toFixed(1)) : null;
    const sizes = [...(g._sizes || [])];
    const budgetUnitPrice = _isFabric(g.category)
      ? (_fabBudget.get(`${_nrm(g.material_name)}¦${_nrm(g.color)}`) ?? _fabBudget.get(_nrm(g.material_name)) ?? null)
      : null;
    return { ...g, received_qty: recv, difference_qty: diffQty, difference_pct: diffPct,
      budget_unit_price: budgetUnitPrice,
      material_name: sizes.length ? `${g.material_name}${g.color ? ' ' + g.color : ''}(${sizes.join('/')})` : (g.color ? `${g.material_name} ${g.color}` : g.material_name) };
  });

  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  wb.creator = 'QIMO OS';
  const ws = wb.addWorksheet('采购对账单', { views: [{ state: 'frozen', ySplit: 3 }] });

  // 标题
  ws.mergeCells('A1:L1');
  const titleCell = ws.getCell('A1');
  titleCell.value = `采购对账单 — ${(order as any).order_no} · ${(order as any).customer_name || ''}`;
  titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  // 副标题
  ws.mergeCells('A2:L2');
  ws.getCell('A2').value = `工厂：${(order as any).factory_name || '—'} · 内部单号：${(order as any).internal_order_no || '—'} · 导出时间：${new Date().toLocaleDateString('zh-CN')}`;
  ws.getCell('A2').font = { size: 10, color: { argb: 'FF6B7280' } };
  ws.getCell('A2').alignment = { horizontal: 'center' };

  // 表头
  const headers = ['物料名称', '规格', '供应商', '类别', '预算单价', '订购数量', '单位', '单价', '订购金额', '实收数量', '差异', '差异%'];
  const headerRow = ws.getRow(3);
  headerRow.values = headers;
  headerRow.height = 20;
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FF1F2937' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
    };
  });

  // 数据
  const CATEGORY_LABELS: Record<string, string> = {
    fabric: '面料', lining: '里料', trim: '辅料', label: '标签',
    zipper: '拉链', button: '纽扣', elastic: '松紧', packing: '包材', other: '其他',
  };

  let totalOrderedAmt = 0;
  let fabricBudgetAmt = 0;

  recItems.forEach((item, i) => {
    const row = ws.getRow(i + 4);
    totalOrderedAmt += item.ordered_amount || 0;
    if (item.budget_unit_price != null) fabricBudgetAmt += Number(item.budget_unit_price) * (Number(item.ordered_qty) || 0);

    row.values = [
      item.material_name,
      item.specification || '',
      item.supplier_name || '',
      CATEGORY_LABELS[item.category] || item.category,
      item.budget_unit_price != null ? Number(item.budget_unit_price) : '',   // 预算单价(面料);辅料一口价见表尾
      item.ordered_qty,
      item.ordered_unit || 'KG',
      item.unit_price || '',
      item.ordered_amount || '',
      item.received_qty ?? '未收',
      item.difference_qty ?? '',
      item.difference_pct !== null ? `${item.difference_pct}%` : '',
    ];

    // 差异标红(列右移 1:差异=11 / 差异%=12)
    if (item.received_qty !== null && Math.abs(item.difference_pct || 0) > 3) {
      row.getCell(11).font = { bold: true, color: { argb: 'FFDC2626' } };
      row.getCell(12).font = { bold: true, color: { argb: 'FFDC2626' } };
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      });
    }

    row.eachCell(cell => {
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FFF3F4F6' } },
      };
    });
  });

  // 合计行(放在合并后的最后一行,列右移 1:订购金额=9)。修 P2(2026-07-09 审计):
  // 「差异」列逐行是【数量差】,合计不能塞【金额差】(单位混算)、且未收货行整额被算成差异 → 合计差异留空;
  // 订购金额用数值(不 .toFixed 文本),保持可求和。财务看逐行差异/差异%,不看合计差异。
  const totalRow = ws.getRow(recItems.length + 4);
  totalRow.values = ['合计', '', '', '', '', '', '', '', Number(totalOrderedAmt.toFixed(2)), '', '', ''];
  totalRow.font = { bold: true };
  totalRow.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };

  // 预算总额(面料逐行预算 + 辅料整单一口价)—— 独立表尾行,辅料一口价无法逐行摊,故汇总在此
  const budgetTotal = Math.round((fabricBudgetAmt + _accBudgetTotal) * 100) / 100;
  const budgetRowIdx = recItems.length + 5;
  ws.mergeCells(`A${budgetRowIdx}:L${budgetRowIdx}`);
  const budgetCell = ws.getCell(`A${budgetRowIdx}`);
  budgetCell.value = `预算总额：¥${budgetTotal.toLocaleString()}（面料预算 ¥${(Math.round(fabricBudgetAmt * 100) / 100).toLocaleString()} + 辅料整单一口价 ¥${_accBudgetTotal.toLocaleString()}）`;
  budgetCell.font = { bold: true, color: { argb: 'FFB45309' } };
  budgetCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
  budgetCell.alignment = { horizontal: 'left', vertical: 'middle' };

  // 列宽(12 列:类别后插入「预算单价」)
  [18, 16, 14, 8, 10, 10, 6, 8, 12, 10, 10, 8].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const fileName = `对账单_${(order as any).order_no}_${new Date().toISOString().slice(0, 10)}.xlsx`;

  return { base64, fileName };
}

// ════════════════════════════════════════════════════════════
// 采购中心 V1 — 行级状态机 + 催货（契约：docs/procurement-center-design.md §4/§11）
// ════════════════════════════════════════════════════════════

/** 可操作采购行流转的角色（查看权限沿用上方 ALLOWED_ROLES，更宽） */
const OPERATOR_ROLES = ['procurement', 'procurement_manager', 'admin', 'admin_assistant'];

async function checkOperator(): Promise<{ ok: boolean; userId?: string; roles?: string[]; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  if (!isAdminRole(roles) && !roles.some(r => OPERATOR_ROLES.includes(r))) {
    return { ok: false, error: '无权限：仅采购/管理员可操作采购行' };
  }
  return { ok: true, userId: user.id, roles };
}

/** 让步接收审批权（决策3）。procurement_manager 角色注册后自动生效，当前仅 admin。 */
function canApproveConcession(roles: string[]): boolean {
  return isAdminRole(roles) || roles.includes('procurement_manager');
}

/** 采购操作日志（复制 milestone_logs 模式：失败不阻断主流程，但要冒出来） */
async function logProcurement(
  supabase: any, lineItemId: string, orderId: string, action: string,
  fromStatus: string | null, toStatus: string | null, note?: string | null, payload?: any,
) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await (supabase.from('procurement_logs') as any).insert({
    line_item_id: lineItemId, order_id: orderId, actor_user_id: user?.id ?? null,
    action, from_status: fromStatus, to_status: toStatus,
    note: note || null, payload: payload || null,
  });
  if (error) console.error('[procurement] log insert failed:', error.message);
}

/** 历史中位价（同物料名，全供应商）。无样本返回 null。 */
async function medianHistoricalPrice(supabase: any, materialName: string): Promise<number | null> {
  const { data, error } = await (supabase.from('price_history') as any)
    .select('unit_price').eq('material_name', materialName)
    .order('quoted_at', { ascending: false }).limit(50);
  if (error) { console.error('[procurement] price_history read failed:', error.message); return null; }
  const prices = (data || []).map((r: any) => Number(r.unit_price)).filter((n: number) => n > 0).sort((a: number, b: number) => a - b);
  if (prices.length === 0) return null;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
}

export interface TransitionPayload {
  po_no?: string;
  unit_price?: number;
  promised_date?: string;     // YYYY-MM-DD
  expected_arrival?: string;  // YYYY-MM-DD
  supplier_id?: string;
  supplier_name?: string;
  note?: string;
}

/**
 * 采购行状态流转（唯一入口）。
 * 规则：状态机校验（lib/domain/procurement）；cancelled 必填理由；
 *       concession 仅 procurement_manager/admin（决策3）；
 *       → ordered 时写价格快照（price_baseline=历史中位价）+ price_history（决策4：只记录不阻断）。
 */
export async function transitionProcurementLine(
  lineItemId: string,
  nextStatus: ProcurementLineStatus,
  payload?: TransitionPayload,
): Promise<{ data?: any; error?: string }> {
  const access = await checkOperator();
  if (!access.ok) return { error: access.error };
  const supabase = await createClient();
  // 读/写含底价列 → 经 service-role(本函数已 checkOperator=采购/admin 门禁,允许看价)
  const svc = createServiceRoleClient();

  const { data: line, error: getErr } = await (svc.from('procurement_line_items') as any)
    .select('id, order_id, line_status, material_name, specification, category, supplier_id, supplier_name, unit_price, ordered_unit, ordered_qty, purchase_order_id')
    .eq('id', lineItemId).single();
  if (getErr || !line) return { error: getErr?.message || '采购行不存在' };

  const fromStatus = (line.line_status || 'draft') as ProcurementLineStatus;
  if (!isValidLineTransition(fromStatus, nextStatus)) {
    return { error: `不允许从「${LINE_STATUS_LABELS[fromStatus] || fromStatus}」转到「${LINE_STATUS_LABELS[nextStatus] || nextStatus}」` };
  }
  // 内控(职责分离):采购单未下单(草稿/待审批)时,不许把行推进到"已下单及以后"(催货/到厂/验收)。
  // 防绕过审批闸直接催货收货——服务端强制,不靠前端隐藏。
  const FORWARD_STATES = ['ordered', 'confirmed', 'in_production', 'ready_to_ship', 'shipped', 'arrived', 'accepted', 'concession', 'partially_received', 'received', 'closed'];
  if (FORWARD_STATES.includes(nextStatus as string) && (line as any).purchase_order_id) {
    const { data: po } = await (svc.from('purchase_orders') as any).select('status').eq('id', (line as any).purchase_order_id).maybeSingle();
    if ((po as any)?.status === 'draft') {
      return { error: '该采购行所在采购单尚未下单(需先审批通过并下单),不能推进/催货/收货。请到采购单页完成审批+下单。' };
    }
  }
  if (nextStatus === 'cancelled' && !payload?.note?.trim()) {
    return { error: '取消采购行必须填写理由' };
  }
  if (nextStatus === 'concession' && !canApproveConcession(access.roles || [])) {
    return { error: '让步接收需采购经理或管理员审批' };
  }

  const now = new Date().toISOString();
  const update: Record<string, any> = { line_status: nextStatus, updated_at: now };
  if (payload?.promised_date !== undefined) update.promised_date = payload.promised_date || null;
  if (payload?.expected_arrival !== undefined) update.expected_arrival = payload.expected_arrival || null;
  if (payload?.supplier_id !== undefined) update.supplier_id = payload.supplier_id || null;
  if (payload?.supplier_name !== undefined) update.supplier_name = payload.supplier_name || null;

  let priceSnapshotNote: string | null = null;
  if (nextStatus === 'ordered') {
    update.ordered_at = now;
    update.ordered_by = access.userId;
    if (payload?.po_no !== undefined) update.po_no = payload.po_no || null;
    if (payload?.unit_price !== undefined && payload.unit_price !== null) {
      update.unit_price = payload.unit_price;
      // 价格快照：基线=历史中位价（决策4：V1 只标色提醒，不阻断）
      const baseline = await medianHistoricalPrice(supabase, line.material_name);
      if (baseline !== null) update.price_baseline = baseline;
      priceSnapshotNote = baseline !== null
        ? `价格快照：本次 ${payload.unit_price}，历史中位 ${baseline}`
        : `价格快照：本次 ${payload.unit_price}，无历史基线（首单）`;
    }
  }
  if (nextStatus === 'confirmed') update.confirmed_at = now;
  if (nextStatus === 'shipped') update.shipped_at = now;

  const { data: updated, error: upErr } = await (svc.from('procurement_line_items') as any)
    .update(update).eq('id', lineItemId).select().single();
  if (upErr) return { error: upErr.message };

  // → ordered 且有单价：写价格库（自动沉淀；失败不阻断但记日志）
  if (nextStatus === 'ordered' && payload?.unit_price) {
    const { error: phErr } = await (supabase.from('price_history') as any).insert({
      order_id: line.order_id, line_item_id: lineItemId,
      supplier_id: payload.supplier_id ?? line.supplier_id ?? null,
      material_name: line.material_name, specification: line.specification ?? null,
      category: line.category ?? null,
      unit_price: payload.unit_price, unit: line.ordered_unit ?? null,
      qty: line.ordered_qty ?? null, quoted_at: now, source: 'order',
    });
    if (phErr) console.error('[procurement] price_history insert failed:', phErr.message);
  }

  // 审计修(2026-07-04):行单价填/改 且该行已归采购单 → 重算 PO 总额(存储值不随生成列自动更新)
  // 并 resync 财务,否则无价版补价后财务应付永远停在"金额待定"。fire-and-forget,不阻断。
  if (payload?.unit_price != null && (line as any).purchase_order_id) {
    try {
      const poId = (line as any).purchase_order_id;
      const { data: poLines } = await (svc.from('procurement_line_items') as any)
        .select('ordered_amount').eq('purchase_order_id', poId);
      const total = ((poLines || []) as any[]).reduce((s, r) => s + (Number(r.ordered_amount) || 0), 0);
      await (svc.from('purchase_orders') as any)
        .update({ total_amount: Math.round(total * 100) / 100, updated_at: now }).eq('id', poId);
      const { data: full } = await (svc.from('purchase_orders') as any).select('*').eq('id', poId).maybeSingle();
      if (full && (full as any).status !== 'draft') {   // 已下单的才推财务(草稿未发应付)
        const { syncPurchaseOrderToFinance, fetchPurchaseOrderLinesRaw, fetchSupplierName, fetchOrderRefs } = await import('@/lib/integration/finance-sync');
        const poLines = await fetchPurchaseOrderLinesRaw(svc, poId);   // 补价 resync 也带上原辅料明细
        (full as any).supplier_name = await fetchSupplierName(svc, (full as any).supplier_id); // 单头供应商名必带
        const orderRefs = await fetchOrderRefs(svc, (full as any).order_ids); // 富标识(内部订单号)→ 财务按内部单号聚合
        await syncPurchaseOrderToFinance(full as Record<string, unknown>, orderRefs, undefined, poLines);
      }
    } catch (e: any) { console.warn('[procurement] 补价后 PO 总额 resync 失败(不阻断):', e?.message); }
  }

  await logProcurement(supabase, lineItemId, line.order_id, 'status_transition',
    fromStatus, nextStatus, payload?.note ?? priceSnapshotNote,
    { po_no: payload?.po_no, unit_price: payload?.unit_price, promised_date: payload?.promised_date, expected_arrival: payload?.expected_arrival });

  revalidatePath(`/orders/${line.order_id}`);
  revalidatePath('/procurement');
  return { data: updated };
}

/**
 * N1/N3:改采购行的 尺码 / 规格 / 数量(仅未归采购单的 draft/pending_order 行;已下单走补量/取消)。
 * 采购手动调整自动拆的各码量、补尺码、手填规格(如包装袋 40*30)。
 */
export async function updateProcurementLineFields(
  lineItemId: string,
  patch: { size?: string | null; specification?: string | null; ordered_qty?: number | null },
): Promise<{ ok?: boolean; error?: string }> {
  const access = await checkOperator();
  if (!access.ok) return { error: access.error };
  const svc = createServiceRoleClient();
  const { data: line } = await (svc.from('procurement_line_items') as any)
    .select('id, order_id, line_status, purchase_order_id').eq('id', lineItemId).maybeSingle();
  if (!line) return { error: '采购行不存在' };
  if ((line as any).purchase_order_id || !['draft', 'pending_order'].includes((line as any).line_status)) {
    return { error: '已归采购单/已下单的行不能直接改(改量走「补数量」,改错走「取消」)' };
  }
  const upd: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.size !== undefined) upd.size = (patch.size || '').trim() || null;
  if (patch.specification !== undefined) upd.specification = (patch.specification || '').trim() || null;
  if (patch.ordered_qty != null && Number(patch.ordered_qty) > 0) upd.ordered_qty = Number(patch.ordered_qty);
  const { error } = await (svc.from('procurement_line_items') as any).update(upd).eq('id', lineItemId);
  if (error) return { error: error.message };
  revalidatePath(`/orders/${(line as any).order_id}`);
  revalidatePath('/procurement');
  return { ok: true };
}

/**
 * 催货留痕：chase_count+1 + last_chased_at + 日志；
 * 达到 CHASE_ESCALATION_THRESHOLD 的整数倍 → 通知管理员（procurement_manager 角色注册后改发 PM）。
 */
export async function chaseProcurementLine(
  lineItemId: string, note?: string,
): Promise<{ data?: { chase_count: number }; error?: string }> {
  const access = await checkOperator();
  if (!access.ok) return { error: access.error };
  const supabase = await createClient();

  const { data: line, error: getErr } = await (supabase.from('procurement_line_items') as any)
    .select('id, order_id, line_status, chase_count, material_name, supplier_name')
    .eq('id', lineItemId).single();
  if (getErr || !line) return { error: getErr?.message || '采购行不存在' };

  if (!ACTIVE_LINE_STATUSES.includes(line.line_status as ProcurementLineStatus)) {
    return { error: `仅在途行可催货（当前：${LINE_STATUS_LABELS[line.line_status as ProcurementLineStatus] || line.line_status}）` };
  }

  const newCount = (line.chase_count || 0) + 1;
  const { error: upErr } = await (supabase.from('procurement_line_items') as any)
    .update({ chase_count: newCount, last_chased_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', lineItemId);
  if (upErr) return { error: upErr.message };

  await logProcurement(supabase, lineItemId, line.order_id, 'chase', null, null,
    note || `第 ${newCount} 次催货`, { chase_count: newCount });

  // 升级：3 次（及其倍数）无果 → 通知管理员
  if (newCount >= CHASE_ESCALATION_THRESHOLD && newCount % CHASE_ESCALATION_THRESHOLD === 0) {
    try {
      const { data: admins } = await (supabase.from('profiles') as any)
        .select('user_id').or('role.eq.admin,roles.cs.{admin}');
      for (const a of admins || []) {
        await (supabase.from('notifications') as any).insert({
          user_id: a.user_id,
          type: 'procurement_chase_escalation',
          title: `⚠️ 催货 ${newCount} 次未果：${line.material_name}`,
          message: `供应商「${line.supplier_name || '未填'}」的「${line.material_name}」已催 ${newCount} 次仍未推进，请介入。`,
          related_order_id: line.order_id,
        });
      }
    } catch (e: any) {
      console.error('[procurement] chase escalation notify failed:', e?.message);
    }
  }

  revalidatePath(`/orders/${line.order_id}`);
  revalidatePath('/procurement');
  return { data: { chase_count: newCount } };
}

/**
 * 到货验收：写 goods_receipts + 流转采购行（决策3：让步仅 PM/admin）。
 * result: 'pass'→accepted / 'concession'→concession / 'reject'→rejected。
 * arrived→accepted/concession/rejected 走状态机校验（lib/domain）。
 */
export async function recordGoodsReceipt(
  lineItemId: string,
  payload: {
    received_qty: number;
    received_unit?: string;
    result: 'pass' | 'concession' | 'reject';
    aql_level?: string;
    defect_notes?: string;
    return_required?: boolean;
    allow_over?: boolean;
  },
): Promise<{ error?: string; needsApproval?: boolean; cap?: number }> {
  const access = await checkOperator();
  if (!access.ok) return { error: access.error };
  const supabase = await createClient();

  const { data: line, error: getErr } = await (supabase.from('procurement_line_items') as any)
    .select('id, order_id, line_status, ordered_unit, ordered_qty, material_name, po_no, purchase_order_id')
    .eq('id', lineItemId).single();
  if (getErr || !line) return { error: getErr?.message || '采购行不存在' };

  // 内控:未下单(草稿/待审批采购单)不得收货
  if ((line as any).purchase_order_id) {
    const { data: po } = await (supabase.from('purchase_orders') as any).select('status').eq('id', (line as any).purchase_order_id).maybeSingle();
    if ((po as any)?.status === 'draft') return { error: '采购单尚未下单(需先审批通过并下单),不能收货。' };
  }

  const nextStatus = payload.result === 'pass' ? 'accepted'
    : payload.result === 'concession' ? 'concession' : 'rejected';
  if (!isValidLineTransition(line.line_status, nextStatus as ProcurementLineStatus)) {
    return { error: `仅「已到厂」可验收（当前：${LINE_STATUS_LABELS[line.line_status as ProcurementLineStatus] || line.line_status}）` };
  }
  if (payload.result === 'concession' && !canApproveConcession(access.roles || [])) {
    return { error: '让步接收需采购经理或管理员审批' };
  }
  if (!(payload.received_qty >= 0)) return { error: '实收数量无效' };

  // 收货 ±10% 硬闸(与批次收货同口径;拒收 result=reject 不计超收——本就是不入账退货)
  if (payload.result !== 'reject') {
    const { data: prev } = await (supabase.from('goods_receipts') as any)
      .select('received_qty').eq('line_item_id', lineItemId).neq('inspection_result', 'reject');
    const prevTotal = ((prev || []) as any[]).reduce((s, r) => s + (Number(r.received_qty) || 0), 0);
    const gate = overReceiptCheck(line.ordered_qty, prevTotal, payload.received_qty);
    if (gate.over) {
      const isFinance = access.roles?.some(r => ['finance', 'admin'].includes(r));
      if (!payload.allow_over) {
        await notifyFinanceOverReceipt(supabase, line, gate);
        return { error: `⚠ 验收累计 ${gate.projected}${line.ordered_unit || ''} 将超采购量 ${gate.ordered} 的 10%(上限 ${gate.cap})。已拦截并通知财务:审批放行 / 退回布行 / 布行补足 / 超出搁置。`, needsApproval: true, cap: gate.cap };
      }
      if (!isFinance) return { error: '超采购量 10% 需财务放行' };
    }
  }

  const now = new Date().toISOString();
  const { error: grErr } = await (supabase.from('goods_receipts') as any).insert({
    line_item_id: lineItemId, order_id: line.order_id,
    received_qty: payload.received_qty,
    received_unit: payload.received_unit || line.ordered_unit || null,
    received_by: access.userId,
    inspection_result: payload.result === 'pass' ? 'pass' : payload.result === 'concession' ? 'concession' : 'reject',
    aql_level: payload.aql_level || null,
    defect_notes: payload.defect_notes || null,
    concession_approved_by: payload.result === 'concession' ? access.userId : null,
    return_required: payload.result === 'reject' ? (payload.return_required ?? true) : false,
    return_status: payload.result === 'reject' ? 'pending' : null,
  });
  if (grErr) return { error: grErr.message };

  // 汇总该行【合格】已验收数量，回写 received_qty —— 与上方超收闸同口径排除拒收(reject 是退货、不入实收)。
  // 修 P1(2026-07-09 审计):此前含拒收批次 → 拒收料被当良品入库 + 按拒收量核销应付 + 顶到订购量误判「料齐」。
  const { data: receipts } = await (supabase.from('goods_receipts') as any)
    .select('received_qty').eq('line_item_id', lineItemId).neq('inspection_result', 'reject');
  const totalReceived = (receipts || []).reduce((s: number, r: any) => s + (Number(r.received_qty) || 0), 0);

  const { error: upErr } = await (supabase.from('procurement_line_items') as any)
    .update({ line_status: nextStatus, received_qty: totalReceived, received_at: now, received_by: access.userId, updated_at: now })
    .eq('id', lineItemId);
  if (upErr) return { error: upErr.message };

  // W1: QC 验收也自动入库(增量 delta,与 recordReceipt 同函数,补挂不双计)。
  try {
    const { recordInventoryReceipt } = await import('@/app/actions/inventory');
    await recordInventoryReceipt(lineItemId);
  } catch (e: any) { console.warn('[recordGoodsReceipt] 自动入库失败(不阻断验收,库存可能滞后):', e?.message); }

  // B3a: QC 验收 → 联动关联采购项收货状态(fire-and-forget)。
  try {
    const { syncProcurementItemReceivingStatus } = await import('@/app/actions/procurement-items');
    await syncProcurementItemReceivingStatus(line.order_id);
  } catch (e: any) { console.warn('[recordGoodsReceipt] 采购项状态联动失败(不阻断验收):', e?.message); }

  // 收货回财务(审计修 2026-07-04):按实收 + 验收结论 冲销核销应付
  try {
    const { syncGoodsReceiptToFinance } = await import('@/lib/integration/finance-sync');
    await syncGoodsReceiptToFinance({ po_no: (line as any).po_no ?? null, line_id: lineItemId, order_id: line.order_id,
      material_name: (line as any).material_name ?? null, ordered_qty: (line as any).ordered_qty ?? null,
      received_qty_total: totalReceived, inspection_result: payload.result, line_status: nextStatus });
  } catch (e: any) { console.warn('[recordGoodsReceipt] 收货回财务失败(不阻断):', e?.message); }

  await logProcurement(supabase, lineItemId, line.order_id, 'inspect',
    line.line_status, nextStatus,
    `验收 ${payload.result === 'pass' ? '通过' : payload.result === 'concession' ? '让步接收' : '拒收'}：实收 ${payload.received_qty}${payload.defect_notes ? '，' + payload.defect_notes : ''}`,
    { result: payload.result, received_qty: payload.received_qty, aql: payload.aql_level });

  revalidatePath(`/orders/${line.order_id}`);
  revalidatePath('/procurement');
  return {};
}

/**
 * 收货登记(分时间分批次)—— 每批追加 goods_receipts 一行,自动汇总回写 received_qty,
 * 未收齐留在「待验收」可继续录下一批,收齐(或勾"收齐")→ accepted 离队。码单存 order-docs(photos jsonb)。
 * 与 recordGoodsReceipt(QC 让步/拒收)分工:本函数=实收入账的日常收货。
 */
export async function recordReceiptBatch(
  lineItemId: string,
  payload: { received_qty: number; received_date?: string; slip_paths?: string[]; note?: string; received_address?: string; mark_complete?: boolean; allow_over?: boolean },
): Promise<{ error?: string; ok?: boolean; total_received?: number; ordered?: number; complete?: boolean; needsApproval?: boolean; cap?: number }> {
  const access = await checkOperator();
  if (!access.ok || !access.userId) return { error: access.error };
  if (!(payload.received_qty > 0)) return { error: '本批实收数量必须大于 0' };
  const supabase = await createClient();

  const { data: line } = await (supabase.from('procurement_line_items') as any)
    .select('id, order_id, line_status, ordered_qty, ordered_unit, received_qty, material_name, po_no').eq('id', lineItemId).single();
  if (!line) return { error: '采购行不存在' };

  const now = new Date().toISOString();

  // ── 收货 ±10% 硬闸(统一纯函数 overReceiptCheck)──
  {
    const { data: prev } = await (supabase.from('goods_receipts') as any).select('received_qty').eq('line_item_id', lineItemId).neq('inspection_result', 'reject');
    const prevTotal = ((prev || []) as any[]).reduce((s, r) => s + (Number(r.received_qty) || 0), 0);
    const gate = overReceiptCheck(line.ordered_qty, prevTotal, payload.received_qty);
    if (gate.over) {
      const isFinance = access.roles?.some(r => ['finance', 'admin'].includes(r));
      if (!payload.allow_over) {
        await notifyFinanceOverReceipt(supabase, line, gate);
        return {
          error: `⚠ 累计收货 ${gate.projected}${line.ordered_unit || ''} 将超采购量 ${gate.ordered} 的 10%(上限 ${gate.cap})。已拦截并通知财务。处理方向:①财务审批放行 ②退回布行 ③让布行补足到量 ④超出部分搁置等待。`,
          needsApproval: true, cap: gate.cap,
        };
      }
      if (!isFinance) return { error: '超采购量 10% 需财务放行,你的角色不可勾「超收放行」;请联系财务审批' };
    }
  }
  const receivedAt = payload.received_date ? new Date(payload.received_date + 'T00:00:00+08:00').toISOString() : now;

  // 1. 追加一批
  const { error: grErr } = await (supabase.from('goods_receipts') as any).insert({
    line_item_id: lineItemId, order_id: line.order_id,
    received_qty: payload.received_qty, received_unit: line.ordered_unit || null,
    received_at: receivedAt, received_by: access.userId,
    inspection_result: 'pass',
    defect_notes: payload.note || null,
    received_address: payload.received_address || null,
    photos: (payload.slip_paths && payload.slip_paths.length) ? payload.slip_paths : null,
  });
  if (grErr) {
    // received_address 列(20260711 迁移)未跑 → 降级去掉该列重试,收货不阻断
    if (/received_address|column .* does not exist|schema cache/i.test(grErr.message || '')) {
      const { error: grErr2 } = await (supabase.from('goods_receipts') as any).insert({
        line_item_id: lineItemId, order_id: line.order_id,
        received_qty: payload.received_qty, received_unit: line.ordered_unit || null,
        received_at: receivedAt, received_by: access.userId, inspection_result: 'pass',
        defect_notes: payload.note || null,
        photos: (payload.slip_paths && payload.slip_paths.length) ? payload.slip_paths : null,
      });
      if (grErr2) return { error: grErr2.message };
    } else return { error: grErr.message };
  }

  // 2. 汇总实收 → 回写
  const { data: receipts } = await (supabase.from('goods_receipts') as any).select('received_qty').eq('line_item_id', lineItemId).neq('inspection_result', 'reject');
  const total = ((receipts || []) as any[]).reduce((s, r) => s + (Number(r.received_qty) || 0), 0);
  const ordered = Number(line.ordered_qty) || 0;
  const complete = payload.mark_complete === true || (ordered > 0 && total >= ordered);
  const nextStatus = complete ? 'accepted' : 'arrived';   // 收齐→离队;未齐→留待验收继续录
  await (supabase.from('procurement_line_items') as any).update({
    received_qty: total, received_at: now, received_by: access.userId, line_status: nextStatus, updated_at: now,
  }).eq('id', lineItemId);

  // 3. 自动入库(增量 delta)
  try { const { recordInventoryReceipt } = await import('@/app/actions/inventory'); await recordInventoryReceipt(lineItemId); }
  catch (e: any) { console.warn('[recordReceiptBatch] 自动入库失败(不阻断):', e?.message); }
  // 4. 联动采购项收货状态
  try { const { syncProcurementItemReceivingStatus } = await import('@/app/actions/procurement-items'); await syncProcurementItemReceivingStatus(line.order_id); }
  catch (e: any) { console.warn('[recordReceiptBatch] 采购项联动失败(不阻断):', e?.message); }
  // 5. 收货回财务(审计修 2026-07-04):按累计实收冲销核销应付
  try {
    const { syncGoodsReceiptToFinance } = await import('@/lib/integration/finance-sync');
    await syncGoodsReceiptToFinance({ po_no: (line as any).po_no ?? null, line_id: lineItemId, order_id: line.order_id,
      material_name: (line as any).material_name ?? null, ordered_qty: ordered,
      received_qty_total: total, line_status: nextStatus });
  } catch (e: any) { console.warn('[recordReceiptBatch] 收货回财务失败(不阻断):', e?.message); }

  await logProcurement(supabase, lineItemId, line.order_id, 'receive', line.line_status, nextStatus,
    `收货登记:本批 ${payload.received_qty}${line.ordered_unit || ''},累计 ${total}/${ordered}${complete ? '(已收齐)' : ''}${payload.allow_over ? ' [财务超收放行]' : ''}`,
    { batch: payload.received_qty, total, allow_over: !!payload.allow_over });
  revalidatePath(`/orders/${line.order_id}`);
  revalidatePath('/procurement');
  return { ok: true, total_received: total, ordered, complete };
}

/** 某采购行的全部收货批次(含码单 signed URL)。 */
export async function listReceiptBatches(lineItemId: string): Promise<{ data?: any[]; error?: string }> {
  const access = await checkAccess();   // 只读:可见采购的角色都能看(业务/生产/仓库也要看到货进度)
  if (!access.ok) return { error: access.error };
  const supabase = await createClient();
  const { data, error } = await (supabase.from('goods_receipts') as any)
    .select('id, received_qty, received_unit, received_at, defect_notes, photos, inspection_result')
    .eq('line_item_id', lineItemId).order('received_at', { ascending: true });
  if (error) return { error: error.message };
  const rows: any[] = [];
  for (const r of (data || []) as any[]) {
    const slipUrls: string[] = [];
    for (const p of (r.photos || [])) {
      const { data: signed } = await supabase.storage.from('order-docs').createSignedUrl(p, 3600);
      if (signed?.signedUrl) slipUrls.push(signed.signedUrl);
    }
    rows.push({ ...r, slip_urls: slipUrls });
  }
  return { data: rows };
}

// ── 采购中心工作队列（跨订单，供 /procurement 页只读渲染）──
export interface PendingApprovalPO {
  id: string;
  po_no: string | null;
  approval_status: string | null;   // pending=待审批 · not_required/approved=可下单(未 place)
  total_amount: number | null;
  price_tbd?: boolean;               // 价格待定:允许无底价下单
  supplier_name: string | null;
  reasons: string[];
  required_by: string[];
  orders: { order_no: string | null; internal_order_no: string | null; customer_name: string | null }[];
  // 疑重复下单:同订单+同物料被别的活动采购单也覆盖(只读警示,交采购判断删哪张)
  dupWith?: { po_no: string | null; status: string | null; materials: string[] }[];
}

export interface QueueLine {
  id: string;
  order_id: string;
  order_no: string | null;
  internal_order_no: string | null;   // 内部单号(财务核算口径,随行显示)
  customer_name: string | null;
  material_name: string;
  color: string | null;             // 经 procurement_item_id 回查(执行行无颜色列),区分同料不同色
  category: string | null;
  supplier_name: string | null;
  line_status: string;
  required_by: string | null;
  promised_date: string | null;
  expected_arrival: string | null;
  po_no: string | null;
  purchase_order_id: string | null;   // 已挂到某采购单(即使未 placed)→ 不再算"待下单"
  procurement_item_id: string | null; // 归并层采购项 id(核料页按此聚焦单料;2026-07-09)
  unit_price: number | null;
  price_variance_pct: number | null;
  ordered_qty: number | null;
  ordered_unit: string | null;
  received_qty: number | null;   // 已收(累计);未到货 = ordered_qty − received_qty
  chase_count: number | null;
  last_chased_at: string | null;
  lamp: 'red' | 'yellow' | 'green' | null;
  // 内控:所在采购单尚未下单(草稿/待审批/驳回)。即便 line_status 已到 arrived,也是绕过审批闸的脏数据,
  // 前端不给验收/催货按钮,引导先去审批下单(2026-07-06 用户实测发现)。
  po_not_placed?: boolean;
}

/** 待采购订单(业务执行已提交采购申请,采购尚未完成下单)—— 订单级卡片 */
export interface PendingProcurementOrder {
  order_id: string;
  order_no: string | null;
  internal_order_no: string | null;  // 内部单号(订单册编号,财务核算口径)
  customer_name: string | null;
  submitted_at: string | null;   // 业务提交采购申请的时间(MRP 生成时间)
  req_count: number;             // 需求条数
  late_count: number;            // 已过最晚下单日的需求数(紧急)
}

export async function getProcurementQueues(): Promise<{
  data?: {
    /** 待采购订单:业务执行提交了采购申请 → 采购必须看见;完成「采购下单」节点后自动消失 */
    pendingRequests: PendingProcurementOrder[];
    pendingOrder: QueueLine[];
    chase: QueueLine[];
    readyShip: QueueLine[];
    receive: QueueLine[];
    pendingApprovalPOs: PendingApprovalPO[];
    counts: { pendingRequests: number; pendingOrder: number; chase: number; readyShip: number; receive: number; pendingApproval: number; red: number; overdueOrders: number; atRiskOrders: number };
  };
  error?: string;
}> {
  const auth = await checkAccess(); // 查看权限沿用较宽的 ALLOWED_ROLES(含 sales)
  if (!auth.ok) return { error: auth.error };
  const canSeeFloor = hasRoleInGroup(auth.roles || [], 'CAN_SEE_PROCUREMENT_FLOOR');
  const supabase = await createClient();

  const { computeLineLamp } = await import('@/lib/domain/procurement');

  // ── 待采购订单(2026-07-03:业务执行「提交采购」后,采购中心必须出现这张订单)──
  // 信号 = material_plans 活跃(业务提交采购申请生成);消失 = 该单「采购下单」节点完成。
  const pendingRequests: PendingProcurementOrder[] = [];
  try {
    const { data: plans } = await (supabase.from('material_plans') as any)
      .select('order_id, mrp_generated_at, orders(order_no, internal_order_no, customer_name, lifecycle_status)')
      .eq('plan_status', 'active');
    const alive = (plans || []).filter((p: any) => {
      const ls = p.orders?.lifecycle_status || '';
      return !['completed', '已完成', 'cancelled', '已取消'].includes(ls);
    });
    const orderIds = alive.map((p: any) => p.order_id);
    if (orderIds.length > 0) {
      // 已完成「采购下单」节点的订单 → 出队
      const { data: doneMs } = await (supabase.from('milestones') as any)
        .select('order_id, status').in('order_id', orderIds).eq('step_key', 'procurement_order_placed');
      const doneOrders = new Set((doneMs || [])
        .filter((m: any) => ['done', '已完成'].includes(String(m.status || '').toLowerCase()))
        .map((m: any) => m.order_id));
      // 需求条数 + 紧急数(过最晚下单日)
      const { data: reqs } = await (supabase.from('material_requirements') as any)
        .select('order_id, timing_status').in('order_id', orderIds);
      const reqCount = new Map<string, number>();
      const lateCount = new Map<string, number>();
      for (const r of (reqs || [])) {
        reqCount.set(r.order_id, (reqCount.get(r.order_id) || 0) + 1);
        if (r.timing_status === 'late') lateCount.set(r.order_id, (lateCount.get(r.order_id) || 0) + 1);
      }
      // 自愈(2026-07-03):已全部下单但节点没完成的订单(如钩子上线前下的单)
      // → 顺手自动完成「采购下单」节点并本次出队,不再挂着"待采购"
      const { data: allItems } = await (supabase.from('procurement_items') as any)
        .select('id, order_id, status').in('order_id', orderIds);
      const ORDERED = ['ordered', 'partially_received', 'completed', 'closed'];
      const itemsByOrder = new Map<string, Array<{ id: string; status: string }>>();
      for (const it of (allItems || [])) {
        const arr = itemsByOrder.get(it.order_id) || [];
        arr.push({ id: it.id, status: it.status }); itemsByOrder.set(it.order_id, arr);
      }
      // 某采购项是否已进某采购单(执行行挂了 purchase_order_id)——已进 PO(即使待审批/未 placed)= 核料下单做完,
      // 与线级队列 2026-07-04 口径对齐(挂 PO 的行不再算待下单,改横幅露出)。修:同一单收货后不再重复挂"待采购"。
      const { data: poLines } = await (supabase.from('procurement_line_items') as any)
        .select('procurement_item_id, purchase_order_id').in('order_id', orderIds);
      const itemsInPO = new Set<string>();
      for (const l of (poLines || [])) { if (l.procurement_item_id && l.purchase_order_id) itemsInPO.add(l.procurement_item_id); }
      for (const p of alive) {
        if (doneOrders.has(p.order_id)) continue;
        const items = itemsByOrder.get(p.order_id) || [];
        // 还留在"待采购订单"的唯一条件:仍有采购项 既未下单+及以后、又没进任何采购单(= 真的还要去核料下单)。
        // 全部已下单 或 已进 PO(待审批的也算)→ 出队;剩下的审批/催货/验收由待审批横幅+线级队列露出,不重复。
        const stillNeedsCore = items.some(it => !ORDERED.includes(it.status) && !itemsInPO.has(it.id));
        if (items.length > 0 && !stillNeedsCore) {
          // 仅当真全部 ordered(PO 已 placed)才自愈「采购下单」里程碑;仅"进了待审批 PO"不算下单完成,不误标里程碑。
          if (items.every(it => ORDERED.includes(it.status))) {
            try {
              const { autoCompleteProcurementPlacedForOrder } = await import('@/app/actions/procurement-items');
              void autoCompleteProcurementPlacedForOrder(supabase, p.order_id).catch(() => {});
            } catch { /* 自愈失败不影响队列出队 */ }
          }
          continue;   // ← 出队(核料下单已做完,不再重复显示待采购/去核料)
        }
        pendingRequests.push({
          order_id: p.order_id,
          order_no: p.orders?.order_no ?? null,
          internal_order_no: p.orders?.internal_order_no ?? null,
          customer_name: p.orders?.customer_name ?? null,
          submitted_at: p.mrp_generated_at ?? null,
          req_count: reqCount.get(p.order_id) || 0,
          late_count: lateCount.get(p.order_id) || 0,
        });
      }
      pendingRequests.sort((a, b) => (b.late_count - a.late_count) || String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')));
    }
  } catch (e: any) {
    console.warn('[getProcurementQueues] 待采购订单查询失败(不阻断其余队列):', e?.message);
  }

  // 基础读走用户会话(RLS 管范围),不含已封锁的 unit_price(price_variance_pct 是百分比、非绝对价,保留);
  // 底价对 floor 角色在下方经 service-role 补(此前此处直接返回 unit_price 未剥离,是泄价点)。
  const QUEUE_STATES = ['pending_order', 'ordered', 'confirmed', 'in_production', 'ready_to_ship', 'shipped', 'arrived'];
  const SEL_NO_SIZE = 'id, order_id, material_name, category, supplier_name, line_status, required_by, promised_date, expected_arrival, po_no, purchase_order_id, procurement_item_id, price_variance_pct, ordered_qty, ordered_unit, received_qty, chase_count, last_chased_at, orders(order_no, internal_order_no, customer_name, lifecycle_status)';
  let { data, error } = await (supabase.from('procurement_line_items') as any)
    .select(`id, order_id, material_name, category, size, supplier_name, line_status, required_by, promised_date, expected_arrival, po_no, purchase_order_id, procurement_item_id, price_variance_pct, ordered_qty, ordered_unit, received_qty, chase_count, last_chased_at, orders(order_no, internal_order_no, customer_name, lifecycle_status)`)
    .in('line_status', QUEUE_STATES);
  // ⚠ size 列(N1)若 PostgREST schema 缓存未刷新/迁移未应用 → 选它整查会 error。
  //   绝不能让"新列"把采购中心整个变空 → 降级去掉 size 重查(尺码徽章暂不显示,功能不瘫)。
  if (error && /size|schema cache|column|does not exist|permission denied/i.test(error.message || '')) {
    // size 列未授权(列级 GRANT 不含新列)/schema 缓存陈旧 → 降级不带 size,采购中心不因新列变空
    console.warn('[getProcurementQueues] size 列不可选,降级不带 size:', error.message);
    ({ data, error } = await (supabase.from('procurement_line_items') as any).select(SEL_NO_SIZE).in('line_status', QUEUE_STATES));
  }
  if (error) return { error: error.message };

  // 颜色回查:执行行无颜色列,经 procurement_item_id → procurement_items.color(同料不同色才分得清)
  const piIds = [...new Set((data || []).map((r: any) => r.procurement_item_id).filter(Boolean))];
  const colorByPi = new Map<string, string | null>();
  if (piIds.length > 0) {
    const { data: pis } = await (supabase.from('procurement_items') as any).select('id, color').in('id', piIds);
    for (const p of (pis || [])) colorByPi.set(p.id, p.color ?? null);
  }

  const now = new Date();
  const rows: QueueLine[] = (data || [])
    .filter((r: any) => {
      const ls = r.orders?.lifecycle_status || '';
      return !['completed', '已完成', 'cancelled', '已取消'].includes(ls);
    })
    .map((r: any) => ({
      id: r.id, order_id: r.order_id,
      order_no: r.orders?.order_no ?? null, internal_order_no: r.orders?.internal_order_no ?? null,
      customer_name: r.orders?.customer_name ?? null,
      material_name: r.material_name, color: r.procurement_item_id ? (colorByPi.get(r.procurement_item_id) ?? null) : null,
      category: r.category, supplier_name: r.supplier_name,
      line_status: r.line_status, required_by: r.required_by,
      promised_date: r.promised_date, expected_arrival: r.expected_arrival,
      po_no: r.po_no, purchase_order_id: r.purchase_order_id, procurement_item_id: r.procurement_item_id ?? null, unit_price: r.unit_price, price_variance_pct: r.price_variance_pct,
      ordered_qty: r.ordered_qty, ordered_unit: r.ordered_unit,
      received_qty: r.received_qty ?? null,
      chase_count: r.chase_count, last_chased_at: r.last_chased_at,
      lamp: computeLineLamp(r, { now }),
    }));

  // floor 角色 → 经 service-role 补回底价(基础读已剥离);非 floor 的 unit_price 保持 undefined
  if (canSeeFloor && rows.length) {
    const costs = await fetchLineCostsByIds(rows.map((r) => r.id));
    for (const r of rows) { const c = costs.get(r.id); if (c) r.unit_price = c.unit_price; }
  }

  // 内控标记(2026-07-06):挂在"尚未下单"采购单(草稿 / 待审批 / 已驳回)上的行 → po_not_placed。
  // 这类行即便 line_status 已被绕过闸推到 arrived,也不给验收/催货按钮,引导先去审批下单。
  // 用 service-role 查 PO 状态,避免 RLS 让某些 PO 查不到 → 误判为"已下单"仍露按钮。
  try {
    const linePoIds = [...new Set(rows.map((r) => r.purchase_order_id).filter(Boolean))] as string[];
    if (linePoIds.length) {
      const svcPo = createServiceRoleClient();
      const { data: poStatuses } = await (svcPo.from('purchase_orders') as any)
        .select('id, status, approval_status').in('id', linePoIds);
      const blockedPo = new Set<string>();
      for (const p of (poStatuses || [])) {
        if (p.status === 'draft' || ['pending', 'rejected'].includes(p.approval_status)) blockedPo.add(p.id);
      }
      for (const r of rows) { if (r.purchase_order_id && blockedPo.has(r.purchase_order_id)) r.po_not_placed = true; }
    }
  } catch (e: any) { console.warn('[getProcurementQueues] PO 下单状态标记失败(不阻断):', e?.message); }

  const lampRank = (l: string | null) => (l === 'red' ? 0 : l === 'yellow' ? 1 : l === 'green' ? 2 : 3);
  const byLamp = (a: QueueLine, b: QueueLine) => lampRank(a.lamp) - lampRank(b.lamp);
  // 待验收排序(2026-07-09 用户:顺序乱)——按 类别→料名→颜色,同类同料聚一起(与采购对账同口径,好点货)
  const CAT_RANK: Record<string, number> = { fabric: 0, lining: 1, trim: 3, label: 4, zipper: 5, button: 6, elastic: 7, packing: 8, other: 9 };
  const catRank = (c?: string | null) => CAT_RANK[String(c || 'other')] ?? 2;   // 未知类目排面料/里料之后、辅料之间
  const zh = (s: unknown) => String(s ?? '');
  const byReceive = (a: QueueLine, b: QueueLine) =>
    catRank(a.category) - catRank(b.category)
    || zh(a.material_name).localeCompare(zh(b.material_name), 'zh')
    || zh((a as any).color).localeCompare(zh((b as any).color), 'zh');

  // 2026-07-03 用户拍板四段:待下单 / 待催货(生产中) / 已完成待送货+在途 / 已送达待验收
  // 2026-07-04 修:已挂到采购单的行(即使 PO 还没 placed/待审批)不再算"待下单",否则
  // 建了单还显示"可下单",且撞审批闸后一直挂着,业务困惑。这些行改到「待审批采购单」露出。
  const pendingOrder = rows.filter(r => r.line_status === 'pending_order' && !r.purchase_order_id).sort(byLamp);
  const chase = rows.filter(r => ['ordered', 'confirmed', 'in_production'].includes(r.line_status)).sort(byLamp);
  const readyShip = rows.filter(r => ['ready_to_ship', 'shipped'].includes(r.line_status)).sort(byLamp);
  const receive = rows.filter(r => r.line_status === 'arrived').sort(byReceive);

  // 待审批采购单:已建、撞风险闸卡在 pending 的采购单(下单没走完的真相在这)。
  const pendingApprovalPOs: PendingApprovalPO[] = [];
  const draftOrderIdsByPo = new Map<string, string[]>();   // 草稿 PO → 关联订单(疑重复检测用)
  try {
    // 审计修(2026-07-04):放宽到所有草稿采购单(不只待审批)——归单后未 place 的草稿单
    // (approval_status=not_required/approved)本来会从所有队列消失(已挂 PO→不在待下单;未 place→不在待催货),
    // 形成盲区。全部露在横幅,按 approval_status 区分"待审批 / 可下单"。
    // select * :price_tbd 列未建(迁移未跑)也不报错,拿到什么用什么(避免整条 banner 查询挂掉)
    const { data: pos } = await (supabase.from('purchase_orders') as any)
      .select('*, suppliers(name)')
      .eq('status', 'draft');
    const poOrderIds = [...new Set((pos || []).flatMap((p: any) => p.order_ids || []))];
    const poOrderMap = new Map<string, any>();
    if (poOrderIds.length > 0) {
      const { data: pords } = await (supabase.from('orders') as any)
        .select('id, order_no, internal_order_no, customer_name, lifecycle_status').in('id', poOrderIds);
      for (const o of (pords || [])) poOrderMap.set(o.id, o);
    }
    const ORD_DEAD = ['cancelled', '已取消', 'archived', '已归档'];
    for (const p of (pos || [])) {
      // 隐藏"为已取消订单建的采购单"(2026-07-05):该 PO 所有关联订单都已取消/归档 → 跳过,别在待审批堆里占位
      const oids: string[] = p.order_ids || [];
      if (oids.length > 0 && oids.every((oid: string) => ORD_DEAD.includes(poOrderMap.get(oid)?.lifecycle_status))) continue;
      draftOrderIdsByPo.set(p.id, oids);
      pendingApprovalPOs.push({
        id: p.id, po_no: p.po_no, approval_status: p.approval_status ?? null,
        total_amount: canSeeFloor ? (p.total_amount ?? null) : null,
        price_tbd: p.price_tbd === true,
        supplier_name: p.suppliers?.name ?? null,
        reasons: p.approval_reasons || [], required_by: p.approval_required_by || [],
        orders: (p.order_ids || []).map((oid: string) => {
          const o = poOrderMap.get(oid);
          return { order_no: o?.order_no ?? null, internal_order_no: o?.internal_order_no ?? null, customer_name: o?.customer_name ?? null };
        }),
      });
    }
  } catch (e: any) { console.warn('[getProcurementQueues] 待审批采购单查询失败:', e?.message); }

  // ── 疑重复下单检测(只读警示)────────────────────────────────────────
  // 同一订单 + 同一物料被多张【活动】采购单覆盖 = 疑重复(把同批料建了两张单/忘了已下过)。
  // 结构上一条核料行只能归一张单,故按 (order_id|物料名) 跨单比对;命中就在草稿箱标警,交采购判断删哪张。
  try {
    const allDraftOrderIds = [...new Set([...draftOrderIdsByPo.values()].flat())] as string[];
    if (pendingApprovalPOs.length > 0 && allDraftOrderIds.length > 0) {
      const { data: covLines } = await (supabase.from('procurement_line_items') as any)
        .select('purchase_order_id, order_id, material_name, line_status')
        .in('order_id', allDraftOrderIds).not('purchase_order_id', 'is', null);
      const rows = (covLines || []) as any[];
      const poIds = [...new Set(rows.map((l) => l.purchase_order_id).filter(Boolean))] as string[];
      const poMeta = new Map<string, { po_no: string | null; status: string | null }>();
      if (poIds.length > 0) {
        const { data: poRows } = await (supabase.from('purchase_orders') as any)
          .select('id, po_no, status').in('id', poIds);
        for (const p of (poRows || [])) poMeta.set(p.id, { po_no: p.po_no ?? null, status: p.status ?? null });
      }
      const norm = (s: any) => String(s ?? '').trim().toLowerCase();
      // 覆盖键 (order_id||物料) → 覆盖它的活动 PO 集合(排除已取消行/已取消单)
      const keyToPos = new Map<string, Set<string>>();
      const poKeys = new Map<string, Set<string>>();
      const keyToName = new Map<string, string>();   // 覆盖键 → 原始物料名(展示用,不用小写键)
      for (const l of rows) {
        if (l.line_status === 'cancelled') continue;
        const meta = poMeta.get(l.purchase_order_id);
        if (!meta || meta.status === 'cancelled') continue;
        const mat = norm(l.material_name); if (!mat) continue;
        const key = `${l.order_id}||${mat}`;
        if (!keyToName.has(key)) keyToName.set(key, String(l.material_name || '').trim());
        (keyToPos.get(key) || keyToPos.set(key, new Set()).get(key)!).add(l.purchase_order_id);
        (poKeys.get(l.purchase_order_id) || poKeys.set(l.purchase_order_id, new Set()).get(l.purchase_order_id)!).add(key);
      }
      for (const p of pendingApprovalPOs) {
        const myKeys = poKeys.get(p.id); if (!myKeys) continue;
        const byOther = new Map<string, { po_no: string | null; status: string | null; materials: Set<string> }>();
        for (const key of myKeys) {
          const mat = keyToName.get(key) || key.split('||')[1];
          for (const otherId of (keyToPos.get(key) || [])) {
            if (otherId === p.id) continue;
            const om = poMeta.get(otherId); if (!om) continue;
            const agg = byOther.get(otherId) || { po_no: om.po_no, status: om.status, materials: new Set<string>() };
            agg.materials.add(mat); byOther.set(otherId, agg);
          }
        }
        if (byOther.size > 0) {
          p.dupWith = [...byOther.values()].map((v) => ({ po_no: v.po_no, status: v.status, materials: [...v.materials] }));
        }
      }
    }
  } catch (e: any) { console.warn('[getProcurementQueues] 疑重复检测失败(不阻断):', e?.message); }

  return {
    data: {
      pendingRequests, pendingOrder, chase, readyShip, receive, pendingApprovalPOs,
      counts: {
        pendingRequests: pendingRequests.length,
        pendingOrder: pendingOrder.length, chase: chase.length,
        readyShip: readyShip.length, receive: receive.length,
        pendingApproval: pendingApprovalPOs.length,
        red: rows.filter(r => r.lamp === 'red').length,
        // 到货逾期订单:有 ≥1 行预计到货晚于要求日(red 灯)的不同订单数
        overdueOrders: new Set(rows.filter(r => r.lamp === 'red').map(r => r.order_id)).size,
        // 需抓紧追(有可能逾期):有 ≥1 行临近要求日(yellow 灯)、尚未逾期的不同订单数
        atRiskOrders: new Set(rows.filter(r => r.lamp === 'yellow').map(r => r.order_id)).size,
      },
    },
  };
}

// ── 采购风险中心（只读，读物化好的 procurement_matters）──
export type ProcurementMatterType =
  | 'material_shortage' | 'supplier_delay' | 'chase_stalled'
  | 'price_anomaly' | 'quality_reject' | 'risk_schedule';

export interface RiskMatter {
  id: string;
  order_id: string | null;
  order_no: string | null;
  line_item_id: string | null;
  matter_type: ProcurementMatterType;
  severity: 'high' | 'medium';
  title: string;
  evidence: Record<string, any>;
  detected_at: string;
}

/**
 * 采购风险中心数据（只读）。读 nightly cron 物化的 procurement_matters，
 * 按严重度→检出时间排序。CEO/PM 看汇总、点订单下钻；零页面计算。
 */
export async function getProcurementMatters(): Promise<{
  data?: { matters: RiskMatter[]; counts: { total: number; high: number; medium: number } };
  error?: string;
}> {
  const auth = await checkAccess();
  if (!auth.ok) return { error: auth.error };
  const canSeeFloor = hasRoleInGroup(auth.roles || [], 'CAN_SEE_PROCUREMENT_FLOOR');
  const supabase = await createClient();

  const { data, error } = await (supabase.from('procurement_matters') as any)
    .select('id, order_id, order_no, line_item_id, matter_type, severity, title, evidence, detected_at')
    .order('severity', { ascending: true }) // 'high' < 'medium' 字典序：high 在前
    .order('detected_at', { ascending: true });
  if (error) return { error: error.message };

  let matters: RiskMatter[] = (data || []) as RiskMatter[];
  // 审计 P0(2026-07-04):price_anomaly 事项的 title/evidence 内含底价(unit_price/price_baseline)。
  // 非 floor 角色(sales/merchandiser/production_manager 虽在 ALLOWED_ROLES 但不在 CAN_SEE_PROCUREMENT_FLOOR)
  // 直连调此 server action 会拿到底价 → 剥离绝对金额,只留百分比。
  if (!canSeeFloor) {
    matters = matters.map((m) => {
      if (m.matter_type !== 'price_anomaly') return m;
      const ev = { ...(m.evidence || {}) } as Record<string, any>;
      delete ev.unit_price; delete ev.price_baseline; delete ev.ordered_amount;
      const pct = (m.evidence as any)?.price_variance_pct;
      return {
        ...m, evidence: ev,
        title: `价格异常${pct != null ? `:高于历史中位约 ${pct}%` : ''}(金额对本角色隐藏)`,
      };
    });
  }
  return {
    data: {
      matters,
      counts: {
        total: matters.length,
        high: matters.filter(m => m.severity === 'high').length,
        medium: matters.filter(m => m.severity === 'medium').length,
      },
    },
  };
}

/**
 * 采购风险处置 · 填/改预计到货日(2026-07-05 P2)。采购把该料该供应商的在途行预计到货日填上:
 * ≤ 需求日 → 下次物化(≤15分钟)自动消红;> 需求日 → 如实显示"预计晚到",不再是"未定"。
 * 同料同供应商多色行一并更新。仅采购/管理员。
 */
export async function setRiskLineEta(input: { orderId: string; materialName: string; supplierId?: string | null; newEta: string }): Promise<{ ok?: boolean; updated?: number; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };
  const { data: prof } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (prof as any)?.roles?.length > 0 ? (prof as any).roles : [(prof as any)?.role].filter(Boolean);
  if (!roles.some((r) => ['procurement', 'procurement_manager', 'admin'].includes(r))) return { error: '仅采购/管理员可填预计到货日' };
  if (!input.orderId || !input.materialName) return { error: '缺少物料信息' };
  if (!input.newEta || !/^\d{4}-\d{2}-\d{2}$/.test(input.newEta)) return { error: '请选择预计到货日(YYYY-MM-DD)' };

  const svc = createServiceRoleClient();
  let q = (svc.from('procurement_line_items') as any)
    .update({ expected_arrival: input.newEta, updated_at: new Date().toISOString() })
    .eq('order_id', input.orderId).eq('material_name', input.materialName)
    .in('line_status', ['ordered', 'confirmed', 'in_production', 'ready_to_ship', 'shipped']);
  if (input.supplierId) q = q.eq('supplier_id', input.supplierId);
  const { data, error } = await q.select('id');
  if (error) return { error: error.message };
  revalidatePath('/procurement');
  return { ok: true, updated: (data || []).length };
}
