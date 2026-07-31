import { describe, it, expect } from 'vitest';
import {
  ORDER_CREATE_RULES,
  resolveOrderFormRules,
  findMissingRequired,
  type OrderFormCtx,
} from '@/lib/domain/formRules';

/**
 * 建单字段规则单一真相源(2026-07-31,L2 第一步)。
 *
 * 接入前必须证明两件事:
 *   ① 不传任何覆盖时,行为 == 现状(否则一上线就改了所有人的建单流程);
 *   ② 隐藏的字段一律不必填 —— 这是配置化最容易踩的死局:
 *      把某字段对某客户隐藏,后端还照校验 → 用户看不见那个框,却永远提交不了,且不知道为什么。
 */

const req = (rules: Record<string, { required: boolean }>) =>
  Object.entries(rules).filter(([, r]) => r.required).map(([k]) => k).sort();

describe('默认规则 == 现状', () => {
  it('普通新单(有PO/正常单/未勾船样)的必填集合就是线上那一组', () => {
    const ctx: OrderFormCtx = { poMode: 'has_po', orderType: 'bulk' };
    expect(req(resolveOrderFormRules(ctx))).toEqual([
      'color_count', 'customer_po_number', 'factory_date', 'incoterm',
      'internal_order_no', 'order_date', 'order_type', 'quantity_unit',
      'style_count', 'total_quantity',
    ]);
  });

  it('后端原有的 5 个硬编码校验,一个不少地仍是必填', () => {
    const r = resolveOrderFormRules({ poMode: 'has_po' });
    for (const f of ['internal_order_no', 'factory_date', 'total_quantity', 'style_count', 'color_count']) {
      expect(r[f].required, `${f} 应必填`).toBe(true);
    }
  });

  it('选填字段没有被误升成必填', () => {
    const r = resolveOrderFormRules({ poMode: 'has_po' });
    for (const f of ['etd', 'warehouse_due_date', 'cancel_date', 'notes', 'factory_name', 'aql_standard']) {
      expect(r[f].required, `${f} 应选填`).toBe(false);
    }
  });
});

describe('情境必填', () => {
  it('选「没有客户 PO」时不再强制填 PO 号 —— 这是本次有意修掉的矛盾', () => {
    expect(resolveOrderFormRules({ poMode: 'no_po' }).customer_po_number.required).toBe(false);
    expect(resolveOrderFormRules({ poMode: 'has_po' }).customer_po_number.required).toBe(true);
  });

  it('勾了「颜色待定」→ 颜色数免填(与 createOrder 原有豁免一致)', () => {
    expect(resolveOrderFormRules({ colorPending: true }).color_count.required).toBe(false);
    expect(resolveOrderFormRules({ colorPending: false }).color_count.required).toBe(true);
  });

  it('翻单才要求填「上次返单问题」', () => {
    expect(resolveOrderFormRules({ orderType: 'repeat' }).repeat_issues.required).toBe(true);
    expect(resolveOrderFormRules({ orderType: 'bulk' }).repeat_issues.required).toBe(false);
  });

  it('勾了 Shipping Sample 才要求截止日期', () => {
    expect(resolveOrderFormRules({ shippingSampleRequired: true }).shipping_sample_deadline.required).toBe(true);
    expect(resolveOrderFormRules({}).shipping_sample_deadline.required).toBe(false);
  });
});

describe('覆盖层', () => {
  it('传空覆盖 == 代码默认(接入即无感)', () => {
    const ctx: OrderFormCtx = { poMode: 'has_po', orderType: 'bulk' };
    expect(resolveOrderFormRules(ctx, [])).toEqual(resolveOrderFormRules(ctx));
  });

  it('可以把选填改成必填', () => {
    const r = resolveOrderFormRules({}, [{ field_name: 'etd', required: true }]);
    expect(r.etd.required).toBe(true);
  });

  it('可以把必填改成选填', () => {
    const r = resolveOrderFormRules({ poMode: 'has_po' }, [{ field_name: 'customer_po_number', required: false }]);
    expect(r.customer_po_number.required).toBe(false);
  });

  it('客户级覆盖压过 global(按 global → customer 顺序传入)', () => {
    const r = resolveOrderFormRules({}, [
      { field_name: 'etd', required: true },    // global
      { field_name: 'etd', required: false },   // customer
    ]);
    expect(r.etd.required).toBe(false);
  });

  it('只覆盖 required 时不会把 default 抹掉', () => {
    const r = resolveOrderFormRules({}, [{ field_name: 'incoterm', required: false }]);
    expect(r.incoterm.defaultValue).toBe('DDP');
  });

  it('配置里写一个不存在的字段名 → 忽略,不会凭空冒出字段', () => {
    const r = resolveOrderFormRules({}, [{ field_name: '不存在的字段', required: true, visible: true }]);
    expect(r['不存在的字段']).toBeUndefined();
  });
});

describe('死局防线:隐藏的字段一律不必填', () => {
  it('把必填字段隐藏 → 自动变不必填,不会出现"看不见却提交不了"', () => {
    const r = resolveOrderFormRules({ poMode: 'has_po' }, [{ field_name: 'customer_po_number', visible: false }]);
    expect(r.customer_po_number.visible).toBe(false);
    expect(r.customer_po_number.required).toBe(false);
  });

  it('即使配置同时写了 visible:false + required:true,也以不必填为准', () => {
    const r = resolveOrderFormRules({}, [{ field_name: 'etd', visible: false, required: true }]);
    expect(r.etd.required).toBe(false);
  });

  it('隐藏字段不会出现在缺失必填的报错里', () => {
    const rules = resolveOrderFormRules({ poMode: 'has_po' }, [{ field_name: 'internal_order_no', visible: false }]);
    expect(findMissingRequired({}, rules)).not.toContain('内部订单号');
  });
});

describe('服务端校验 findMissingRequired', () => {
  const rules = resolveOrderFormRules({ poMode: 'has_po', orderType: 'bulk' });

  it('全填齐 → 无缺失', () => {
    expect(findMissingRequired({
      internal_order_no: '1022976', factory_date: '2026-10-01', total_quantity: 1200,
      style_count: 2, color_count: 4, customer_po_number: 'PO-1', order_date: '2026-07-31',
      order_type: 'bulk', incoterm: 'DDP', quantity_unit: '件',
    }, rules)).toEqual([]);
  });

  it('缺的按人话报出来,不是字段名', () => {
    const missing = findMissingRequired({ internal_order_no: '1022976' }, rules);
    expect(missing).toContain('出厂日期');
    expect(missing).toContain('预估总数量');
    expect(missing).not.toContain('内部订单号');
  });

  it('空字符串和纯空格都算没填', () => {
    expect(findMissingRequired({ factory_date: '' }, rules)).toContain('出厂日期');
    expect(findMissingRequired({ factory_date: '   ' }, rules)).toContain('出厂日期');
  });

  it('数字 0 视为已填 —— 别把合法的 0 当空值(如某些计数字段)', () => {
    const r = resolveOrderFormRules({}, [{ field_name: 'etd', required: true }]);
    expect(findMissingRequired({ etd: 0 }, r)).not.toContain('ETD 离港日');
  });
});

describe('规则表自身的完整性', () => {
  it('每个字段都有 label —— 报错要说人话', () => {
    for (const [name, r] of Object.entries(ORDER_CREATE_RULES)) {
      expect(r.label, `${name} 缺 label`).toBeTruthy();
    }
  });

  it('字段名用 snake_case,与表单 name 属性一致', () => {
    for (const name of Object.keys(ORDER_CREATE_RULES)) {
      expect(name, `${name} 命名不符`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
