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
  // 2026-07-09 用户拍板:订单详情节拍器 = 【业务执行自己的节拍】(15 节点出口/13 送仓)。
  //   生产大货节拍在【生产中心】、采购下单细节在【采购中心】,此处只放业务执行要盯的节拍。
  //   → 移除"生产启动"(归生产中心);新增"订单评审会""包装方式确认";"采购下单"改为业务的"采购核料提交"。
  // 2026-07-10 派单归位:PO 后业务执行节点 owner_role 由 sales → merchandiser。
  //   sales=业务开发(到 PO 交接为止);merchandiser=业务执行部(PO 后接手一路到出货)。
  //   仅 po_confirmed 保留 sales(=业务开发的交接点)。物流/财务节点保留各自角色。
  //   配套(orders.ts):这些 merchandiser 节点默认自动指派给建单人(owner_user_id=creator),
  //   保证计分/催办/操作不中断;高洁(order_manager)用「理单跟单」按需改派。仅新单生效,存量不动。
  //   evidence_note 中"业务…"沿用旧文案,语义指业务执行部(理单)。
  { step_key: "po_confirmed", name: "PO审查确认", owner_role: "sales", is_critical: true, evidence_required: false,
    evidence_note: "财务确认价格/账期 + 生产部确认可执行(多方确认即完成,免凭证)" },
  { step_key: "pi_confirmed", name: "PI制作·客户确认", owner_role: "merchandiser", is_critical: true, evidence_required: true,
    evidence_note: "业务制作 PI 发客户确认 + 财务审核 PI;上传 PI 文件" },
  { step_key: "production_order_upload", name: "生产单·原辅料单制作", owner_role: "merchandiser", is_critical: false, evidence_required: true,
    evidence_note: "业务制作生产单 + 原辅料单" },
  { step_key: "order_kickoff_meeting", name: "订单评审会", owner_role: "merchandiser", is_critical: true, evidence_required: true,
    evidence_note: "业务牵头,业务·生产·采购三方评审(款式/面料/工艺/交期/成本)" },
  { step_key: "procurement_order_placed", name: "采购核料提交", owner_role: "merchandiser", is_critical: true, evidence_required: true,
    evidence_note: "业务提交采购核料 → 采购部安排下单;采购下单进度在【采购中心】跟。完成后开启采购进度共享" },
  { step_key: "pre_production_sample_sent", name: "产前样寄出", owner_role: "merchandiser", is_critical: false, evidence_required: true,
    evidence_note: "业务寄产前样给客户,填快递单号(生产做样在生产中心)" },
  { step_key: "pre_production_sample_approved", name: "产前样确认", owner_role: "merchandiser", is_critical: true, evidence_required: false,
    evidence_note: "采购确认大货原辅料品质 + 业务确认客户通过(多方确认即完成,免凭证)" },
  { step_key: "mid_qc_sales_check", name: "中期验货", owner_role: "merchandiser", is_critical: false, evidence_required: true,
    evidence_note: "业务对中期验货结果确认" },
  { step_key: "packing_method_confirmed", name: "包装方式确认", owner_role: "merchandiser", is_critical: false, evidence_required: true,
    evidence_note: "业务确认包装方式/唛头/装箱资料" },
  { step_key: "final_qc_sales_check", name: "尾期验货", owner_role: "merchandiser", is_critical: true, evidence_required: false,
    evidence_note: "生产部QC确认尾查合格 + 业务确认可交付(多方确认即完成,免凭证)" },
  { step_key: "shipping_sample_send", name: "船样准备·寄出", owner_role: "merchandiser", is_critical: false, evidence_required: true,
    evidence_note: "业务准备并寄出船样(仅出口单)" },
  { step_key: "ci_made", name: "PackingList·CI·报关单制作", owner_role: "merchandiser", is_critical: true, evidence_required: true,
    evidence_note: "业务制作装箱单 + 商业发票 + 报关单;上传文件" },
  { step_key: "booking_done", name: "订舱出货", owner_role: "merchandiser", is_critical: true, evidence_required: true,
    evidence_note: "业务订舱安排(仅出口单)" },
  { step_key: "shipment_execute", name: "发货出运", owner_role: "logistics", is_critical: true, evidence_required: false,
    evidence_note: "业务/采购/财务三方确认后出运(填 BL/船名即可,免凭证)" },
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

  // 委托加工 / 外发单:料由工厂自采 → 标准生产模板只砍掉「采购核料提交」一节点。
  //   生产单·原辅料单制作 / 订单评审会 / 产前样 / 中查 / 尾查 / CI报关 / 出运 / 收款 全保留。
  //   送仓口径与 production 一致(再砍「订舱出货」)。出口 14 节点 / 送仓 13 节点。
  if (orderPurpose === 'consign') {
    const consignBase = MILESTONE_TEMPLATE_V2.filter(m => m.step_key !== 'procurement_order_placed');
    if (deliveryType !== 'export') {
      return consignBase.filter(m => m.step_key !== 'booking_done');
    }
    return consignBase;
  }

  // 2026-07-09 用户拍板:标准生产单=业务执行节拍(出口 15 节点)。
  //   送仓单也要船样(用户 2026-07-09 更正)→ 只砍「订舱出货」(送仓无海运订舱),保留船样 → 送仓 14 节点。
  void samplePhase; void skipPreProductionSample;
  const base = [...MILESTONE_TEMPLATE_V2];
  if (deliveryType !== 'export') {
    return base.filter(m => m.step_key !== 'booking_done');
  }
  return base;
}
