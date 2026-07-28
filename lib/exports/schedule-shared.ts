/**
 * 日程导出共享口径(2026-07-27)——订单日程 / 周日程 两个导出复用。
 * 阶段分组与 components/OrderTimeline.tsx 的 MILESTONE_GROUPS / SAMPLE / TRADE 保持一致
 * (那边是 client 组件,这里落成 server 可用的纯常量,避免跨端 import)。
 */

/** step_key → 阶段短标签(生产/打样/贸易口径统一;缺映射回落 '—')。 */
export const STAGE_OF_STEP: Record<string, string> = {
  // 阶段1 订单确认
  po_confirmed: '1·订单确认', pi_confirmed: '1·订单确认', finance_approval: '1·订单确认',
  // 阶段2 订单准备
  production_order_upload: '2·订单准备', order_kickoff_meeting: '2·订单准备', procurement_order_placed: '2·订单准备',
  order_docs_bom_complete: '2·订单准备', bulk_materials_confirmed: '2·订单准备', processing_fee_confirmed: '2·订单准备',
  factory_confirmed: '2·订单准备', materials_received_inspected: '2·订单准备', pre_production_meeting: '2·订单准备',
  // 阶段3 产前样
  pre_production_sample_ready: '3·产前样', pre_production_sample_sent: '3·产前样',
  pps_procurement_check: '3·产前样', pre_production_sample_approved: '3·产前样',
  // 阶段4 生产过程
  production_kickoff: '4·生产过程', mid_qc_check: '4·生产过程', mid_qc_sales_check: '4·生产过程',
  packing_method_confirmed: '4·生产过程', final_qc_check: '4·生产过程', final_qc_sales_check: '4·生产过程',
  factory_completion: '4·生产过程', leftover_collection: '4·生产过程',
  // 阶段5 出货与收款
  shipping_sample_send: '5·出货收款', ci_made: '5·出货收款', finished_goods_warehouse: '5·出货收款',
  inspection_release: '5·出货收款', booking_done: '5·出货收款', customs_export: '5·出货收款',
  finance_shipment_approval: '5·出货收款', shipment_execute: '5·出货收款', domestic_delivery: '5·出货收款',
  payment_received: '5·出货收款',
  // 打样
  sample_confirm: '样1·确认备料', sample_material: '样1·确认备料',
  sample_making: '样2·制作检验', sample_qc: '样2·制作检验',
  sample_shipping_arrange: '样3·寄样确认', sample_sent: '样3·寄样确认',
  sample_customer_confirm: '样3·寄样确认', sample_complete: '样3·寄样确认',
};

/** owner_role → 中文负责部门。 */
export const ROLE_LABEL: Record<string, string> = {
  sales: '业务', merchandiser: '业务执行(跟单)', finance: '财务', procurement: '采购',
  production: '生产', qc: '品控QC', logistics: '物流', admin: '管理', production_manager: '生产主管',
};
export function roleLabel(r?: string | null): string {
  return ROLE_LABEL[String(r || '')] || String(r || '—');
}

/** milestone.status → 中文短状态(与 OrderTimeline STATUS 同源)。 */
export function statusLabel(s?: string | null): string {
  const v = String(s || '').toLowerCase();
  if (v === 'done' || v === 'completed' || s === '已完成') return '已完成';
  if (v === 'in_progress' || s === '进行中') return '进行中';
  if (v === 'blocked' || s === '受阻' || s === '卡单' || s === '卡住' || s === '阻塞') return '受阻';
  return '未开始';
}
export function isDoneStatus(s?: string | null): boolean {
  const v = String(s || '').toLowerCase();
  return v === 'done' || v === 'completed' || s === '已完成';
}

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function weekdayCn(d: Date): string { return WEEKDAY_CN[d.getUTCDay()]; }

/** 传入任意时刻,返回其所在"周一 00:00 ~ 下周一 00:00"[start,end)(按北京时区周一为一周起点)。 */
export function beijingWeekRange(anchor: Date): { start: Date; end: Date; label: string } {
  // 北京 = UTC+8;把 anchor 挪到北京日历再取周一
  const bj = new Date(anchor.getTime() + 8 * 3600 * 1000);
  const dow = bj.getUTCDay(); // 0=周日..6=周六
  const backToMon = (dow + 6) % 7; // 距本周一的天数
  const monBjMidnight = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() - backToMon, 0, 0, 0);
  // 北京 00:00 = UTC 前一天 16:00
  const start = new Date(monBjMidnight - 8 * 3600 * 1000);
  const end = new Date(start.getTime() + 7 * 24 * 3600 * 1000);
  const startBj = new Date(start.getTime() + 8 * 3600 * 1000);
  const endBj = new Date(end.getTime() + 8 * 3600 * 1000 - 24 * 3600 * 1000);
  const fmt = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return { start, end, label: `${fmt(startBj)}~${fmt(endBj)}` };
}

/** due_at(UTC ISO)→ 北京日历 { dateStr:'MM/DD', weekday:'周一' }。 */
export function bjDayParts(iso: string): { dateStr: string; weekday: string; ymd: string } {
  const bj = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const dateStr = `${bj.getUTCMonth() + 1}/${bj.getUTCDate()}`;
  const ymd = `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`;
  return { dateStr, weekday: weekdayCn(bj), ymd };
}
