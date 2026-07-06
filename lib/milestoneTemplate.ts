export type OwnerRole =
  | "sales"
  | "merchandiser"
  | "finance"
  | "procurement"
  | "production"
  | "production_manager"
  | "admin_assistant"
  | "qc"
  | "logistics"
  | "admin";

/**
 * V1 托底闭环：21个里程碑模板
 * step_key 必须与 lib/schedule.ts calcDueDates() 返回的 key 一一对应
 *
 * 角色分工：
 * - sales: 业务（客户沟通、生产单制作、原辅料单制作、原辅料验收、产前样验收/寄送、包装确认、船样、订舱、报关）
 * - merchandiser: 跟单（生产单执行、工厂报价产能协调、产前样安排、产前会、生产进度跟进、中查尾查、验货放行）
 * - finance: 财务（PO审核、原辅料成本审核、货代费用审核、收款和出货许可）
 * - production_manager: 生产主管（加工费确认、生产协调）
 * - procurement: 采购（原辅料审核对比、价格谈判、采购计划、采购单下达、供应商跟进、大货品质确认）
 * - logistics: 物流（出货装货与运输事宜安排）
 */
export const MILESTONE_TEMPLATE_V1: Array<{
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
  evidence_note?: string;
}> = [
  // 2026-06-19 极简骨架(节拍器审计 134 单数据驱动):28 → 11,只保留真正"卡交付风险"的重点节点。
  //   被砍的(流程会议/重复预评估/低完成率 剩余物料回收12%·成品入库10%/与出货模块重复的核准/录入滞后的早期节点)
  //   不再占节拍;"料到没到"在【采购中心】可见、"哪个工厂"在订单字段可见,故不再单列节点。
  //   仅影响【新单】;存量 134 单结构不变(用时间线「只看关键」聚焦,关键回填见迁移)。
  //   排序=按 schedule.ts 工期(TIMELINE)递增,保证显示顺序与日期一致。
  { step_key: "po_confirmed", name: "PO确认", owner_role: "sales", is_critical: false, evidence_required: true },
  { step_key: "finance_approval", name: "财务审核", owner_role: "finance", is_critical: true, evidence_required: false },
  { step_key: "procurement_order_placed", name: "采购订单下达", owner_role: "procurement", is_critical: true, evidence_required: true },
  { step_key: "pre_production_sample_approved", name: "产前样客户确认", owner_role: "merchandiser", is_critical: true, evidence_required: true },
  { step_key: "production_kickoff", name: "生产启动/开裁", owner_role: "production", is_critical: true, evidence_required: false },
  { step_key: "final_qc_check", name: "跟单尾查", owner_role: "production", is_critical: true, evidence_required: true },
  { step_key: "factory_completion", name: "工厂完成", owner_role: "production", is_critical: true, evidence_required: false },
  { step_key: "inspection_release", name: "验货/放行", owner_role: "merchandiser", is_critical: true, evidence_required: true },
  { step_key: "booking_done", name: "订舱完成", owner_role: "merchandiser", is_critical: true, evidence_required: true },
  { step_key: "shipment_execute", name: "出运", owner_role: "logistics", is_critical: true, evidence_required: true },
  { step_key: "payment_received", name: "收款完成", owner_role: "finance", is_critical: true, evidence_required: false },
];

/**
 * 节点体系 V2(2026-07-03,9 节点,设计见 docs/Designs/Milestone-V2-Departments-Redesign.md)
 * 对齐五部门(业务执行/采购/生产[含QC]/财务)重构 + 用户拍板的 9 节点顺序。
 * 【模板版本化·决策③】只对新订单生效;在途订单已物化的里程碑行不动,仍走 V1。
 *
 * 与 V1 的结构差异:
 *  - finance_approval 并入 po_confirmed(PO确认=业务+财务双确认,同日) → 不再单列节点
 *  - 新增 mo_released(生产任务单下发,T+0,MO状态→executing 时自动完成)
 *  - 新增 pre_prod_meeting(产前会,T+2,业务+生产+采购三方)
 *  - 砍掉 factory_completion / inspection_release / booking_done(折进 shipment_execute「发货出运」)
 *
 * owner_role = 该节点的主责/牵头确认方(单人可完成)。多方(双/三方)确认机制为 P1b,
 * 届时挂到节点上;P1a 先把骨架、排期、自动完成钩子落地。
 * ⚠ owner_role 必须是 user_role 枚举合法值(无 'qc',QC 属生产部 → 用 'production')。
 */
export const MILESTONE_TEMPLATE_V2: Array<{
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
  evidence_note?: string;
}> = [
  { step_key: "po_confirmed", name: "PO确认", owner_role: "finance", is_critical: true, evidence_required: true,
    evidence_note: "财务确认 + 生产部确认(双确认;业务建单即已确认,不再自确认);财务核价格/账期,生产核订单要求/工艺" },
  { step_key: "mo_released", name: "生产任务单下发", owner_role: "sales", is_critical: false, evidence_required: false,
    evidence_note: "生产任务单状态推进到「已下发生产」时系统自动完成本节点" },
  { step_key: "pre_prod_meeting", name: "产前会", owner_role: "sales", is_critical: false, evidence_required: true,
    evidence_note: "业务执行 + 生产 + 采购 三方确认;上传产前会纪要" },
  { step_key: "procurement_order_placed", name: "采购下单", owner_role: "procurement", is_critical: true, evidence_required: true,
    evidence_note: "完成后开启采购进度共享(无价单 + 采购进度 tab)" },
  { step_key: "pre_production_sample_approved", name: "产前样确认", owner_role: "procurement", is_critical: true, evidence_required: true,
    evidence_note: "采购(原辅料大货品质) + 业务执行(客户/自确认) 双确认" },
  { step_key: "production_kickoff", name: "生产启动", owner_role: "production", is_critical: true, evidence_required: false,
    evidence_note: "生产 + QC;完成后开启 QC 日常跟单打卡" },
  { step_key: "final_qc_check", name: "尾查验货", owner_role: "production", is_critical: true, evidence_required: true,
    evidence_note: "业务执行 + QC 双确认;汇总打卡记录作为验货依据" },
  { step_key: "shipment_execute", name: "发货出运", owner_role: "logistics", is_critical: true, evidence_required: true,
    evidence_note: "业务执行 + 采购(尾料清点归库) + 财务 三方确认;含订舱/报关/出运" },
  { step_key: "payment_received", name: "收款完成", owner_role: "finance", is_critical: true, evidence_required: false,
    evidence_note: "按账期(发货日 + 账期天数);财务系统回传可自动完成" },
];

/**
 * 国内送仓订单需要跳过的出运节点
 * 这些节点只有出口订单（DDP）才需要
 * FOB / 人民币含税 / 人民币不含税 → 都走送仓流程
 */
const EXPORT_ONLY_STEPS = new Set([
  'shipping_sample_send',       // 船样寄送
  'booking_done',               // 订舱完成
  'customs_export',             // 报关安排出运
  'finance_shipment_approval',  // 核准出运
  'shipment_execute',           // 出运
]);

/**
 * 不需要产前样的订单跳过的节点
 * 适用于：客户直接用设计样 / 翻单 / 老款直接大货
 */
const PRE_PRODUCTION_SAMPLE_STEPS = new Set([
  'pre_production_sample_ready',
  'pre_production_sample_sent',
  'pre_production_sample_approved',
]);

/**
 * 样品阶段类型
 * confirmed     — 头样已确认，直接走产前样（默认流程）
 * dev_sample    — 需要先做头样，客户确认后再做产前样
 * dev_sample_with_revision — 需要做头样 + 预计可能需要二次样
 * skip_all      — 不需要产前样（翻单/老款/客户用设计样直接做大货）
 */
export type SamplePhase = 'confirmed' | 'dev_sample' | 'dev_sample_with_revision' | 'skip_all';

/**
 * 头样节点（插入在 factory_confirmed 之后、pre_production_sample_ready 之前）
 * 场景：客户下了PO但头样还没确认，需要先出头样给客户看
 */
const DEV_SAMPLE_MILESTONES: Array<{
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
  evidence_note?: string;
}> = [
  { step_key: "dev_sample_making", name: "头样制作", owner_role: "production", is_critical: true, evidence_required: true,
    evidence_note: "上传头样照片（正面/背面/细节/尺寸测量）" },
  { step_key: "dev_sample_sent", name: "头样寄出", owner_role: "sales", is_critical: true, evidence_required: true,
    evidence_note: "上传快递单号 + 面单照片" },
  { step_key: "dev_sample_customer_confirm", name: "头样客户确认", owner_role: "sales", is_critical: true, evidence_required: true,
    evidence_note: "上传客户确认邮件/消息截图。如客户不满意需安排二次样" },
];

/**
 * 二次样节点（头样不通过时的修改重做流程）
 */
const DEV_SAMPLE_REVISION_MILESTONES: Array<{
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
  evidence_note?: string;
}> = [
  { step_key: "dev_sample_revision", name: "二次样制作", owner_role: "production", is_critical: true, evidence_required: true,
    evidence_note: "上传二次样照片 + 与头样修改对比说明" },
  { step_key: "dev_sample_revision_sent", name: "二次样寄出", owner_role: "sales", is_critical: true, evidence_required: true,
    evidence_note: "上传快递单号 + 面单照片" },
  { step_key: "dev_sample_revision_confirm", name: "二次样客户确认", owner_role: "sales", is_critical: true, evidence_required: true,
    evidence_note: "上传客户确认邮件/消息截图。二次样必须通过才能安排产前样" },
];

/**
 * 国内送仓订单追加的节点（替代出运节点）
 */
const DOMESTIC_MILESTONES: Array<{
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
}> = [
  { step_key: "domestic_delivery", name: "国内送仓完成", owner_role: "logistics", is_critical: true, evidence_required: true },
];

/**
 * 打样专用里程碑模板（8个节点，14天周期）
 */
export const SAMPLE_MILESTONE_TEMPLATE: Array<{
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
  evidence_note?: string;
}> = [
  // 阶段1：打样启动
  { step_key: "sample_confirm", name: "打样单确认", owner_role: "sales", is_critical: true, evidence_required: true,
    evidence_note: "上传客户打样需求（Tech Pack/参考图/尺码表/面料要求）" },
  // 阶段2：面料与制作
  { step_key: "sample_material", name: "打样面料采购", owner_role: "procurement", is_critical: true, evidence_required: false },
  { step_key: "sample_making", name: "打样制作", owner_role: "production", is_critical: true, evidence_required: false },
  // 阶段3：检验
  { step_key: "sample_qc", name: "打样检验", owner_role: "production", is_critical: true, evidence_required: true,
    evidence_note: "上传样品照片（正面/背面/细节/尺寸测量）" },
  // 阶段4：寄样
  { step_key: "sample_shipping_arrange", name: "寄样安排", owner_role: "sales", is_critical: true, evidence_required: true,
    evidence_note: "上传快递单号。⚠ 国际快递必须确认：DHL/FedEx/UPS + DDP（完税交货）还是 DDU。DDP 必须含税，否则客户投诉！" },
  { step_key: "sample_sent", name: "样品寄出", owner_role: "sales", is_critical: true, evidence_required: true,
    evidence_note: "上传快递面单照片 + 跟踪号" },
  // 阶段5：客户确认
  { step_key: "sample_customer_confirm", name: "客户确认样品", owner_role: "sales", is_critical: true, evidence_required: true,
    evidence_note: "上传客户确认邮件/消息截图。如需修改请记录修改点" },
  { step_key: "sample_complete", name: "打样完成", owner_role: "sales", is_critical: true, evidence_required: false },
];

/**
 * 采购成品 / 经销单 (trade order) 模板 — MVP
 * 直接采购成品/现货,不开裁/中查/尾查/工厂生产,只走 采购→验收→出运→回款。
 * 【全部复用现有 step_key】(都已在 schedule.ts TIMELINE / criticalNodes / 门禁中登记,零新接线)。
 * 此处为 export(出口)形态;getApplicableMilestones 对 domestic 会过滤 EXPORT_ONLY_STEPS 并追加 DOMESTIC_MILESTONES。
 * 供应商备货/交期/催货 在【采购中心】(procurement_line_items)跟踪,不占里程碑。
 */
export const TRADE_MILESTONE_TEMPLATE: Array<{
  step_key: string;
  name: string;
  owner_role: OwnerRole;
  is_critical: boolean;
  evidence_required: boolean;
  evidence_note?: string;
}> = [
  { step_key: "po_confirmed", name: "PO确认", owner_role: "sales", is_critical: true, evidence_required: true },
  { step_key: "finance_approval", name: "订单审核", owner_role: "finance", is_critical: true, evidence_required: false },
  { step_key: "procurement_order_placed", name: "供应商下单", owner_role: "procurement", is_critical: true, evidence_required: true },
  { step_key: "packing_method_confirmed", name: "包装资料确认", owner_role: "merchandiser", is_critical: true, evidence_required: true },
  { step_key: "inspection_release", name: "成品验货/放行", owner_role: "merchandiser", is_critical: true, evidence_required: true },
  // ── 出运三件(EXPORT_ONLY,domestic 会被过滤) ──
  { step_key: "booking_done", name: "订舱完成", owner_role: "merchandiser", is_critical: true, evidence_required: true },
  { step_key: "customs_export", name: "报关安排出运", owner_role: "merchandiser", is_critical: true, evidence_required: true },
  { step_key: "shipment_execute", name: "出运", owner_role: "logistics", is_critical: true, evidence_required: true },
  // ── 回款 ──
  { step_key: "payment_received", name: "收款完成", owner_role: "finance", is_critical: true, evidence_required: false },
];

/**
 * 根据订单类型和交付方式返回适用的里程碑模板
 *
 * 出运流程判定：deliveryType === 'export' → 走 DDP 出运流程
 * 只有 DDP 需要我们订舱/报关/出运；FOB / 人民币(含税/不含税) 都走送仓流程。
 * 表单层面会根据 incoterm 自动设置 deliveryType（DDP→export，其余→domestic）。
 *
 * @param deliveryType - 'export'(DDP出口) | 'domestic'(送仓)
 * @param orderPurpose - 'production' | 'sample' | 'trade'
 * @param skipPreProductionSample - 是否跳过产前样（兼容旧调用，新流程用 samplePhase）
 * @param samplePhase - 样品阶段：confirmed/dev_sample/dev_sample_with_revision/skip_all
 */
export function getApplicableMilestones(
  _orderType?: string,
  _shippingSampleRequired?: boolean,
  deliveryType?: string,
  orderPurpose?: string,
  skipPreProductionSample?: boolean,
  samplePhase?: SamplePhase,
) {
  // 打样单用简化模板
  if (orderPurpose === 'sample') {
    return SAMPLE_MILESTONE_TEMPLATE;
  }

  // 采购成品 / 经销单:精简模板(全复用现有 key);domestic 过滤出运三件、追加送仓
  if (orderPurpose === 'trade') {
    if (deliveryType !== 'export') {
      const filtered = TRADE_MILESTONE_TEMPLATE.filter(m => !EXPORT_ONLY_STEPS.has(m.step_key));
      return [...filtered, ...DOMESTIC_MILESTONES];
    }
    return [...TRADE_MILESTONE_TEMPLATE];
  }

  // 兼容：旧的 skipPreProductionSample 映射到 samplePhase
  const phase: SamplePhase = samplePhase
    || (skipPreProductionSample ? 'skip_all' : 'confirmed');

  // 节点体系 V2(9节点)对新订单生效;V1 保留服务在途订单与回滚。
  let template = [...MILESTONE_TEMPLATE_V2];

  // ── 样品阶段处理 ──
  if (phase === 'skip_all') {
    // 跳过产前样（翻单/老款/客户用设计样直接做大货）
    template = template.filter(m => !PRE_PRODUCTION_SAMPLE_STEPS.has(m.step_key));
  } else if (phase === 'dev_sample' || phase === 'dev_sample_with_revision') {
    // 需要做头样：在「产前样客户确认」之前插入头样节点
    // (极简模板已删 pre_production_sample_ready,改锚 pre_production_sample_approved)
    let insertIdx = template.findIndex(m => m.step_key === 'pre_production_sample_approved');
    if (insertIdx === -1) insertIdx = template.findIndex(m => m.step_key === 'pre_production_sample_ready');
    if (insertIdx !== -1) {
      const devNodes = phase === 'dev_sample_with_revision'
        ? [...DEV_SAMPLE_MILESTONES, ...DEV_SAMPLE_REVISION_MILESTONES]
        : [...DEV_SAMPLE_MILESTONES];
      template.splice(insertIdx, 0, ...devNodes);
    }
  }
  // phase === 'confirmed' → 默认流程，不改动

  if (deliveryType !== 'export') {
    // 非出口（FOB / 人民币 / 国内送仓）：过滤出运节点，追加国内送仓节点
    const filtered = template.filter(m => !EXPORT_ONLY_STEPS.has(m.step_key));
    return [...filtered, ...DOMESTIC_MILESTONES];
  }

  return template;
}
