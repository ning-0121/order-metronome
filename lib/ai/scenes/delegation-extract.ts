/**
 * exec.delegation.extract —— 从 CEO 自由文本抽取委托草案(Executive OS V1 TS1)。
 *
 * 三层语义中的中间层(AI interpretation):产出**候选**结构,供 CEO 确认卡审阅,
 * 绝不直接生效。宽容校验:抓到多少填多少,不确定进 confidence + tentative,不整体硬失败。
 *
 * V1 只抽四类 item_type:fact / proposed_delegation / constraint / risk。
 * 铁律(写进 system prompt):
 *  - 区分事实 vs 可能("可能来中国"→ tentative=true,绝不写成已确认)
 *  - owner_hint 只填 CEO 原话提到的名字,不猜、不补
 *  - deadline 只给原文短语(deadline_text),不自己算日期(后端解析 + 置信度)
 *  - 对手方(客户/人)只给名字,不臆造是否已入库(后端消歧)
 */

import type { JSONSchema, SchemaValidator } from '@/lib/ai/runtime';
import { AIRuntimeError } from '@/lib/ai/runtime';

export interface ExtractedItem {
  item_type: 'fact' | 'proposed_delegation' | 'constraint' | 'risk';
  owner_hint?: string;          // 原话里的负责人名(如"欧璐")
  action?: string;              // 要做什么
  deadline_text?: string;       // 原文时间短语(如"明天下午前"),后端解析
  person?: string;              // 提到的人(如"Gregory")
  customer_hint?: string;       // 提到的客户/公司
  tentative?: boolean;          // "可能/也许/大概" → true
  constraint_type?: string;     // 如 min_margin
  constraint_value?: number;    // 如 15
  restrict?: string;            // 受限动作,如 send
  text?: string;                // 该 item 的原文/说明
  confidence: number;           // 0-1
}
export interface DelegationExtraction { items: ExtractedItem[] }

export const delegationExtractJsonSchema: JSONSchema = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['item_type', 'confidence'],
        properties: {
          item_type: { type: 'string', enum: ['fact', 'proposed_delegation', 'constraint', 'risk'] },
          owner_hint: { type: 'string' }, action: { type: 'string' },
          deadline_text: { type: 'string' }, person: { type: 'string' },
          customer_hint: { type: 'string' }, tentative: { type: 'boolean' },
          constraint_type: { type: 'string' }, constraint_value: { type: 'number' },
          restrict: { type: 'string' }, text: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

const ITEM_TYPES = ['fact', 'proposed_delegation', 'constraint', 'risk'];
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v: unknown): string | undefined => (v == null || v === '' ? undefined : String(v));

export function validateDelegationExtraction(value: unknown): DelegationExtraction {
  if (!value || typeof value !== 'object') throw new AIRuntimeError({ code: 'SCHEMA_MISMATCH', message: 'extraction must be object' });
  const raw = (value as any).items;
  const items: ExtractedItem[] = Array.isArray(raw) ? raw.map((r: any) => {
    const it: ExtractedItem = {
      item_type: ITEM_TYPES.includes(String(r?.item_type)) ? r.item_type : 'fact',
      confidence: Math.max(0, Math.min(1, num(r?.confidence, 0.5))),
    };
    const owner = str(r?.owner_hint); if (owner) it.owner_hint = owner;
    const action = str(r?.action); if (action) it.action = action;
    const dl = str(r?.deadline_text); if (dl) it.deadline_text = dl;
    const person = str(r?.person); if (person) it.person = person;
    const ch = str(r?.customer_hint); if (ch) it.customer_hint = ch;
    if (r?.tentative === true) it.tentative = true;
    const ct = str(r?.constraint_type); if (ct) it.constraint_type = ct;
    if (r?.constraint_value != null && Number.isFinite(Number(r.constraint_value))) it.constraint_value = Number(r.constraint_value);
    const rs = str(r?.restrict); if (rs) it.restrict = rs;
    const t = str(r?.text); if (t) it.text = t;
    return it;
  }) : [];
  return { items };
}

export const delegationExtractValidator: SchemaValidator<DelegationExtraction> = {
  name: 'exec.delegation.extract',
  jsonSchema: delegationExtractJsonSchema,
  parse: validateDelegationExtraction,
};

export const DELEGATION_EXTRACT_SYSTEM = `你是绮陌 CEO 的委托理解助手。把 CEO 的一段话拆成结构化候选条目,供 CEO 二次确认。
只输出 JSON {items:[...]},每条 item_type ∈ fact/proposed_delegation/constraint/risk。
硬规则:
1. 区分【事实】与【可能】:出现"可能/也许/大概/在考虑"等 → tentative=true,绝不写成已确认。
2. owner_hint 只填 CEO 原话里明确提到的负责人名字;没提到就不填,不要猜、不要补默认人。
3. deadline_text 只保留原文时间短语(如"明天下午前""周二"),**不要自己换算成具体日期**。
4. 提到的客户/人只填 person / customer_hint 名字,不判断是否已在系统里。
5. 约束类(如"利润低于15%不要发")→ item_type=constraint, constraint_type=min_margin,
   constraint_value=15, restrict=send。
6. 每条给 confidence(0-1),拿不准就调低,不要编造字段。
只返回 JSON,不要解释。`;
