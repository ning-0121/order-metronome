/**
 * SOP 标准操作规程 V1
 *
 * 每个关键节点对应一套 SOP 指引，包含：
 * - sop_title: 操作标题
 * - sop_steps: 具体步骤
 * - required_fields: 必须填写/上传的内容
 * - completion_rules: 完成判定规则
 */

export interface SOPConfig {
  sop_title: string;
  sop_steps: string[];
  required_fields: string[];
  completion_rules: string[];
}

/**
 * step_key → SOP 配置映射
 */
export const SOP_MAP: Record<string, SOPConfig> = {
  // ── 生产单上传（理单）──────────────────
  production_order_upload: {
    sop_title: '生产单上传 SOP',
    sop_steps: [
      '1. 根据客户 PO 及财务审核结果，填写生产单模板',
      '2. 核对款号、数量、尺码配比、颜色与 PO 一致',
      '3. 确认面料/辅料要求已在 BOM 中注明',
      '4. 填写工厂名称、交货日期、包装要求',
      '5. 导出 PDF 或 Excel，上传至节点凭证区',
    ],
    required_fields: [
      '生产单文件（PDF/Excel）',
      '款号 + 数量 + 尺码配比',
      '面料/辅料要求',
      '工厂名称 + 交货日期',
    ],
    completion_rules: [
      '生产单文件已上传',
      '关键信息（款号、数量、尺码）与 PO 一致',
      '工厂 + 交期已确认',
    ],
  },

  // ── BOM + 包装要求（理单）──────────────────
  order_docs_bom_complete: {
    sop_title: 'BOM + 包装要求上传 SOP',
    sop_steps: [
      '1. 从客户 PO/Tech Pack 提取物料清单',
      '2. 填写 BOM 表：面料、里料、辅料、吊牌、条码、贴标',
      '3. 确认包装方式：折叠方式、尺码条位置、外箱规格、唛头',
      '4. 标注高风险物料（高弹面料、浅色、大码特殊处理）',
      '5. 上传 BOM 表和包装要求文件',
    ],
    required_fields: [
      'BOM 清单（面料/辅料/包装物料）',
      '包装方式说明',
      '外箱规格 + 唛头要求',
    ],
    completion_rules: [
      'BOM 文件已上传',
      '包装要求已注明',
      '风险物料已标注',
    ],
  },

  // ── 大货原辅料确认（采购）──────────────────
  bulk_materials_confirmed: {
    sop_title: '大货原辅料确认 SOP',
    sop_steps: [
      '1. 核对 BOM 清单，确认所有物料款号/色号/克重',
      '2. 与供应商确认面料可用性及交期',
      '3. 确认辅料（拉链、纽扣、吊牌、条码等）规格及数量',
      '4. 标注风险项：高弹面料克重偏差、浅色色差、大码特殊用量',
      '5. 填写确认记录，上传至节点凭证区',
    ],
    required_fields: [
      '主面料确认（款号/色号/克重）',
      '辅料清单确认',
      '风险备注（如有）',
    ],
    completion_rules: [
      '所有面辅料已确认可用',
      '供应商交期已确认',
      '风险项已标注并通知理单',
    ],
  },

  // ── 采购下单 + ETA（采购）──────────────────
  procurement_order_placed: {
    sop_title: '采购下单 SOP',
    sop_steps: [
      '1. 根据已确认的 BOM 生成采购订单',
      '2. 向供应商下单并获取订单确认回执',
      '3. 确认每项物料的预计到货日期（ETA）',
      '4. 将采购订单截图和 ETA 上传至节点凭证区',
      '5. 如 ETA 晚于生产排期，立即通知理单 + 生产',
    ],
    required_fields: [
      '采购订单截图',
      '供应商确认回执',
      '各物料预计到货日期（ETA）',
    ],
    completion_rules: [
      '采购订单已发出',
      '供应商已确认',
      'ETA 已记录且不影响排期',
    ],
  },

  // ── 生产排期 + 开裁（生产）──────────────────
  production_kickoff: {
    sop_title: '生产排期 + 开裁 SOP',
    sop_steps: [
      '1. 确认物料已全部到位验收通过',
      '2. 安排排产计划（开裁日期、完成日期、日产量）',
      '3. 与工厂确认产能和排期无冲突',
      '4. 执行开裁，拍照记录（铺布 + 裁床）',
      '5. 上传排产单 + 开裁记录照片',
    ],
    required_fields: [
      '排产单（排期计划）',
      '开裁记录照片',
    ],
    completion_rules: [
      '物料到位且验收通过',
      '排产单已确认',
      '开裁已执行并拍照上传',
    ],
  },

  // ── 产前会（生产）──────────────────
  pre_production_meeting: {
    sop_title: '产前会 SOP',
    sop_steps: [
      '1. 召集参会人员：生产主管、理单、QC',
      '2. 逐项过客户要求：版型、尺寸、面辅料、印花/绣花/洗水',
      '3. 确认关键质量标准和特殊工艺',
      '4. 明确检验节点和抽检比例',
      '5. 产前会记录签字，拍照上传',
    ],
    required_fields: [
      '产前会记录文档',
      '签到表照片',
    ],
    completion_rules: [
      '会议已召开',
      '关键要求已确认无异议',
      '会议记录 + 签到已上传',
    ],
  },

  // ── 中查（QC）──────────────────
  mid_qc_check: {
    sop_title: '中查 SOP',
    sop_steps: [
      '1. 在生产完成 30%-50% 时安排中查',
      '2. 按 AQL 标准抽检：外观、尺寸、做工、标签位',
      '3. 记录问题清单（分类：A/B/C 级）',
      '4. 将整改要求发给工厂，设定整改期限',
      '5. 上传中查报告（含抽检比例 + 问题清单 + 整改要求）',
    ],
    required_fields: [
      '中查报告',
      '抽检比例',
      '问题清单（如有）',
      '整改要求（如有）',
    ],
    completion_rules: [
      '中查已完成',
      '问题已记录并下发整改要求',
      '报告已上传',
    ],
  },

  // ── 尾查（QC）──────────────────
  final_qc_check: {
    sop_title: '尾查 SOP',
    sop_steps: [
      '1. 在包装前安排尾查（ETD - 7 天）',
      '2. 按 AQL 标准全面抽检：外观、尺寸、功能、标签、包装',
      '3. 对比产前样和客户要求，逐项确认',
      '4. 填写 AQL 检验报告，标注 PASS/FAIL',
      '5. PASS → 签发合格证书 → 允许进入包装环节',
      '6. FAIL → 下发返工要求 → 安排复验',
    ],
    required_fields: [
      'AQL 检验报告',
      '合格证书（PASS 时）或返工要求（FAIL 时）',
    ],
    completion_rules: [
      '尾查已完成',
      'AQL 检验报告已上传',
      '检验结果为 PASS（否则不可进入包装）',
    ],
  },

  // ── 包装方式确认（理单）──────────────────
  packing_method_confirmed: {
    sop_title: '包装方式确认 SOP',
    sop_steps: [
      '1. 到工厂现场确认包装方式',
      '2. 逐项核对：折叠方式、尺码条位置、吊牌/条码位置',
      '3. 核对外箱规格、唛头内容、装箱数量',
      '4. 拍照记录（折叠方式 + 尺码条位 + 唛头位）',
      '5. 上传现场照片至节点凭证区',
    ],
    required_fields: [
      '现场包装照片（折叠 + 尺码条 + 唛头）',
      '外箱规格确认',
    ],
    completion_rules: [
      '现场包装方式已确认',
      '照片已上传',
      '与客户要求一致',
    ],
  },

  // ── 验货/放行（QC）──────────────────
  inspection_release: {
    sop_title: '验货/放行 SOP',
    sop_steps: [
      '1. 安排第三方验货或内部终检',
      '2. 验货报告确认 PASS 后，签发放行单',
      '3. 如需客户验货，提前通知并安排',
      '4. 上传验货报告 / 放行单至节点凭证区',
    ],
    required_fields: [
      '第三方验货报告 或 内部放行单',
    ],
    completion_rules: [
      '验货已完成且 PASS',
      '放行单已签发',
      '报告已上传',
    ],
  },

  // ── 装箱（物流/理单）──────────────────
  booking_done: {
    sop_title: '订舱 SOP',
    sop_steps: [
      '1. 根据 ETD 和货物体积/重量，联系货代订舱',
      '2. 确认船期、截关日、截柜日',
      '3. 获取 Booking Confirmation 并核对信息',
      '4. 协调装柜时间和地点',
      '5. 上传 Booking Confirmation 至节点凭证区',
    ],
    required_fields: [
      'Booking Confirmation（订舱确认单）',
    ],
    completion_rules: [
      '订舱已确认',
      '船期与 ETD 匹配',
      '确认单已上传',
    ],
  },

  // ── 报关 + 出运（物流）──────────────────
  customs_export: {
    sop_title: '报关 + 出运 SOP',
    sop_steps: [
      '1. 准备报关资料：装箱单、发票、合同、报关委托书',
      '2. 提交报关行进行报关',
      '3. 确认放行后安排装柜出运',
      '4. 获取提单（B/L）并核对信息',
      '5. 上传提单 + 报关单至节点凭证区',
    ],
    required_fields: [
      '提单（B/L）',
      '报关单',
    ],
    completion_rules: [
      '报关已放行',
      '货物已出运',
      '提单已获取并上传',
    ],
  },
};

/**
 * 获取节点的 SOP 配置
 */
export function getSOPForStep(stepKey: string): SOPConfig | null {
  return SOP_MAP[stepKey] || null;
}

/**
 * 判断节点是否有 SOP
 */
export function hasSOPForStep(stepKey: string): boolean {
  return stepKey in SOP_MAP;
}
