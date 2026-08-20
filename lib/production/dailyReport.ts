// ============================================================
// 生产日报解析 —— 纯逻辑(不碰 DB、不 'use server')
//
// 格式(2026-08-19 CEO 定):每件事一行
//   【订单号】工序 / 状态 [/ 日期]:说明
// 铁律:【】里放**系统订单号**(internal_order_no,如 603 / 1022934 / 601B),
//   不带客户前缀(RAG)、不放款号(L23/J95)。款号写进说明。
//
// 实测(scripts 比对 221 张真实订单):真订单号后缀匹配 10/10 唯一命中;
//   失败项全是款号或带 RAG 前缀 —— 都由上面这条格式铁律规避。
// ============================================================

export type ReportStatus = '完成' | '进行中' | '受阻' | '待跟进';

/** 状态 → 订单动态分类(order_notes_log.category)+ 是否为「标节点完成」候选 */
export const STATUS_META: Record<ReportStatus, { category: 'general' | 'delay' | 'quality'; canCompleteNode: boolean; icon: string }> = {
  '完成':   { category: 'general', canCompleteNode: true,  icon: '✅' },
  '进行中': { category: 'general', canCompleteNode: false, icon: '🔧' },
  '受阻':   { category: 'delay',   canCompleteNode: false, icon: '🚧' },
  '待跟进': { category: 'general', canCompleteNode: false, icon: '👀' },
};

const STATUS_ALIASES: Record<string, ReportStatus> = {
  '完成': '完成', '已完成': '完成', '完': '完成', '做完': '完成',
  '进行中': '进行中', '在做': '进行中', '进行': '进行中', '生产中': '进行中',
  '受阻': '受阻', '阻塞': '受阻', '卡住': '受阻', '风险': '受阻', '延期': '受阻',
  '待跟进': '待跟进', '跟进': '待跟进', '催': '待跟进', '跟踪': '待跟进', '追踪': '待跟进',
};

/**
 * 工序词 → 对应里程碑节点的匹配线索(step_key 别名 + 中文名关键字)。
 * 只匹配「订单自己真实存在的节点」,匹配不到就仅记动态(不同模板 V1/V2/V3 节点粗细不同,
 * 硬编码假设会静默错标 —— 见 [[v1-v2-stepkey-drift]])。
 */
const PROCESS_HINTS: Array<{ process: string; keys: string[]; nameKw: string[] }> = [
  { process: '物料',   keys: ['procurement_order_placed', 'material_ready', 'materials_ready'], nameKw: ['采购', '物料', '原料', '原辅料'] },
  { process: '开裁',   keys: ['cutting', 'production_kickoff'], nameKw: ['开裁', '裁剪', '裁床'] },
  { process: '裁剪',   keys: ['cutting', 'production_kickoff'], nameKw: ['裁剪', '开裁', '裁床'] },
  { process: '缝制',   keys: ['sewing'], nameKw: ['缝制', '车缝'] },
  { process: '打腰卡', keys: [], nameKw: ['腰卡'] },
  { process: '包装',   keys: ['packing_method_confirmed', 'packing', 'packaging'], nameKw: ['包装'] },
  { process: '装箱',   keys: [], nameKw: ['装箱'] },
  { process: '封样',   keys: ['sample_sealed'], nameKw: ['封样'] },
  { process: '产前样', keys: ['pre_production_sample_approved'], nameKw: ['产前样'] },
  { process: '船样',   keys: ['shipping_sample', 'shipment_sample'], nameKw: ['船样'] },
  { process: '验货样', keys: [], nameKw: ['验货样', '验货'] },
  { process: '中检',   keys: ['mid_qc_check'], nameKw: ['中期验货', '中检', '中期'] },
  { process: '尾检',   keys: ['final_qc_check'], nameKw: ['尾查', '尾期', '尾检'] },
  { process: '尾查',   keys: ['final_qc_check'], nameKw: ['尾查', '尾期', '尾检'] },
  { process: '放标',   keys: [], nameKw: ['放标'] },
  { process: '版确认', keys: [], nameKw: ['版确认', '确认版'] },
  { process: '产前会', keys: ['pre_prod_meeting'], nameKw: ['产前会'] },
];

export const PROCESS_VOCAB = PROCESS_HINTS.map((p) => p.process);

export interface ParsedLine {
  raw: string;
  orderToken: string | null;   // 【】里的内容
  process: string | null;
  status: ReportStatus | null;
  date: string | null;         // 原样保留(如 "20号"/"今天"/"周五"),不强解析成日历日
  note: string;
  parseError?: string;         // 该行无法结构化的原因(仍保留原文,不丢)
}

const norm = (s: unknown) => String(s ?? '').trim().toUpperCase();

/** 拆一整段日报为逐行结构。跳过标题/空行;条目前缀 "1." "2、" 自动剥掉。 */
export function parseDailyReport(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (let rawLine of (text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 跳过"YYYY.MM.DD 工作总结""XX:XX""某人:"这类非条目行
    if (/^\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}/.test(line) && /工作总结|日报/.test(line)) continue;
    if (/^[^【]*[:：]\s*\d{4}[.\-/]\d/.test(line)) continue; // "骆淑娟:2026.08.19 工作总结"
    // 剥列表前缀
    const body = line.replace(/^\s*\d+\s*[.、,)）:：]\s*/, '').trim();
    if (!body) continue;

    const bracket = /^【\s*([^】]*?)\s*】\s*(.*)$/.exec(body);
    if (!bracket) {
      out.push({ raw: line, orderToken: null, process: null, status: null, date: null, note: body, parseError: '未按【订单号】开头' });
      continue;
    }
    const orderToken = bracket[1].trim() || null;
    const rest = bracket[2].trim();
    // 说明:第一个中/英文冒号之后(冒号本身之前是 工序/状态/日期 头)
    const colonIdx = rest.search(/[:：]/);
    const head = colonIdx >= 0 ? rest.slice(0, colonIdx).trim() : rest.trim();
    const note = colonIdx >= 0 ? rest.slice(colonIdx + 1).trim() : '';
    const parts = head.split(/\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
    let process: string | null = null, status: ReportStatus | null = null, date: string | null = null;
    for (const p of parts) {
      if (!status && STATUS_ALIASES[p]) { status = STATUS_ALIASES[p]; continue; }
      if (!process) { process = p; continue; }
      if (!date) { date = p; continue; }
    }
    const parseError = orderToken ? undefined : '订单号为空';
    out.push({ raw: line, orderToken, process, status, date, note: note || head, parseError });
  }
  return out;
}

export interface OrderRef { id: string; orderNo: string | null; internalNo: string | null; customer: string | null; }

export interface OrderResolution {
  orderId: string | null;
  matchedNo: string | null;
  how: 'exact-internal' | 'exact-orderno' | 'suffix-internal' | 'none' | 'ambiguous';
  candidates: OrderRef[];   // ambiguous/none 时给候选,供人选
}

/**
 * 订单号 → 真订单。阶梯:精确 internal → 精确 order_no → 唯一后缀 internal → 候选。
 * 会剥掉常见客户前缀(纯字母)再试一次:"RAG588" → "588"。
 */
export function resolveOrder(token: string | null, orders: OrderRef[]): OrderResolution {
  if (!token) return { orderId: null, matchedNo: null, how: 'none', candidates: [] };
  const T = norm(token);
  const stripped = T.replace(/^[A-Z]+(?=\d)/, ''); // RAG588 → 588;纯字母(款号)不动

  const exactInternal = orders.filter((o) => norm(o.internalNo) === T || norm(o.internalNo) === stripped);
  if (exactInternal.length === 1) return { orderId: exactInternal[0].id, matchedNo: exactInternal[0].internalNo, how: 'exact-internal', candidates: [] };
  if (exactInternal.length > 1) return { orderId: null, matchedNo: null, how: 'ambiguous', candidates: exactInternal };

  const exactOrderNo = orders.filter((o) => norm(o.orderNo) === T);
  if (exactOrderNo.length === 1) return { orderId: exactOrderNo[0].id, matchedNo: exactOrderNo[0].orderNo, how: 'exact-orderno', candidates: [] };

  // 后缀:"934" → "1022934"。至少 3 位,防 "1"/"12" 这种噪声乱匹配。
  const key = stripped.length >= 3 ? stripped : T;
  if (key.length >= 3) {
    const suffix = orders.filter((o) => { const i = norm(o.internalNo); return i.length > key.length && i.endsWith(key); });
    if (suffix.length === 1) return { orderId: suffix[0].id, matchedNo: suffix[0].internalNo, how: 'suffix-internal', candidates: [] };
    if (suffix.length > 1) return { orderId: null, matchedNo: null, how: 'ambiguous', candidates: suffix };
  }
  return { orderId: null, matchedNo: null, how: 'none', candidates: [] };
}

export interface MilestoneRef { id: string; stepKey: string; name: string | null; status: string; }

export interface ProcessMatch {
  milestoneId: string | null;
  milestoneName: string | null;
  how: 'unique' | 'none' | 'ambiguous' | 'already-done';
  candidates: MilestoneRef[];
}

/** 工序词 → 该订单真实节点。只在订单自己有的节点里找,找不到就 none(仅记动态)。 */
export function matchProcessToMilestone(process: string | null, milestones: MilestoneRef[]): ProcessMatch {
  if (!process) return { milestoneId: null, milestoneName: null, how: 'none', candidates: [] };
  const hint = PROCESS_HINTS.find((h) => h.process === process)
    || PROCESS_HINTS.find((h) => h.nameKw.some((k) => process.includes(k)));
  if (!hint) return { milestoneId: null, milestoneName: null, how: 'none', candidates: [] };

  const hits = milestones.filter((m) => {
    const key = String(m.stepKey || '').toLowerCase();
    const nm = String(m.name || '');
    return hint.keys.some((k) => key === k.toLowerCase()) || hint.nameKw.some((kw) => nm.includes(kw));
  });
  if (hits.length === 0) return { milestoneId: null, milestoneName: null, how: 'none', candidates: [] };
  if (hits.length > 1) return { milestoneId: null, milestoneName: null, how: 'ambiguous', candidates: hits };
  const only = hits[0];
  if (only.status === 'done' || only.status === '已完成') {
    return { milestoneId: only.id, milestoneName: only.name, how: 'already-done', candidates: [only] };
  }
  return { milestoneId: only.id, milestoneName: only.name, how: 'unique', candidates: [only] };
}
