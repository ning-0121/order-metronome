/**
 * 节点检查清单系统
 *
 * 设计：
 * - 检查清单定义在代码中（跟 SOP_MAP 同模式），不额外建表
 * - 检查清单响应存在 milestones.checklist_data JSONB 列
 * - 全部必填项勾完才能标记节点完成
 * - "未确认"项可选预计确认日期，影响后续节点排期
 */

import type { OwnerRole } from '@/lib/milestoneTemplate';

// ══════ 类型定义 ══════

export type ChecklistItemType = 'checkbox' | 'select' | 'text' | 'number' | 'pending_date';

export interface ChecklistItemDef {
  key: string;
  label: string;
  type: ChecklistItemType;
  required: boolean;
  role: OwnerRole;
  options?: string[];       // select 类型的选项
  helpText?: string;
  affectsSchedule?: boolean; // pending_date 类型：是否影响排期
  group?: string;           // 分组标题
}

export interface ChecklistConfig {
  title: string;
  items: ChecklistItemDef[];
}

// 存储在 DB 的响应格式
export interface ChecklistItemResponse {
  key: string;
  value: boolean | string | null;
  pending_date?: string;    // ISO date
  updated_at: string;
  updated_by: string;       // user_id
}

export type ChecklistData = ChecklistItemResponse[];

// ══════ 检查清单定义（阶段1-3） ══════

export const CHECKLIST_MAP: Record<string, ChecklistConfig> = {

  // ── 阶段1：订单评审 ──────────────────────────

  po_confirmed: {
    title: 'PO确认检查清单',
    items: [
      { key: 'po_uploaded', label: '客户PO已上传', type: 'checkbox', required: true, role: 'sales', group: '文件上传' },
      { key: 'internal_quote_uploaded', label: '内部成本核算单已上传', type: 'checkbox', required: true, role: 'sales', group: '文件上传' },
      { key: 'customer_quote_uploaded', label: '客户最终报价单已上传', type: 'checkbox', required: true, role: 'sales', group: '文件上传' },
      { key: 'style_no_verified', label: '款号核对一致', type: 'checkbox', required: true, role: 'sales', group: '关键信息核对' },
      { key: 'quantity_verified', label: '数量核对一致', type: 'checkbox', required: true, role: 'sales', group: '关键信息核对' },
      { key: 'size_ratio_verified', label: '尺码配比核对一致', type: 'checkbox', required: true, role: 'sales', group: '关键信息核对' },
      { key: 'color_verified', label: '颜色核对一致', type: 'checkbox', required: true, role: 'sales', group: '关键信息核对' },
      { key: 'delivery_verified', label: '交期核对一致', type: 'checkbox', required: true, role: 'sales', group: '关键信息核对' },
      { key: 'incoterm_payment', label: '贸易条款（FOB/DDP）和付款方式确认', type: 'checkbox', required: true, role: 'sales', group: '条款确认' },
      { key: 'special_requirements', label: '特殊要求已标注（浅色/撞色/特殊包装等）', type: 'checkbox', required: true, role: 'sales', group: '条款确认' },
      { key: 'three_doc_ai_verified', label: 'AI三单比对已完成或已确认差异', type: 'checkbox', required: true, role: 'sales', group: 'AI核验' },
    ],
  },

  finance_approval: {
    title: '财务审核检查清单',
    items: [
      { key: 'price_match', label: '客户PO价格与报价一致', type: 'checkbox', required: true, role: 'finance', group: '价格审核' },
      { key: 'profit_rate', label: '利润率', type: 'select', required: true, role: 'finance', group: '价格审核',
        options: ['≥25%（优秀）', '15%-25%（正常）', '<15%（需CEO审批）'],
        helpText: '低于15%需报CEO审核确认' },
      { key: 'currency_payment', label: '币种和付款方式/节点正确', type: 'checkbox', required: true, role: 'finance', group: '条款审核' },
      { key: 'shipping_cost', label: '运费/DDP税费/验货费已核查', type: 'checkbox', required: true, role: 'finance', group: '费用审核' },
      { key: 'no_omission', label: '无遗漏费用项', type: 'checkbox', required: true, role: 'finance', group: '费用审核' },
      { key: 'ceo_approval_needed', label: '是否需要CEO审批', type: 'select', required: true, role: 'finance',
        options: ['不需要', '需要（利润率<15%）', '需要（其他原因）'] },
      { key: 'ceo_approval_note', label: 'CEO审批备注', type: 'text', required: false, role: 'finance',
        helpText: '如需CEO审批，填写具体原因' },
    ],
  },

  order_kickoff_meeting: {
    title: '订单评审会',
    items: [
      { key: 'pending_items', label: '客户重要待确认项', type: 'text', required: false, role: 'sales', group: '确认',
        helpText: '如：色号待定、尺码表修改中、包装方式待确认。全部已确认可留空' },
      // ── 时间 ──
      { key: 'procurement_days', label: '原料采购天数', type: 'text', required: true, role: 'sales', group: '时间',
        helpText: '面料采购预计多少天' },
      { key: 'production_days', label: '生产预计天数', type: 'text', required: true, role: 'sales', group: '时间',
        helpText: '大货生产预计多少天（含裁剪+车缝+后整理）' },
      // ── 风险 ──
      { key: 'risk_items', label: '风险与注意事项', type: 'text', required: true, role: 'sales', group: '风险',
        helpText: '如：面料缩水率需测试、新工厂首单需加验、深色面料注意色差、客户交期强调' },
      // ── 确认 ──
      { key: 'sales_signed', label: '业务确认评审会已召开', type: 'checkbox', required: true, role: 'sales', group: '确认' },
    ],
  },

  production_order_upload: {
    title: '生产单上传检查清单',
    items: [
      { key: 'production_order_file', label: '生产订单已上传', type: 'checkbox', required: true, role: 'sales', group: '必传文件',
        helpText: '含款式、面料、尺码、工艺等完整生产信息' },
      { key: 'trims_sheet_file', label: '原辅料单已上传', type: 'checkbox', required: true, role: 'sales', group: '必传文件',
        helpText: '面辅料明细、用量、供应商信息' },
      { key: 'packing_requirement_file', label: '包装资料已上传', type: 'checkbox', required: true, role: 'sales', group: '必传文件',
        helpText: '装箱方式、唛头、吊牌、洗标等包装要求' },
      { key: 'production_info_complete', label: '确认三份资料完整，可交付生产部', type: 'checkbox', required: true, role: 'sales', group: '确认' },
    ],
  },

  // ── 阶段2：原辅料预评估 + 生产预评估 ──────────────────

  order_docs_bom_complete: {
    title: '原辅料预评估检查清单（精简版）',
    items: [
      // ── 核心 3 项：下单日 + 到料日 + 预算判断 ──
      { key: 'fabric_order_date', label: '布料下单日期', type: 'pending_date', required: true, role: 'procurement', group: '快速评估',
        affectsSchedule: true,
        helpText: '采购预计什么时候给工厂下大货布料订单 — 影响下游排期' },
      { key: 'expected_arrival_date', label: '预计到料日期', type: 'pending_date', required: true, role: 'procurement', group: '快速评估',
        affectsSchedule: true,
        helpText: '布料/辅料预计什么时候到工厂 — 决定原辅料到货验收节点' },
      { key: 'within_budget', label: '是否在预算/排期内', type: 'select', required: true, role: 'procurement', group: '快速评估',
        options: ['✅ 全部在预算和排期内（无需详细说明）', '⚠️ 超预算或来不及（需填写下方说明）'] },

      // ── 仅在"超预算"时才需要填的字段（required: false）──
      { key: 'over_budget_reason', label: '超预算/来不及 原因说明', type: 'text', required: false, role: 'procurement', group: '异常说明',
        helpText: '仅当上方选择"超预算或来不及"时填写。说明哪个料、超多少、建议方案' },
      { key: 'high_risk_material', label: '是否有高风险材料需要标注', type: 'checkbox', required: false, role: 'procurement', group: '异常说明',
        helpText: '高弹克重偏差 / 浅色色差 / 特殊工艺面料等' },
      { key: 'risk_note', label: '高风险材料说明', type: 'text', required: false, role: 'procurement', group: '异常说明' },

      // ── 业务确认（仅在"超预算"时需要） ──
      { key: 'sales_acknowledged', label: '业务已知悉异常情况', type: 'checkbox', required: false, role: 'sales', group: '业务确认',
        helpText: '仅当采购标记"超预算或来不及"时需要业务勾选' },
    ],
  },

  bulk_materials_confirmed: {
    title: '生产预评估检查清单',
    items: [
      // ── 关键日期（影响排期）──
      { key: 'production_line_start_date', label: '预计上线日期（开裁日）', type: 'pending_date', required: true, role: 'merchandiser', group: '关键日期',
        affectsSchedule: true,
        helpText: '跟单根据原料到货 + 工厂产能评估的实际开裁日 — 决定生产启动节点' },

      // ── 评估项 ──
      { key: 'delivery_feasible', label: '交期是否可行', type: 'select', required: true, role: 'merchandiser', group: '交期评估',
        options: ['可以按时完成', '紧张但可行', '无法满足（需沟通客户）'] },
      { key: 'delivery_risk_note', label: '交期风险说明', type: 'text', required: false, role: 'merchandiser', group: '交期评估',
        helpText: '如紧张或无法满足，说明原因和建议方案' },
      { key: 'craft_difficulty', label: '工艺难点评估', type: 'select', required: true, role: 'merchandiser', group: '工艺品质评估',
        options: ['无明显难点', '有难点但可解决', '有重大难点（需特别关注）'] },
      { key: 'craft_note', label: '工艺难点详细说明', type: 'text', required: false, role: 'merchandiser', group: '工艺品质评估',
        helpText: '特殊工艺、复杂印花、面料处理等难点' },
      { key: 'quality_focus', label: '品质重点关注项', type: 'text', required: false, role: 'merchandiser', group: '工艺品质评估',
        helpText: '如：色牢度、缩水率、缝制密度等' },
      { key: 'processing_fee_estimate', label: '加工费预估范围', type: 'text', required: true, role: 'merchandiser', group: '加工费预估',
        helpText: '如：12-15元/件' },
    ],
  },

  // ── 阶段3：工厂匹配 ──────────────────────────

  factory_confirmed: {
    title: '工厂匹配评估（目标价·品质·交期）',
    items: [
      // 目标价评估
      { key: 'factory_quote_price', label: '工厂报价（元/件）', type: 'number', required: true, role: 'merchandiser', group: '目标价评估',
        helpText: '填写工厂给到的加工单价' },
      { key: 'target_price_match', label: '报价 vs 目标价', type: 'select', required: true, role: 'merchandiser', group: '目标价评估',
        options: ['在目标价内', '略超（5%以内，可接受）', '超出较多（需协商客户或换厂）'] },
      // 品质评估
      { key: 'factory_quality_grade', label: '工厂品质等级', type: 'select', required: true, role: 'merchandiser', group: '品质评估',
        options: ['A级（高端客户适用）', 'B级（中端，满足大部分客户）', 'C级（需加强QC管控）'] },
      { key: 'factory_quality_history', label: '历史品质表现', type: 'select', required: true, role: 'merchandiser', group: '品质评估',
        options: ['优秀（无重大投诉）', '一般（有过小问题已改进）', '较差（需特别关注）', '新工厂（无历史数据）'] },
      // 交期评估
      { key: 'factory_capacity_ok', label: '产能是否满足本单交期', type: 'select', required: true, role: 'merchandiser', group: '交期评估',
        options: ['完全满足', '紧张但可行（需跟紧）', '无法满足（需协商交期或分厂）'] },
      { key: 'factory_current_load', label: '工厂当前在手订单量', type: 'select', required: false, role: 'merchandiser', group: '交期评估',
        options: ['较空闲（<50%产能）', '正常（50-80%）', '饱和（>80%需注意）'] },
      // 最终确认
      { key: 'primary_factory', label: '确定工厂', type: 'text', required: true, role: 'merchandiser', group: '最终确认' },
      { key: 'backup_factory', label: '备选工厂', type: 'text', required: false, role: 'merchandiser', group: '最终确认',
        helpText: '建议准备备选以防产能不足' },
      { key: 'factory_match_conclusion', label: '综合评估结论', type: 'select', required: true, role: 'merchandiser', group: '最终确认',
        options: ['推荐（价格+品质+交期均满足）', '可接受（有风险点但可控）', '不推荐（需换厂或协商客户）'] },
    ],
  },

  // ══════ 跟单流程报告模板（7 个关键环节） ══════

  // ── ① 封样交付 ──
  pre_production_sample_ready: {
    title: '封样交付报告',
    items: [
      { key: 'sample_type', label: '封样类型', type: 'select', required: true, role: 'merchandiser', group: '封样制作',
        options: ['头样', '确认样', '产前样'] },
      { key: 'sample_fabric', label: '实际使用面料', type: 'text', required: true, role: 'merchandiser', group: '封样制作',
        helpText: '面料成分/克重/色号' },
      { key: 'sample_qty', label: '封样数量', type: 'number', required: true, role: 'merchandiser', group: '封样制作' },
      { key: 'size_check', label: '尺寸复核', type: 'checkbox', required: true, role: 'merchandiser', group: '品质检查',
        helpText: '按尺码表逐项测量，偏差≤1cm' },
      { key: 'workmanship_check', label: '做工检查', type: 'checkbox', required: true, role: 'merchandiser', group: '品质检查',
        helpText: '车缝/拼接/印花/绣花 无明显瑕疵' },
      { key: 'color_check', label: '颜色对比', type: 'checkbox', required: true, role: 'merchandiser', group: '品质检查',
        helpText: '与色卡/标准样对比，无明显色差' },
      { key: 'photos_uploaded', label: '封样照片已上传', type: 'checkbox', required: false, role: 'merchandiser', group: '交付',
        helpText: '正面/背面/细节/尺寸测量照片' },
      { key: 'delivery_date', label: '交付日期', type: 'pending_date', required: true, role: 'merchandiser', group: '交付',
        affectsSchedule: true },
    ],
  },

  // ── ② 大货面料验收 ──
  materials_received_inspected: {
    title: '大货面料验收报告',
    items: [
      { key: 'arrival_date', label: '到货日期', type: 'text', required: true, role: 'merchandiser', group: '到货信息' },
      { key: 'fabric_batch', label: '面料批号/缸号', type: 'text', required: true, role: 'merchandiser', group: '到货信息' },
      { key: 'arrival_qty', label: '到货数量（米/公斤）', type: 'number', required: true, role: 'merchandiser', group: '到货信息' },
      { key: 'color_match', label: '颜色对比', type: 'select', required: true, role: 'merchandiser', group: '品质检验',
        options: ['合格', '轻微偏差(可接受)', '不合格'] },
      { key: 'weight_check', label: '克重检测', type: 'select', required: true, role: 'merchandiser', group: '品质检验',
        options: ['合格(偏差≤5%)', '偏差较大(需确认)', '不合格'] },
      { key: 'hand_feel', label: '手感对比', type: 'select', required: true, role: 'merchandiser', group: '品质检验',
        options: ['与封样一致', '有差异(需确认)', '不合格'] },
      { key: 'shrinkage', label: '缩水率', type: 'select', required: true, role: 'merchandiser', group: '品质检验',
        options: ['合格(≤3%)', '偏差较大(需确认)', '不合格'] },
      { key: 'defect_check', label: '疵点检查', type: 'select', required: true, role: 'merchandiser', group: '品质检验',
        options: ['无明显疵点', '有少量(可用)', '大面积疵点(需退换)'] },
      { key: 'fail_note', label: '不合格项说明', type: 'text', required: false, role: 'merchandiser', group: '品质检验' },
      { key: 'merch_confirmed', label: '跟单确认面料可用', type: 'checkbox', required: true, role: 'merchandiser', group: '双确认（确认后才能开裁）' },
      { key: 'sales_confirmed', label: '业务确认面料可用', type: 'checkbox', required: true, role: 'sales', group: '双确认（确认后才能开裁）' },
      { key: 'customer_confirm_needed', label: '是否需要客户确认', type: 'select', required: true, role: 'sales', group: '双确认（确认后才能开裁）',
        options: ['不需要', '已寄样等客户确认', '客户已确认'] },
    ],
  },

  // ── ③ 上线工艺确认（开裁） ──
  production_kickoff: {
    title: '上线工艺确认报告',
    items: [
      // 单耗对比（保留原有）
      { key: 'quote_consumption', label: '报价单耗（米/件）', type: 'number', required: true, role: 'merchandiser', group: '单耗对比' },
      { key: 'actual_consumption', label: '工厂排料实际单耗（米/件）', type: 'number', required: true, role: 'merchandiser', group: '单耗对比',
        helpText: '实际单耗必须 ≤ 报价单耗才可开裁' },
      { key: 'consumption_pass', label: '单耗核验通过', type: 'checkbox', required: true, role: 'merchandiser', group: '单耗对比' },
      // 工艺确认（新增）
      { key: 'cut_piece_check', label: '首件裁片尺寸与纸样一致', type: 'checkbox', required: true, role: 'merchandiser', group: '首件工艺确认' },
      { key: 'sewing_check', label: '车缝密度/针距/线头符合要求', type: 'checkbox', required: true, role: 'merchandiser', group: '首件工艺确认' },
      { key: 'print_check', label: '印花/绣花位置大小颜色与确认样一致', type: 'checkbox', required: true, role: 'merchandiser', group: '首件工艺确认' },
      { key: 'trims_check', label: '辅料核对（拉链/纽扣/织带等）', type: 'checkbox', required: true, role: 'merchandiser', group: '首件工艺确认' },
      { key: 'first_piece_photo', label: '首件确认照片已上传', type: 'checkbox', required: false, role: 'merchandiser', group: '首件工艺确认' },
    ],
  },

  // ── ④ 中查报告 ──
  mid_qc_check: {
    title: '中期验货报告',
    items: [
      // 基本信息
      { key: 'qc_date', label: '验货日期', type: 'text', required: true, role: 'merchandiser', group: '基本信息' },
      { key: 'qty_completed', label: '已完成数量', type: 'number', required: true, role: 'merchandiser', group: '基本信息' },
      { key: 'qc_progress_pct', label: '完成进度（%）', type: 'number', required: true, role: 'merchandiser', group: '基本信息',
        helpText: '如：30、50、70' },
      // 尺寸检验
      { key: 'size_pass_rate', label: '尺寸符合率', type: 'select', required: true, role: 'merchandiser', group: '尺寸检验',
        options: ['100%合格', '90%以上', '80%以上', '低于80%'] },
      { key: 'size_deviation', label: '超差部位', type: 'text', required: false, role: 'merchandiser', group: '尺寸检验',
        helpText: '如：胸围偏大1.5cm、袖长偏短' },
      // 外观检验
      { key: 'color_diff', label: '色差', type: 'select', required: true, role: 'merchandiser', group: '外观检验',
        options: ['无色差', '件间轻微色差', '与封样有色差'] },
      { key: 'workmanship', label: '做工', type: 'select', required: true, role: 'merchandiser', group: '外观检验',
        options: ['优良', '一般(有小问题)', '较差(问题较多)'] },
      { key: 'main_issues', label: '主要问题', type: 'text', required: false, role: 'merchandiser', group: '外观检验',
        helpText: '如：跳针、线头多、拼缝不齐' },
      // 功能检验
      { key: 'zipper_button', label: '拉链/纽扣', type: 'select', required: true, role: 'merchandiser', group: '功能检验',
        options: ['正常', '有问题', '不适用'] },
      { key: 'print_embroidery', label: '印花/绣花', type: 'select', required: true, role: 'merchandiser', group: '功能检验',
        options: ['正常', '有脱落风险', '不适用'] },
      // 判定
      { key: 'mid_qc_result', label: '中查结果', type: 'select', required: true, role: 'merchandiser', group: '判定',
        options: ['继续生产', '需整改后继续', '需停产整改'] },
      { key: 'rectification', label: '整改要求', type: 'text', required: false, role: 'merchandiser', group: '判定' },
      { key: 'qc_report_uploaded', label: '中查报告照片已上传', type: 'checkbox', required: false, role: 'merchandiser', group: '判定' },
      // 业务确认
      { key: 'sales_reviewed', label: '业务已审阅中查结果', type: 'checkbox', required: true, role: 'sales', group: '业务确认' },
      { key: 'sales_opinion', label: '业务意见', type: 'select', required: true, role: 'sales', group: '业务确认',
        options: ['同意继续生产', '需整改后继续', '需与客户沟通'] },
    ],
  },

  // ── ⑤ 尾查报告（AQL 验货） ──
  final_qc_check: {
    title: '尾期验货报告（AQL）',
    items: [
      // 验货信息
      { key: 'final_qc_date', label: '验货日期', type: 'text', required: true, role: 'merchandiser', group: '验货信息' },
      { key: 'total_qty', label: '验货总数', type: 'number', required: true, role: 'merchandiser', group: '验货信息' },
      { key: 'aql_standard', label: 'AQL标准', type: 'select', required: true, role: 'merchandiser', group: '验货信息',
        options: ['AQL 1.5', 'AQL 2.5', 'AQL 4.0', '客户指定标准'] },
      { key: 'sample_qty', label: '抽检数量', type: 'number', required: true, role: 'merchandiser', group: '验货信息' },
      // 检验项目
      { key: 'check_size', label: '尺寸', type: 'select', required: true, role: 'merchandiser', group: '检验项目',
        options: ['合格', '不合格'] },
      { key: 'check_workmanship', label: '做工', type: 'select', required: true, role: 'merchandiser', group: '检验项目',
        options: ['合格', '不合格'] },
      { key: 'check_appearance', label: '外观', type: 'select', required: true, role: 'merchandiser', group: '检验项目',
        options: ['合格', '不合格'] },
      { key: 'check_color', label: '颜色', type: 'select', required: true, role: 'merchandiser', group: '检验项目',
        options: ['合格', '不合格'] },
      { key: 'check_function', label: '功能', type: 'select', required: true, role: 'merchandiser', group: '检验项目',
        options: ['合格', '不合格', '不适用'] },
      // 缺陷统计
      { key: 'critical_defects', label: '严重缺陷数', type: 'number', required: true, role: 'merchandiser', group: '缺陷统计',
        helpText: '危及安全或无法使用' },
      { key: 'major_defects', label: '主要缺陷数', type: 'number', required: true, role: 'merchandiser', group: '缺陷统计',
        helpText: '影响使用或外观严重' },
      { key: 'minor_defects', label: '次要缺陷数', type: 'number', required: true, role: 'merchandiser', group: '缺陷统计',
        helpText: '轻微外观问题' },
      { key: 'defect_desc', label: '缺陷描述', type: 'text', required: false, role: 'merchandiser', group: '缺陷统计' },
      // 判定
      { key: 'final_result', label: '尾查结果', type: 'select', required: true, role: 'merchandiser', group: '判定',
        options: ['PASS', 'PENDING（待整改复验）', 'FAIL（不通过）'] },
      { key: 'rectification', label: '整改要求', type: 'text', required: false, role: 'merchandiser', group: '判定' },
      { key: 'report_uploaded', label: '尾查报告已上传', type: 'checkbox', required: false, role: 'merchandiser', group: '判定' },
      // 业务确认
      { key: 'sales_reviewed', label: '业务已审阅尾查结果', type: 'checkbox', required: true, role: 'sales', group: '业务确认' },
      { key: 'sales_opinion', label: '业务意见', type: 'select', required: true, role: 'sales', group: '业务确认',
        options: ['同意出货', '需整改复验', '需与客户沟通', '拒绝出货'] },
    ],
  },

  // ── ⑥ 包装确认 ──
  packing_method_confirmed: {
    title: '包装跟单报告',
    items: [
      { key: 'inner_packing', label: '内包装', type: 'select', required: true, role: 'merchandiser', group: '包装核对',
        options: ['符合要求', '有偏差需确认', '不合格'] },
      { key: 'carton_marks', label: '外箱唛头', type: 'select', required: true, role: 'merchandiser', group: '包装核对',
        options: ['正确', '有错误(需重印)', '不适用'] },
      { key: 'labels_barcodes', label: '吊牌/洗标/条码', type: 'select', required: true, role: 'merchandiser', group: '包装核对',
        options: ['正确', '有错误', '不适用'] },
      { key: 'packing_method', label: '装箱方式', type: 'select', required: true, role: 'merchandiser', group: '包装核对',
        options: ['与客户确认一致', '有调整(已告知客户)'] },
      { key: 'pcs_per_carton', label: '每箱件数', type: 'number', required: true, role: 'merchandiser', group: '装箱数据' },
      { key: 'total_cartons', label: '总箱数', type: 'number', required: true, role: 'merchandiser', group: '装箱数据' },
      { key: 'weight', label: '净重/毛重(KG)', type: 'text', required: true, role: 'merchandiser', group: '装箱数据' },
      { key: 'packing_photos', label: '包装照片已上传', type: 'checkbox', required: false, role: 'merchandiser', group: '确认',
        helpText: '内包装+外箱+唛头照片' },
      { key: 'packing_pass', label: '所有包装项目符合客户要求', type: 'checkbox', required: true, role: 'merchandiser', group: '确认' },
    ],
  },

  // ── ⑦ 验货放行 ──
  inspection_release: {
    title: '出货前验货报告',
    items: [
      { key: 'qty_check', label: '实际装箱数量与订单一致', type: 'checkbox', required: true, role: 'merchandiser', group: '出货前最终检查' },
      { key: 'quality_recheck', label: '品质复检', type: 'select', required: true, role: 'merchandiser', group: '出货前最终检查',
        options: ['合格', '有遗留问题(已记录)'] },
      { key: 'packing_intact', label: '外箱无破损、封箱牢固', type: 'checkbox', required: true, role: 'merchandiser', group: '出货前最终检查' },
      { key: 'marks_check', label: '外箱唛头与客户要求一致', type: 'checkbox', required: true, role: 'merchandiser', group: '出货前最终检查' },
      { key: 'packing_list_check', label: '装箱单数据与实际一致', type: 'checkbox', required: true, role: 'merchandiser', group: '出货前最终检查' },
      { key: 'release_result', label: '验货结果', type: 'select', required: true, role: 'merchandiser', group: '放行',
        options: ['放行', '有条件放行(附说明)', '不放行'] },
      { key: 'release_note', label: '条件说明', type: 'text', required: false, role: 'merchandiser', group: '放行' },
      { key: 'final_report_uploaded', label: '最终验货报告已上传', type: 'checkbox', required: false, role: 'merchandiser', group: '放行' },
    ],
  },

  // ══════ 打样流程检查清单 ══════

  sample_confirm: {
    title: '打样单确认检查清单',
    items: [
      { key: 'tech_pack_received', label: '客户 Tech Pack / 参考图已收到', type: 'checkbox', required: true, role: 'sales', group: '客户资料' },
      { key: 'size_chart_confirmed', label: '尺码表已确认', type: 'checkbox', required: true, role: 'sales', group: '客户资料' },
      { key: 'fabric_requirement', label: '面料要求已明确（成分/克重/颜色）', type: 'checkbox', required: true, role: 'sales', group: '客户资料' },
      { key: 'sample_qty', label: '打样数量已确认', type: 'checkbox', required: true, role: 'sales', group: '打样要求' },
      { key: 'sample_type', label: '样品类型', type: 'select', required: true, role: 'sales', group: '打样要求',
        options: ['头样/开发样', '确认样/PP Sample', '产前样', '船样/SMS', '改款样'] },
      { key: 'sample_deadline', label: '客户要求交样日期', type: 'pending_date', required: true, role: 'sales', group: '打样要求',
        affectsSchedule: true },
      { key: 'sample_cost_who_pays', label: '打样费用', type: 'select', required: true, role: 'sales', group: '费用',
        options: ['公司承担', '客户承担', '面料客户承担+加工费公司承担', '待确认'] },
    ],
  },

  sample_shipping_arrange: {
    title: '寄样安排检查清单',
    items: [
      { key: 'courier_company', label: '快递公司', type: 'select', required: true, role: 'sales', group: '快递信息',
        options: ['DHL', 'FedEx', 'UPS', 'TNT', 'EMS', '顺丰国际', '其他'] },
      { key: 'shipping_terms', label: '寄样条款', type: 'select', required: true, role: 'sales', group: '快递信息',
        options: ['DDP（含税到门 — 推荐国际客户）', 'DDU（不含税 — 客户自清关）', '到付（客户账号）'] },
      { key: 'ddp_warning_confirmed', label: '⚠ 已确认：国际客户必须选 DDP 含税，否则客户需自付关税会投诉', type: 'checkbox', required: true, role: 'sales', group: '⚠ 重要提醒' },
      { key: 'tracking_number', label: '快递单号', type: 'text', required: true, role: 'sales', group: '快递信息' },
      { key: 'recipient_address_confirmed', label: '收件地址已和客户确认', type: 'checkbox', required: true, role: 'sales', group: '地址确认' },
      { key: 'packing_photos', label: '包装照片已拍（样品+快递面单）', type: 'checkbox', required: true, role: 'sales', group: '证据' },
    ],
  },

  sample_customer_confirm: {
    title: '客户确认样品检查清单',
    items: [
      { key: 'customer_received', label: '客户已收到样品', type: 'checkbox', required: true, role: 'sales', group: '确认状态' },
      { key: 'customer_feedback', label: '客户反馈', type: 'select', required: true, role: 'sales', group: '确认状态',
        options: ['✅ 通过（可下大货）', '⚠ 需修改（记录修改点）', '❌ 不通过（需重新打样）'] },
      { key: 'modification_notes', label: '修改点记录', type: 'text', required: false, role: 'sales', group: '修改记录',
        helpText: '如客户要求修改，详细记录修改内容（颜色/尺寸/工艺/面料等）' },
      { key: 'customer_evidence', label: '客户确认证据已上传（邮件/消息截图）', type: 'checkbox', required: true, role: 'sales', group: '证据' },
    ],
  },
};

// ══════ 工具函数 ══════

/** 获取指定节点的检查清单配置 */
export function getChecklistForStep(stepKey: string): ChecklistConfig | null {
  return CHECKLIST_MAP[stepKey] || null;
}

/** 判断节点是否有检查清单 */
export function hasChecklistForStep(stepKey: string): boolean {
  return stepKey in CHECKLIST_MAP;
}

/** 安全解析 checklist_data（可能是 JSON 字符串或数组） */
function parseChecklistData(data: unknown): ChecklistData {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

/** 校验检查清单是否全部必填项已完成 */
export function validateChecklistComplete(
  stepKey: string,
  data: ChecklistData | null
): { valid: boolean; missing: string[] } {
  const config = CHECKLIST_MAP[stepKey];
  if (!config) return { valid: true, missing: [] };

  const missing: string[] = [];
  const safeData = parseChecklistData(data);
  const responseMap = new Map(safeData.map(r => [r.key, r]));

  for (const item of config.items) {
    if (!item.required) continue;
    const response = responseMap.get(item.key);
    if (!response || response.value === null || response.value === '' || response.value === false) {
      missing.push(item.label);
    }
  }

  // ── 条件性必填规则（超出 required 静态标记） ──

  // BOM 预评估：超预算时，原因和业务确认变为必填
  if (stepKey === 'order_docs_bom_complete') {
    const budgetStatus = responseMap.get('within_budget')?.value;
    if (typeof budgetStatus === 'string' && budgetStatus.includes('超预算')) {
      const reason = responseMap.get('over_budget_reason')?.value;
      if (!reason) missing.push('超预算/来不及 原因说明');
      const ack = responseMap.get('sales_acknowledged')?.value;
      if (!ack) missing.push('业务已知悉异常情况');
    }
  }

  return { valid: missing.length === 0, missing };
}

/** 获取影响排期的未确认项 */
export function getScheduleAffectingItems(
  stepKey: string,
  data: ChecklistData | null
): { key: string; label: string; pending_date: string }[] {
  const config = CHECKLIST_MAP[stepKey];
  if (!config || !data) return [];

  const results: { key: string; label: string; pending_date: string }[] = [];
  const safeData = parseChecklistData(data);
  const responseMap = new Map(safeData.map(r => [r.key, r]));

  for (const item of config.items) {
    if (item.type !== 'pending_date' || !item.affectsSchedule) continue;
    const response = responseMap.get(item.key);
    if (response?.pending_date) {
      results.push({ key: item.key, label: item.label, pending_date: response.pending_date });
    }
  }

  return results;
}
