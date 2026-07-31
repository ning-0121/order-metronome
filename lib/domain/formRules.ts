/**
 * 建单表单字段规则 —— 单一真相源(2026-07-31,L2 第一步)。
 *
 * 解决什么:
 *   「哪些字段显示 / 哪些必填 / 默认值是什么」现在有**两份互相不知道的真相**:
 *     · 前端:LegacyOrderForm 里 12 个 required 属性
 *     · 后端:createOrder 里 5 个 if (!x) return error
 *   两边对不上,靠"前端先拦住"维持表面一致。后果有二:
 *     ① 一旦按客户隐藏某个字段,后端那份硬编码会立刻露馅,提交必然失败;
 *     ② 已经藏了真 bug —— 选「没有客户 PO」时仍强制填 PO 号(前端 required、后端不管),
 *        业务只能瞎填一个糊弄过去。
 *
 * 怎么解决:字段规则集中到这里,前端渲染和后端校验**读同一份**。
 * 之后接 DB 覆盖层(按客户/租户配)时,也只需要覆盖这一份,不用再改两处代码。
 *
 * 设计取舍:
 *   · 条件性(翻单才出返单问题、勾了才出船样截止日)**留在组件的条件渲染里**,
 *     本模块只回答"这个字段在当前情境下渲染出来了的话,要不要必填"。
 *     把条件渲染也搬进配置会让模型复杂十倍,收益很小。
 *   · required 支持写成函数,以表达"随情境变化的必填"(如 PO 号只在 has_po 时必填)。
 *   · 默认规则 = 现状(仅修掉上面那个 no_po 矛盾),保证接入时行为不变。
 */

/** 影响字段必填性的表单情境 */
export interface OrderFormCtx {
  /** 录入方式:有客户 PO / 没有 PO */
  poMode?: 'has_po' | 'no_po' | null;
  orderType?: string | null;
  incoterm?: string | null;
  deliveryType?: string | null;
  shippingSampleRequired?: boolean;
  /** 勾了「颜色待定」→ 颜色数免填 */
  colorPending?: boolean;
  /** 导入历史单(走 legacy 导入路径) */
  isImport?: boolean;
}

export interface FieldRule {
  /** 是否渲染。false = 该部署/该客户根本不需要这个字段 */
  visible: boolean;
  /** 是否必填;可随情境变化 */
  required: boolean | ((ctx: OrderFormCtx) => boolean);
  /** 建单时的默认值(留空表示不预填) */
  defaultValue?: string;
  /** 给人看的名字,仅用于报错文案 */
  label: string;
}

/** 已解析成布尔的规则(前后端实际消费的形态) */
export interface ResolvedRule {
  visible: boolean;
  required: boolean;
  defaultValue?: string;
  label: string;
}

const T = () => true;

/**
 * 建单表单默认规则 = 当前线上行为。
 * 唯一有意的行为修正:customer_po_number 从"无条件必填"改为"仅 has_po 时必填"
 * —— 选了「没有客户 PO」还强制填 PO 号是自相矛盾,且后端本来就不校验。
 */
export const ORDER_CREATE_RULES: Record<string, FieldRule> = {
  // ── 无条件必填(前后端都认) ──
  internal_order_no: { visible: true, required: T, label: '内部订单号' },
  factory_date:      { visible: true, required: T, label: '出厂日期' },
  total_quantity:    { visible: true, required: T, label: '预估总数量' },
  style_count:       { visible: true, required: T, label: '款数' },

  // 颜色数:勾了「颜色待定」就免填(与 createOrder 现有豁免一致)
  color_count: {
    visible: true, label: '颜色数',
    required: (c) => !c.colorPending,
  },

  // ── 情境必填 ──
  // 修正点:选「没有客户 PO」时不该再逼着填 PO 号
  customer_po_number: {
    visible: true, label: '客户 PO 号',
    required: (c) => c.poMode !== 'no_po',
  },
  // 翻单才出现的字段,出现即必填
  repeat_issues: {
    visible: true, label: '上次返单问题',
    required: (c) => c.orderType === 'repeat',
  },
  // 勾了「需要 Shipping Sample」才出现
  shipping_sample_deadline: {
    visible: true, label: 'Shipping Sample 截止日期',
    required: (c) => !!c.shippingSampleRequired,
  },

  // ── 有默认值的必填:required 形同虚设,但保留以免用户手动清空 ──
  order_date:    { visible: true, required: T, label: '下单日期' },
  order_type:    { visible: true, required: T, label: '订单类型', defaultValue: 'bulk' },
  incoterm:      { visible: true, required: T, label: '贸易条款', defaultValue: 'DDP' },
  quantity_unit: { visible: true, required: T, label: '数量单位', defaultValue: '件' },

  // ── 明确选填(列出来是为了让"可配置"有据可依,不是为了改行为) ──
  etd:                     { visible: true, required: false, label: 'ETD 离港日' },
  warehouse_due_date:      { visible: true, required: false, label: 'ETA 到港/到仓日' },
  cancel_date:             { visible: true, required: false, label: 'Cancel Date' },
  aql_standard:            { visible: true, required: false, label: 'AQL 验货标准', defaultValue: 'AQL 2.5' },
  delivery_type:           { visible: true, required: false, label: '交付方式' },
  customer_email:          { visible: true, required: false, label: '客户邮箱' },
  factory_name:            { visible: true, required: false, label: '工厂' },
  notes:                   { visible: true, required: false, label: '备注' },
  delivery_warehouse_name: { visible: true, required: false, label: '仓库名称' },
  delivery_required_at:    { visible: true, required: false, label: '客户要求送达日期' },
  delivery_address:        { visible: true, required: false, label: '详细地址' },
  delivery_contact:        { visible: true, required: false, label: '收货联系人' },
  delivery_phone:          { visible: true, required: false, label: '联系电话' },
  sample_phase:            { visible: true, required: false, label: '样品阶段' },
  repeat_prev_order_no:    { visible: true, required: false, label: '上次订单号' },
  repeat_attention:        { visible: true, required: false, label: '本次注意事项' },
};

/** DB 覆盖层的形态(scope: global < customer,后者压前者) */
export interface FieldRuleOverride {
  field_name: string;
  visible?: boolean | null;
  required?: boolean | null;
  default_value?: string | null;
}

/**
 * 把「代码默认 + DB 覆盖 + 当前情境」解析成一份实际生效的规则表。
 *
 * 覆盖顺序:代码默认 → global 覆盖 → 客户覆盖。传空数组 = 完全等于代码默认(即现状)。
 * 覆盖只能改 visible/required/default,**不能新增字段** —— 新字段必须先在代码里有渲染,
 * 否则配置出一个不存在的字段名只会让人以为配了却没生效。
 */
export function resolveOrderFormRules(
  ctx: OrderFormCtx = {},
  overrides: FieldRuleOverride[] = [],
): Record<string, ResolvedRule> {
  const byField = new Map<string, FieldRuleOverride>();
  for (const o of overrides) {
    if (!o?.field_name) continue;
    // 后来的压先来的 —— 调用方按 global → customer 顺序传入
    byField.set(o.field_name, { ...byField.get(o.field_name), ...o });
  }

  const out: Record<string, ResolvedRule> = {};
  for (const [name, base] of Object.entries(ORDER_CREATE_RULES)) {
    const ov = byField.get(name);
    const required = typeof base.required === 'function' ? base.required(ctx) : base.required;
    out[name] = {
      label: base.label,
      visible: ov?.visible ?? base.visible,
      required: ov?.required ?? required,
      defaultValue: ov?.default_value ?? base.defaultValue,
    };
  }
  // 隐藏的字段一律不必填 —— 否则会出现"看不见却提交不了"的死局
  for (const r of Object.values(out)) if (!r.visible) r.required = false;
  return out;
}

/**
 * 服务端校验:按解析后的规则检查缺哪些必填。返回给人看的字段名列表(空 = 通过)。
 * 与前端读同一份规则,不再各写一套 if。
 */
export function findMissingRequired(
  values: Record<string, unknown>,
  rules: Record<string, ResolvedRule>,
): string[] {
  const missing: string[] = [];
  for (const [name, rule] of Object.entries(rules)) {
    if (!rule.required) continue;
    const v = values[name];
    const empty = v === undefined || v === null || String(v).trim() === '';
    if (empty) missing.push(rule.label);
  }
  return missing;
}
