/**
 * 「待客户指令出运」— 货已备好，仅因客户合并发货 / 等出运通知而暂未出货。
 * 与工厂/production 延误区分，避免风险评分与横幅持续红色误报。
 */

export const CUSTOMER_SHIP_HOLD_TAG = '待客户指令出运';

/** 备注里常见的「客户侧等出运」表述（不要求连续「等通知」三字） */
const CUSTOMER_HOLD_NOTE_PATTERN =
  /等客户|客人通知|通知发货|合并.{0,8}发|拼柜|指令出运|等运|待客人|客户侧/i;

function notesSuggestCustomerHold(notes: string): boolean {
  if (notes.includes('【超期确认】货已完成，等客户发货通知')) return true;
  if (notes.includes('【超期确认】待发货') && CUSTOMER_HOLD_NOTE_PATTERN.test(notes)) {
    return true;
  }
  return false;
}

export function isCustomerShipHoldFromOrder(order: {
  special_tags?: string[] | null;
  notes?: string | null;
}): boolean {
  const tags = Array.isArray(order.special_tags) ? order.special_tags : [];
  if (tags.includes(CUSTOMER_SHIP_HOLD_TAG)) return true;
  const n = order.notes || '';
  return notesSuggestCustomerHold(n);
}

/** 用于备注片段的客户侧等待（业务手写时常省略「超期确认」前缀） */
export function textLooksLikeCustomerShipHold(text: string): boolean {
  if (!text?.trim()) return false;
  return CUSTOMER_HOLD_NOTE_PATTERN.test(text);
}

export function mergeCustomerShipHoldTag(existing: string[] | null | undefined): string[] {
  const base = Array.isArray(existing) ? [...existing] : [];
  if (!base.includes(CUSTOMER_SHIP_HOLD_TAG)) base.push(CUSTOMER_SHIP_HOLD_TAG);
  return base;
}

/**
 * 距当前「出厂/预计锚点」已超过 N 天 —— 提醒业务更新预计出运日或复核备注。
 * （不等同于生产延误；仅对客户待运单做温和黄灯。）
 */
export const CUSTOMER_HOLD_STALE_DAYS = 14;

export function isCustomerHoldStale(order: {
  factory_date?: string | null;
  special_tags?: string[] | null;
  notes?: string | null;
}): boolean {
  if (!isCustomerShipHoldFromOrder(order)) return false;
  const fd = order.factory_date;
  if (!fd) return false;
  const anchor = new Date(String(fd).slice(0, 10) + 'T23:59:59');
  const daysPast = Math.ceil((Date.now() - anchor.getTime()) / 86400000);
  return daysPast >= CUSTOMER_HOLD_STALE_DAYS;
}
