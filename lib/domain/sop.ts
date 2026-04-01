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
  // ── 订单启动会（业务/理单）──────────────────
  order_kickoff_meeting: {
    sop_title: '订单启动会 SOP',
    sop_steps: [
      '1. 财务审核通过后 2 日内组织召开订单启动会',
      '2. 参会人员：CEO、业务/理单、采购、跟单',
      '3. 逐项过订单关键信息：客户要求、款号、数量、交期、特殊工艺',
      '4. 明确各环节责任人及关键时间节点',
      '5. 讨论风险点并制定应对方案',
      '6. 会议纪要记录并分发至各参会人员',
    ],
    required_fields: [
      '会议纪要（含参会人签到）',
      '各环节责任人确认',
      '风险点及应对方案',
    ],
    completion_rules: [
      '启动会已在财务审核后 2 日内召开',
      'CEO、业务、采购、跟单均已参会',
      '会议纪要已记录并分发',
    ],
  },

  // ── 生产单上传（业务）──────────────────
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

  // ── BOM + 包装要求（业务）──────────────────
  order_docs_bom_complete: {
    sop_title: '原辅料预评估 SOP',
    sop_steps: [
      '1. 确认面料供应商是否已有，还是需要寻找/客户指定',
      '2. 确认辅料（拉链、纽扣、吊牌、洗标、条码、包装袋等）供应商',
      '3. 评估大致到料时间，是否能匹配生产排期',
      '4. 核对原辅料价格是否在预算范围内',
      '5. 标注高风险材料（高弹面料克重偏差、浅色色差、特殊工艺面料等）',
      '6. 如有风险，及时反馈给业务调整报价或沟通客户',
    ],
    required_fields: [
      '面料供应商确认',
      '辅料供应商确认',
      '到料时间评估',
    ],
    completion_rules: [
      '面料和辅料供应商已确认',
      '到料时间能匹配生产排期',
      '高风险材料已标注并通知业务',
    ],
  },

  // ── 生产预评估（跟单）──────────────────
  bulk_materials_confirmed: {
    sop_title: '生产预评估 SOP',
    sop_steps: [
      '1. 评估交期是否可行：根据当前产能和排期判断是否能按时出货',
      '2. 评估工艺难点：是否有特殊工艺、复杂印花、特殊面料等难点',
      '3. 评估品质风险：根据产品类型和客户要求判断品质控制要点',
      '4. 预估加工费范围：结合工艺难度和数量评估合理的加工费区间',
      '5. 如交期或工艺存在重大风险，及时上报管理层和业务协调',
    ],
    required_fields: [
      '交期可行性评估',
      '工艺难点评估',
    ],
    completion_rules: [
      '交期可行性已确认',
      '工艺难点已评估并记录',
      '如有风险已上报',
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
      '5. 如 ETA 晚于生产排期，立即通知业务 + 跟单',
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
      '1. 召集参会人员：生产主管、跟单、业务',
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

  // ── 包装方式确认（业务）──────────────────
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

  // ── 订舱（业务）──────────────────
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
  // ── 加工费确认 ──
  processing_fee_confirmed: {
    sop_title: '加工费确认 SOP',
    sop_steps: [
      '1. 根据报价单和工厂反馈的加工费核对成本',
      '2. 确认加工费是否在预算范围内',
      '3. 如超预算需与业务沟通调整方案',
      '4. 财务审批加工费并上传确认函',
    ],
    required_fields: [
      '加工费确认函',
    ],
    completion_rules: [
      '加工费已确认在预算范围内',
      '确认函已上传',
    ],
  },
  // ── 确认工厂 ──
  factory_confirmed: {
    sop_title: '确认工厂 SOP',
    sop_steps: [
      '1. 确认加工费已通过财务审批',
      '2. 确认产前样已通过客户确认',
      '3. 综合评估工厂产能和交期能力',
      '4. 正式下达生产指令给工厂',
      '5. 上传工厂确认书/生产合同',
    ],
    required_fields: [
      '工厂确认书或生产合同',
    ],
    completion_rules: [
      '加工费已确认',
      '产前样已通过客户确认',
      '工厂已确认接单并上传凭证',
    ],
  },

  po_confirmed: {
    sop_title: 'PO确认 SOP',
    sop_steps: [
      '1. 确认已上传三份文件：客户PO + 内部报价单 + 客户最终报价单',
      '2. 核对三单关键信息：款号、数量、尺码配比、颜色、交期是否一致',
      '3. AI 自动三单比对，确认差异项并处理',
      '4. 确认贸易条款（FOB/DDP）、付款方式',
      '5. 检查并标注特殊要求（浅色、撞色、大码、复杂印花等风险标签）',
      '6. 完成检查清单全部必填项后标记完成',
    ],
    required_fields: ['客户 PO', '内部报价单', '客户最终报价单'],
    completion_rules: ['三份文件已上传', '三单关键信息核对一致', '检查清单全部必填项已完成'],
  },

  finance_approval: {
    sop_title: '财务审核 SOP',
    sop_steps: [
      '1. 核对订单金额、利润率是否达标',
      '2. 确认客户付款方式和信用条件',
      '3. 检查是否有历史欠款或风险',
      '4. 审核通过后标记完成，不通过标记阻塞并注明原因',
    ],
    required_fields: ['审核意见'],
    completion_rules: ['财务确认订单可执行', '利润率达标'],
  },

  pre_production_sample_ready: {
    sop_title: '产前样准备完成 SOP',
    sop_steps: [
      '1. 跟单协调工厂按 PO 要求制作产前样',
      '2. 核对面料、辅料、工艺是否与确认样一致',
      '3. 检查尺寸、做工、颜色是否符合客户要求',
      '4. 拍照留档（正面、背面、细节、吊牌）',
      '5. 确认无误后标记完成',
    ],
    required_fields: ['产前样照片（正/背/细节）'],
    completion_rules: ['产前样制作完成', '面料/工艺与确认样一致', '照片已上传'],
  },

  pre_production_sample_sent: {
    sop_title: '产前样寄出 SOP',
    sop_steps: [
      '1. 确认寄送地址和收件人',
      '2. 安排快递/国际物流寄出',
      '3. 获取运单号并记录',
      '4. 通知客户产前样已寄出，提供运单号',
    ],
    required_fields: ['运单号'],
    completion_rules: ['产前样已寄出', '已通知客户'],
  },

  pre_production_sample_approved: {
    sop_title: '产前样客户确认 SOP',
    sop_steps: [
      '1. 跟进客户收样情况',
      '2. 获取客户书面确认（邮件/签字）',
      '3. 如客户提出修改意见，记录并反馈给工厂',
      '4. 客户确认 OK 后上传确认凭证，标记完成',
    ],
    required_fields: ['客户确认邮件或签字文件'],
    completion_rules: ['客户书面确认产前样合格', '确认凭证已上传'],
  },

  materials_received_inspected: {
    sop_title: '原辅料到货验收 SOP',
    sop_steps: [
      '1. 核对到货物料与采购订单是否一致（品名、数量、规格）',
      '2. 检查面料克重、颜色、手感是否达标',
      '3. 检查辅料（拉链、纽扣、吊牌等）规格和数量',
      '4. 有问题及时标记阻塞并通知采购和业务',
      '5. 验收通过后标记完成',
    ],
    required_fields: ['验收确认'],
    completion_rules: ['所有面辅料已到货', '品质验收通过', '数量与采购单一致'],
  },

  factory_completion: {
    sop_title: '工厂完成 SOP',
    sop_steps: [
      '1. 确认工厂所有生产已完成',
      '2. 核对总产量与订单数量是否一致',
      '3. 确认包装已按要求完成',
      '4. 准备验货/放行',
    ],
    required_fields: ['完成确认'],
    completion_rules: ['生产数量达标', '包装完成', '可以安排验货'],
  },

  shipping_sample_send: {
    sop_title: '船样寄送 SOP',
    sop_steps: [
      '1. 从大货中抽取船样（按客户要求的数量和尺码）',
      '2. 船样必须是大货完整包装状态',
      '3. 寄出并记录运单号',
      '4. 通知客户船样已寄出',
    ],
    required_fields: ['运单号'],
    completion_rules: ['船样已从大货抽取', '已寄出并通知客户'],
  },

  finance_shipment_approval: {
    sop_title: '核准出运 SOP',
    sop_steps: [
      '1. 确认客户款项已收到或信用证条件已满足',
      '2. 核对装箱单、发票金额',
      '3. 确认无财务风险后核准放行出运',
    ],
    required_fields: ['财务核准确认'],
    completion_rules: ['款项确认或信用证条件满足', '财务核准放行'],
  },

  shipment_execute: {
    sop_title: '出运 SOP',
    sop_steps: [
      '1. 协调货车装柜',
      '2. 拍摄装柜照片（空柜、装货过程、满柜、封柜）',
      '3. 确认柜号、铅封号',
      '4. 货物离港后获取提单',
      '5. 上传装柜照片和提单',
    ],
    required_fields: ['装柜照片', '提单/运单'],
    completion_rules: ['货物已装柜出运', '提单已获取并上传'],
  },

  payment_received: {
    sop_title: '收款完成 SOP',
    sop_steps: [
      '1. 跟踪客户付款进度',
      '2. 确认款项到账',
      '3. 核对金额是否与合同一致',
      '4. 标记收款完成',
    ],
    required_fields: ['到账确认'],
    completion_rules: ['款项已到账', '金额与合同一致'],
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
