/**
 * 订单变更策略 — 卡风险，不卡流程
 *
 * 核心思想：每个可改字段都有一个「截止节点」——
 * 一旦该节点完成，再改就不再是简单 update，必须走"重大变更"流程
 * （创建追加子订单 / 中止 + 新建 / 走延期申请）。
 *
 * cutoffStepKey 语义：
 *   - null  → 任何阶段都可改（信息修正类）
 *   - 'block_always' → 永远不允许在变更面板里改（必须走专门流程，比如延期申请）
 *   - 其它 step_key → 当该 step_key 已完成，则锁定本字段
 */
export type AmendmentImpact = 'low' | 'medium' | 'high';

export interface AmendmentRule {
  field: string;
  label: string;
  /** 输入控件类型，给前端提示 */
  inputType: 'text' | 'number' | 'textarea' | 'select';
  options?: { value: string; label: string }[];
  /**
   * 截止节点：该 step_key 完成后本字段锁死
   * - null = 任何阶段都允许
   * - 'block_always' = 永远在面板里禁止（走专门流程）
   */
  cutoffStepKey: string | null | 'block_always';
  impact: AmendmentImpact;
  /** 谁可以审批 */
  approvers: ('admin' | 'finance' | 'merchandiser' | 'production_manager')[];
  /** 审批通过后系统自动执行的副作用 */
  sideEffects: AmendmentSideEffect[];
  /** 超过窗口期时给用户的解释 */
  blockedHint: string;
  /** 审批通过后给业务的提醒文案（提醒"统计原辅料盈缺"等人工任务） */
  postApprovalReminder?: string;
  /** 何时需要走"创建子订单"流程 */
  fallbackToChildOrder?: boolean;
}

export type AmendmentSideEffect =
  | 'recalc_schedule'                  // 重算所有未完成里程碑
  | 'reset_packing_method_milestone'   // 重置「包装方式确认」节点
  | 'recalc_unit_cost'                 // 重算单价/总价
  | 'notify_procurement'               // 通知采购
  | 'notify_finance'                   // 通知财务
  | 'notify_merchandiser'              // 通知跟单
  | 'notify_production_manager'        // 通知生产主管
  | 'log_only';                        // 仅记录

/**
 * 字段规则表
 *
 * 关键约定（CEO 2026-04-07 拍板）：
 * 1. 减数量 / 改尺寸 / 改款式：开裁前 (production_kickoff)
 *    → 副作用：提醒业务统计多余的原辅料，让客户买或挪到其他款式
 * 2. 加数量：采购下单前 (procurement_order_placed) 直接改原单
 *    采购后必须走"追加子订单"
 * 3. 改颜色：原材料下单前 (procurement_order_placed)
 * 4. 改包装方式：包装方式确认前 (packing_method_confirmed)
 *    → 副作用：重置节点 + 重新上传包装资料 + 提醒统计包装辅料盈缺
 * 5. 改交期：永远走「延期申请」流程，不走变更
 */
export const AMENDMENT_RULES: AmendmentRule[] = [
  // ── A 类：信息修正（任何时候可改） ──
  {
    field: 'notes',
    label: '备注',
    inputType: 'textarea',
    cutoffStepKey: null,
    impact: 'low',
    approvers: ['admin', 'merchandiser'],
    sideEffects: ['log_only'],
    blockedHint: '',
  },
  {
    field: 'po_number',
    label: '客户 PO 号',
    inputType: 'text',
    cutoffStepKey: null,
    impact: 'low',
    approvers: ['admin'],
    sideEffects: ['log_only'],
    blockedHint: '',
  },
  {
    field: 'internal_order_no',
    label: '内部订单号',
    inputType: 'text',
    cutoffStepKey: null,
    impact: 'low',
    approvers: ['admin'],
    sideEffects: ['log_only'],
    blockedHint: '',
  },

  // ── B 类：受控变更 ──
  {
    field: 'quantity_decrease',
    label: '减少数量',
    inputType: 'number',
    cutoffStepKey: 'production_kickoff', // 开裁前
    impact: 'high',
    approvers: ['admin', 'finance'],
    sideEffects: ['recalc_unit_cost', 'notify_procurement', 'notify_finance', 'notify_merchandiser'],
    blockedHint: '已开裁，不能减量。请走"协商退货 / 索赔"流程。',
    postApprovalReminder:
      '⚠️ 减量已批准。业务需立即统计「多余的原辅料」：' +
      '联系客户确认是否买走、或挪到其他款式生产。剩余原辅料库存请记录在订单备注。',
  },
  {
    field: 'quantity_increase',
    label: '增加数量',
    inputType: 'number',
    cutoffStepKey: 'procurement_order_placed', // 采购下单前可加，之后必须子订单
    impact: 'high',
    approvers: ['admin', 'finance'],
    sideEffects: ['recalc_unit_cost', 'notify_procurement', 'notify_finance'],
    blockedHint: '采购单已下达，加单必须创建「追加子订单」。',
    fallbackToChildOrder: true,
  },
  {
    field: 'sizes',
    label: '尺码',
    inputType: 'text',
    cutoffStepKey: 'production_kickoff', // 开裁前
    impact: 'high',
    approvers: ['admin', 'merchandiser'],
    sideEffects: ['notify_procurement', 'notify_merchandiser'],
    blockedHint: '已开裁，改尺码需重做版样 — 请创建新订单。',
    postApprovalReminder:
      '⚠️ 改尺码已批准。业务需统计「多余 / 不够的原辅料」：' +
      '裁片量变化可能导致面料余料或缺料，及时与客户沟通处理方案。',
  },
  {
    field: 'product_description',
    label: '款式',
    inputType: 'text',
    cutoffStepKey: 'production_kickoff', // 开裁前
    impact: 'high',
    approvers: ['admin', 'merchandiser', 'production_manager'],
    sideEffects: ['notify_procurement', 'notify_merchandiser', 'notify_production_manager'],
    blockedHint: '已开裁，改款式需重做版样 — 请中止本订单并创建新订单。',
    postApprovalReminder:
      '⚠️ 改款已批准。业务需立即统计「多余的原辅料」并联系客户：' +
      '剩余面料/辅料客户是否买走，或挪到其他款式。',
  },
  {
    field: 'colors',
    label: '颜色',
    inputType: 'text',
    cutoffStepKey: 'procurement_order_placed', // 原材料下单前
    impact: 'high',
    approvers: ['admin', 'merchandiser'],
    sideEffects: ['notify_procurement', 'notify_merchandiser'],
    blockedHint: '原材料已下单，改色等于重新染色 / 重新采购 — 请创建新订单。',
  },
  {
    field: 'packaging_type',
    label: '包装方式',
    inputType: 'select',
    options: [
      { value: 'standard', label: '标准' },
      { value: 'custom', label: '定制' },
    ],
    cutoffStepKey: 'packing_method_confirmed', // 包装方式确认前
    impact: 'medium',
    approvers: ['admin', 'merchandiser'],
    sideEffects: ['reset_packing_method_milestone', 'notify_merchandiser'],
    blockedHint: '包装方式已确认 — 改动需重置该节点。',
    postApprovalReminder:
      '⚠️ 改包装已批准。请：\n' +
      '1) 在「包装方式确认」节点重新上传包装资料；\n' +
      '2) 统计「多余 / 不够的包装辅料」并联系客户：' +
      '多余的辅料确认是否加价让客户买走，不够的及时补采购。',
  },
  {
    field: 'factory_id',
    label: '工厂',
    inputType: 'text',
    cutoffStepKey: 'production_kickoff',
    impact: 'high',
    approvers: ['admin', 'production_manager'],
    sideEffects: ['notify_procurement', 'notify_merchandiser', 'notify_production_manager'],
    blockedHint: '已开裁，不能换厂 — 请创建新订单。',
  },
  {
    field: 'unit_price',
    label: '单价',
    inputType: 'number',
    cutoffStepKey: null, // 任何时候都允许（财务对账）
    impact: 'medium',
    approvers: ['admin', 'finance'],
    sideEffects: ['recalc_unit_cost', 'notify_finance'],
    blockedHint: '',
  },
  {
    field: 'payment_terms',
    label: '付款条件',
    inputType: 'text',
    cutoffStepKey: null,
    impact: 'medium',
    approvers: ['admin', 'finance'],
    sideEffects: ['notify_finance'],
    blockedHint: '',
  },
  {
    field: 'incoterm',
    label: '贸易条款',
    inputType: 'select',
    options: [
      { value: 'FOB', label: 'FOB' },
      { value: 'DDP', label: 'DDP' },
      { value: 'RMB_EX_TAX', label: '人民币不含税' },
      { value: 'RMB_INC_TAX', label: '人民币含税' },
    ],
    cutoffStepKey: 'booking_done', // 订舱前
    impact: 'high',
    approvers: ['admin', 'finance'],
    sideEffects: ['recalc_schedule', 'notify_finance'],
    blockedHint: '已订舱，改贸易条款会影响出运 — 请联系管理员人工处理。',
  },

  // ── C 类：必须走专门流程 ──
  {
    field: 'etd',
    label: '交期 ETD',
    inputType: 'text',
    cutoffStepKey: 'block_always', // 永远走延期申请
    impact: 'high',
    approvers: ['admin'],
    sideEffects: [],
    blockedHint: '改交期请走「延期申请」流程 — 在订单页右上角点「申请延期」。',
  },
  {
    field: 'warehouse_due_date',
    label: '到仓日期 ETA',
    inputType: 'text',
    cutoffStepKey: 'block_always',
    impact: 'high',
    approvers: ['admin'],
    sideEffects: [],
    blockedHint: '改到仓日期请走「延期申请」流程。',
  },
];

/**
 * 判断字段在当前订单状态下能否变更
 *
 * @param fieldKey  - AMENDMENT_RULES 里的 field
 * @param doneStepKeys - 该订单已完成的 step_key 集合
 */
export function checkAmendmentAllowed(
  fieldKey: string,
  doneStepKeys: Set<string>,
): { allowed: boolean; rule: AmendmentRule | null; reason?: string } {
  const rule = AMENDMENT_RULES.find(r => r.field === fieldKey);
  if (!rule) return { allowed: false, rule: null, reason: '未知字段' };

  if (rule.cutoffStepKey === 'block_always') {
    return { allowed: false, rule, reason: rule.blockedHint };
  }

  if (rule.cutoffStepKey === null) {
    return { allowed: true, rule };
  }

  // cutoff 节点已经完成 → 锁
  if (doneStepKeys.has(rule.cutoffStepKey)) {
    return { allowed: false, rule, reason: rule.blockedHint };
  }

  return { allowed: true, rule };
}
