/**
 * 文件命名标准 — 业务 / 采购 / 跟单 上传文件的命名规范
 *
 * 目的：
 * 1. 让文件一眼能看出属于哪个订单、哪个节点、哪一版
 * 2. 在 Supabase 存储层，附件按「订单号_文档类型」有序归档，便于追溯
 * 3. 避免出现「同一份文件被挂到错误节点」的情况（参考历史 bug：采购单被当作产前样凭证）
 *
 * 命名格式：
 *   {订单号}_{文档类型}[_后缀].{扩展名}
 *
 * 示例：
 *   QM-20260415-001_客户PO.pdf
 *   QM-20260415-001_采购单_面料.xlsx
 *   QM-20260415-001_采购单_辅料.xlsx
 *   QM-20260415-001_产前样照片_正面.jpg
 *   QM-20260415-001_客户确认_20260420.png
 *   QM-20260415-001_中查报告_v2.pdf
 *
 * 命名原则：
 *   ✅ 订单号放最前 — 按订单排序、按订单搜索时最方便
 *   ✅ 文档类型用中文 — 直观、一眼识别
 *   ✅ 后缀用下划线分隔 — 方便加版本号（v1/v2）、日期（20260415）或分类（面料/辅料/包装）
 *   ❌ 不要用特殊字符：不加空格、不加括号、不加 / \ : * ? " < > |
 *   ❌ 不要用「新」「旧」「最终」「修改版」等含糊词 — 用 v1、v2、或日期代替
 *   ❌ 不要只写「采购单.xlsx」「BOM.xlsx」 — 一定要带订单号
 */

export const FILE_NAMING_FORMAT = '{订单号}_{文档类型}[_可选后缀].{扩展名}';

export const FILE_NAMING_RULES = [
  '订单号放最前，例如 QM-20260415-001',
  '文档类型用下方「推荐命名对照表」里的标准词',
  '需要分批/分版本时用下划线加后缀：_v1、_v2、_面料、_辅料、_20260420',
  '不使用空格和特殊字符（/ \\ : * ? " < > | 空格）',
  '不使用「新」「旧」「最终」等含糊词 — 用版本号或日期代替',
];

/**
 * 每个里程碑节点的推荐文档类型和命名示例
 *
 * label:       文档类型关键词（命名中使用的标准词）
 * suffixHint:  后缀建议（可选，提示用户什么时候需要加后缀）
 * example:     完整命名示例
 */
export const FILE_NAMING_BY_STEP: Record<
  string,
  { label: string; suffixHint?: string; example: string }
> = {
  po_confirmed:                    { label: '客户PO',          example: 'QM-20260415-001_客户PO.pdf' },
  finance_approval:                { label: '财务审批记录',     example: 'QM-20260415-001_财务审批记录.pdf' },
  order_kickoff_meeting:           { label: '订单评审会纪要',   example: 'QM-20260415-001_订单评审会纪要.pdf' },
  production_order_upload:         { label: '生产单',          example: 'QM-20260415-001_生产单.xlsx' },
  order_docs_bom_complete:         { label: 'BOM',             suffixHint: '多款时加款号', example: 'QM-20260415-001_BOM.xlsx' },
  bulk_materials_confirmed:        { label: '原辅料确认单',     example: 'QM-20260415-001_原辅料确认单.xlsx' },
  processing_fee_confirmed:        { label: '加工费确认函',     example: 'QM-20260415-001_加工费确认函.pdf' },
  factory_confirmed:               { label: '工厂确认书',       example: 'QM-20260415-001_工厂确认书.pdf' },
  pre_production_sample_ready:     { label: '产前样照片',       suffixHint: '分多张拍摄时加 _正面/_背面/_细节', example: 'QM-20260415-001_产前样照片_正面.jpg' },
  pre_production_sample_sent:      { label: '产前样快递单',     example: 'QM-20260415-001_产前样快递单.jpg' },
  pre_production_sample_approved:  { label: '客户确认_产前样',  example: 'QM-20260415-001_客户确认_产前样.png' },
  procurement_order_placed:        { label: '采购单',          suffixHint: '按面料/辅料/包装分开上传', example: 'QM-20260415-001_采购单_面料.xlsx' },
  materials_received_inspected:    { label: '原辅料验收单',     example: 'QM-20260415-001_原辅料验收单.pdf' },
  pre_production_meeting:          { label: '产前会纪要',       example: 'QM-20260415-001_产前会纪要.pdf' },
  production_kickoff:              { label: '开裁通知单',       example: 'QM-20260415-001_开裁通知单.pdf' },
  mid_qc_check:                    { label: '中查报告',         example: 'QM-20260415-001_中查报告.pdf' },
  mid_qc_sales_check:              { label: '业务中查记录',     example: 'QM-20260415-001_业务中查记录.pdf' },
  packing_method_confirmed:        { label: '包装方式确认',     example: 'QM-20260415-001_包装方式确认.pdf' },
  shipping_sample_send:            { label: '船样寄送',         example: 'QM-20260415-001_船样寄送.jpg' },
  final_qc_check:                  { label: '尾查报告',         example: 'QM-20260415-001_尾查报告.pdf' },
  final_qc_sales_check:            { label: '业务尾查记录',     example: 'QM-20260415-001_业务尾查记录.pdf' },
  factory_completion:              { label: '完工证明',         example: 'QM-20260415-001_完工证明.jpg' },
  leftover_collection:             { label: '剩余物料清单',     example: 'QM-20260415-001_剩余物料清单.xlsx' },
  finished_goods_warehouse:        { label: '成品入库单',       example: 'QM-20260415-001_成品入库单.pdf' },
  inspection_release:              { label: '验货放行单',       example: 'QM-20260415-001_验货放行单.pdf' },
  booking_done:                    { label: '订舱确认',         example: 'QM-20260415-001_订舱确认.pdf' },
  customs_export:                  { label: '报关单',          example: 'QM-20260415-001_报关单.pdf' },
  finance_shipment_approval:       { label: '核准出运记录',     example: 'QM-20260415-001_核准出运记录.pdf' },
  shipment_execute:                { label: '提单',            example: 'QM-20260415-001_提单.pdf' },
  payment_received:                { label: '收款凭证',         example: 'QM-20260415-001_收款凭证.pdf' },
};

/**
 * 每个节点凭证上传时的标准 file_type 值
 *
 * 背景：EvidenceUpload 历史上所有文件都存成 file_type='evidence'，
 * 导致展示时看不出文件属于哪个节点。现在按节点语义分类。
 *
 * 未列出的节点会回退到 'evidence'（向后兼容）。
 */
export const FILE_TYPE_BY_STEP: Record<string, string> = {
  po_confirmed:                   'customer_po',
  finance_approval:               'finance_approval',
  order_kickoff_meeting:          'kickoff_meeting',
  production_order_upload:        'production_order',
  order_docs_bom_complete:        'bom',
  bulk_materials_confirmed:       'trims_sheet',
  processing_fee_confirmed:       'processing_fee_confirm',
  factory_confirmed:              'factory_confirm',
  pre_production_sample_ready:    'pre_production_sample',
  pre_production_sample_sent:     'sample_shipping',
  pre_production_sample_approved: 'customer_approval',
  procurement_order_placed:       'procurement_order',
  materials_received_inspected:   'materials_inspection',
  pre_production_meeting:         'pre_production_meeting',
  production_kickoff:             'production_kickoff',
  mid_qc_check:                   'qc_report',
  mid_qc_sales_check:             'qc_report',
  packing_method_confirmed:       'packing_requirement',
  shipping_sample_send:           'shipping_sample',
  final_qc_check:                 'qc_report',
  final_qc_sales_check:           'qc_report',
  factory_completion:             'factory_completion',
  leftover_collection:            'leftover_list',
  finished_goods_warehouse:       'warehouse_receipt',
  inspection_release:             'inspection_release',
  booking_done:                   'booking_confirm',
  customs_export:                 'customs_doc',
  finance_shipment_approval:      'shipment_approval',
  shipment_execute:               'bill_of_lading',
  payment_received:               'payment_receipt',
};

/** 取节点对应的 file_type，未定义则回退 'evidence' */
export function getFileTypeForStep(stepKey: string | null | undefined): string {
  if (!stepKey) return 'evidence';
  return FILE_TYPE_BY_STEP[stepKey] || 'evidence';
}

// ─────────────────────────────────────────────
// 节点级文件类型白名单 — 拒收错类型文件
// ─────────────────────────────────────────────

/**
 * 某些节点需要强制文件类型，避免用户错上传
 *
 * 例：采购单节点不允许传图片（微信截图等）— 2026-04-15 加
 *
 * 未列出的节点不限制，走默认允许集。
 */
export const FILE_EXT_RESTRICTIONS: Record<string, string[]> = {
  // 采购单必须是正式文档（Excel/PDF），拒收图片
  procurement_order_placed: ['xlsx', 'xls', 'pdf'],
};

/** 默认允许的扩展名 */
const DEFAULT_ALLOWED_EXTS = ['pdf', 'jpg', 'jpeg', 'png', 'xlsx', 'xls', 'doc', 'docx'];

/** 取节点允许的扩展名列表（未限制则返回 null，表示走默认） */
export function getRestrictedExts(stepKey: string | null | undefined): string[] | null {
  if (!stepKey) return null;
  return FILE_EXT_RESTRICTIONS[stepKey] || null;
}

/** 生成 <input accept="..."> 字符串 */
export function getAcceptString(stepKey: string | null | undefined): string {
  const restricted = getRestrictedExts(stepKey);
  const exts = restricted || DEFAULT_ALLOWED_EXTS;
  return exts.map(e => '.' + e).join(',');
}

/** 校验文件扩展名是否被该节点允许 */
export function validateFileExt(
  fileName: string,
  stepKey: string | null | undefined,
): { ok: boolean; restricted: string[] | null; actualExt: string } {
  const restricted = getRestrictedExts(stepKey);
  const actualExt = (fileName.split('.').pop() || '').toLowerCase();
  if (!restricted) return { ok: true, restricted: null, actualExt };
  return { ok: restricted.includes(actualExt), restricted, actualExt };
}

/**
 * 单据中心的文档类型对应的命名关键词
 * DocumentCenterTab 使用，与 FILE_NAMING_BY_STEP 并列
 */
export const FILE_NAMING_BY_DOC_TYPE: Record<
  string,
  { label: string; example: string }
> = {
  pi:               { label: 'PI',          example: 'QM-20260415-001_PI.pdf' },
  production_sheet: { label: '生产单',       example: 'QM-20260415-001_生产单.xlsx' },
  material_sheet:   { label: '原辅料单',     example: 'QM-20260415-001_原辅料单.xlsx' },
  purchase_order:   { label: '采购单',       example: 'QM-20260415-001_采购单.xlsx' },
  packing_list:     { label: '装箱单',       example: 'QM-20260415-001_装箱单.xlsx' },
  ci:               { label: 'CI',          example: 'QM-20260415-001_CI.pdf' },
};

/**
 * 文件 fileType 值（order_attachments.file_type）→ 节点 stepKey 映射
 * 用于「新建订单」等没有明确 stepKey 的上传场景回查命名标准
 */
export const STEP_KEY_BY_FILE_TYPE: Record<string, string> = {
  customer_po:          'po_confirmed',
  finance_approval:     'finance_approval',
  internal_quote:       'finance_approval',
  customer_quote:       'finance_approval',
  production_order:     'production_order_upload',
  trims_sheet:          'bulk_materials_confirmed',
  packing_requirement:  'packing_method_confirmed',
  bom:                  'order_docs_bom_complete',
  tech_pack:            'order_docs_bom_complete',
  procurement_order:    'procurement_order_placed',
  materials_inspection: 'materials_received_inspected',
  qc_report:            'mid_qc_check',
  packing_requirement_doc: 'packing_method_confirmed',
  booking_confirm:      'booking_done',
  bill_of_lading:       'shipment_execute',
  customs_doc:          'customs_export',
  payment_receipt:      'payment_received',
};

/** 从 fileType 反查 stepKey，找不到返回 null */
export function getStepKeyForFileType(fileType: string | null | undefined): string | null {
  if (!fileType) return null;
  return STEP_KEY_BY_FILE_TYPE[fileType] || null;
}

/** 通用命名校验入口：可传 stepKey 或 docType */
export function validateFileNameForLabel(
  fileName: string,
  expectedLabel: string,
  orderNo?: string | null,
): NameCheckResult {
  const issues: NameCheckIssue[] = [];
  const { base, ext } = splitName(fileName);

  if (FORBIDDEN_CHARS.test(base)) {
    issues.push({ code: 'forbidden_chars', message: '包含不允许的字符（/ \\ : * ? " < > |）' });
  }
  const hitVague = VAGUE_WORDS.find(w => base.includes(w));
  if (hitVague) {
    issues.push({ code: 'vague_word', message: `含歧义词"${hitVague}"，请改用版本号（v1/v2）或日期（YYYYMMDD）` });
  }
  if (orderNo && orderNo.trim()) {
    if (!base.includes(orderNo.trim())) {
      issues.push({ code: 'missing_order_no', message: `未包含订单号"${orderNo.trim()}"` });
    }
  }
  if (expectedLabel && !base.includes(expectedLabel)) {
    issues.push({ code: 'missing_label', message: `未包含文档类型关键词"${expectedLabel}"` });
  }
  if (/\s/.test(base)) {
    issues.push({ code: 'has_space', message: '含空格，推荐用下划线替代' });
  }

  const safeOrderNo = orderNo?.trim() || 'QM-订单号';
  const suggestion = `${safeOrderNo}_${expectedLabel}${ext || '.pdf'}`;

  return { ok: issues.length === 0, issues, suggestion };
}

/**
 * 取某节点的推荐命名示例（用于上传区域的 inline 提示）
 * 找不到时返回通用示例
 */
export function getNamingHint(stepKey: string, orderNo?: string | null): {
  label: string;
  example: string;
  suffixHint?: string;
} {
  const hint = FILE_NAMING_BY_STEP[stepKey];
  if (!hint) {
    return {
      label: '凭证',
      example: `${orderNo || 'QM-20260415-001'}_凭证.pdf`,
    };
  }
  // 用真实订单号替换示例里的占位订单号
  if (orderNo && orderNo !== 'QM-20260415-001') {
    return {
      ...hint,
      example: hint.example.replace(/QM-20260415-001/g, orderNo),
    };
  }
  return hint;
}

// ─────────────────────────────────────────────
// 文件名校验 — 上传时检测命名是否符合规范
// ─────────────────────────────────────────────

/** 不允许的字符（Windows/Mac 文件系统禁止 + URL 安全） */
const FORBIDDEN_CHARS = /[\/\\:*?"<>|]/;
/** 歧义词 — 应改用版本号 v1/v2 或日期 */
const VAGUE_WORDS = ['最终版', '最终', 'FINAL', 'final', 'Final', '新版', '新的', 'NEW', 'new', 'New', '最新', '修改版', '改过'];

export interface NameCheckIssue {
  code: 'forbidden_chars' | 'vague_word' | 'missing_order_no' | 'missing_label' | 'has_space' | 'contains_placeholder';
  message: string;
}

export interface NameCheckResult {
  ok: boolean;
  issues: NameCheckIssue[];
  /** 即使 ok=true 也可能给出更"标准"的推荐名供用户参考 */
  suggestion: string;
}

/** 拆分文件名 → 基础名 + 扩展名 */
function splitName(fileName: string): { base: string; ext: string } {
  const idx = fileName.lastIndexOf('.');
  if (idx <= 0) return { base: fileName, ext: '' };
  return { base: fileName.slice(0, idx), ext: fileName.slice(idx) };
}

/** 生成推荐文件名（基础版本，不带后缀） */
export function suggestFileName(
  stepKey: string,
  orderNo: string | null | undefined,
  originalExt: string,
): string {
  const hint = FILE_NAMING_BY_STEP[stepKey];
  const label = hint?.label || '凭证';
  const safeOrderNo = orderNo && orderNo.trim() ? orderNo.trim() : 'QM-订单号';
  const ext = originalExt || '.pdf';
  return `${safeOrderNo}_${label}${ext}`;
}

/**
 * 校验文件名是否符合命名规范
 *
 * 规则（按严重程度排序）：
 *   1. 不含禁止字符（/ \ : * ? " < > |）
 *   2. 不含歧义词（最终/final/new/新版/...）
 *   3. 包含订单号（如果已传 orderNo）
 *   4. 包含该节点的文档类型关键词（如"采购单"、"客户PO"）
 *   5. 不含空格（推荐，但仅提示）
 */
export function validateFileName(
  fileName: string,
  stepKey: string,
  orderNo?: string | null,
): NameCheckResult {
  const issues: NameCheckIssue[] = [];
  const { base, ext } = splitName(fileName);
  const hint = FILE_NAMING_BY_STEP[stepKey];
  const expectedLabel = hint?.label;

  // 1. 禁止字符
  if (FORBIDDEN_CHARS.test(base)) {
    issues.push({
      code: 'forbidden_chars',
      message: '包含不允许的字符（/ \\ : * ? " < > |）',
    });
  }

  // 2. 歧义词
  const hitVague = VAGUE_WORDS.find(w => base.includes(w));
  if (hitVague) {
    issues.push({
      code: 'vague_word',
      message: `含歧义词"${hitVague}"，请改用版本号（v1/v2）或日期（YYYYMMDD）`,
    });
  }

  // 3. 订单号（仅当提供了 orderNo）
  if (orderNo && orderNo.trim()) {
    const on = orderNo.trim();
    if (!base.includes(on)) {
      issues.push({
        code: 'missing_order_no',
        message: `未包含订单号"${on}"`,
      });
    }
  } else {
    // 没有订单号上下文时，提示如果文件名有占位符
    if (/QM-订单号|QM-xxxx|QM-XXXX/i.test(base)) {
      issues.push({
        code: 'contains_placeholder',
        message: '文件名含占位符（QM-订单号/QM-xxxx），请替换为实际订单号',
      });
    }
  }

  // 4. 文档类型关键词
  if (expectedLabel && !base.includes(expectedLabel)) {
    // 允许几个常见同义词（按现实使用习惯放宽）
    const synonyms: Record<string, string[]> = {
      采购单: ['采购订单', 'PO单', 'purchase'],
      客户PO: ['PO', 'po', 'Po'],
      BOM: ['bom', 'Bom'],
      产前样照片: ['产前样', '样衣'],
    };
    const syn = synonyms[expectedLabel] || [];
    const matchSyn = syn.some(s => base.includes(s));
    if (!matchSyn) {
      issues.push({
        code: 'missing_label',
        message: `未包含文档类型关键词"${expectedLabel}"`,
      });
    }
  }

  // 5. 空格（软提示，不阻塞）
  if (/\s/.test(base)) {
    issues.push({
      code: 'has_space',
      message: '含空格，推荐用下划线替代',
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    suggestion: suggestFileName(stepKey, orderNo, ext),
  };
}

/** 按新文件名创建一份新的 File（保留原 blob 数据） */
export function renameFile(file: File, newName: string): File {
  if (file.name === newName) return file;
  // File 构造函数支持从已有 Blob 创建新 File
  return new File([file], newName, {
    type: file.type,
    lastModified: file.lastModified,
  });
}
