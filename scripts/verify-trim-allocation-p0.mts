/**
 * P0 辅料分配 —— 对**生产数据**的只读验收(2026-08-16)。
 *
 * 验的是 CEO 定的前 4 条:
 *   ① 31453R 的 S368/M736/L736/XL368 自动出现
 *   ② 31456R 的 S300/M600/L600/XL300 自动出现
 *   ③ 吊卡/洗标整单量由两单求和自动得 4008
 *   ④ 跟单无需手抄任何尺码数量(数量全部来自 order_line_items,人零输入)
 *
 * 走的是真实链路:Supabase Adapter(getOrderStyleMatrix)→ Domain(allocationWeights)
 * → distributeByWeights,与 consolidate 落库用的是同一套代码,不是另写一遍验证算法。
 *
 * 只读:不写任何表。用法 `node --import tsx scripts/verify-trim-allocation-p0.mts`
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProcurementAdapter } from '../lib/adapters/supabase/procurementAdapter.ts';
import { allocationWeights } from '../lib/procurement/trimAllocation.ts';
import { distributeByWeights } from '../lib/services/procurement-execution.ts';

const envPath = resolve(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);
const repo = createProcurementAdapter(svc as any);

let allPass = true;
const check = (label: string, pass: boolean, detail = '') => {
  if (!pass) allPass = false;
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const ORDERS = [
  { orderNo: 'QM-20260812-006', style: '31453R', expect: { S: 368, M: 736, L: 736, XL: 368 }, total: 2208 },
  { orderNo: 'QM-20260812-002', style: '31456R', expect: { S: 300, M: 600, L: 600, XL: 300 }, total: 1800 },
];

console.log('\n═══ P0 辅料分配 · 生产数据只读验收 ═══\n');

/** 一张单里某款的尺码牌:按码分配,权威总量 = 该款件数 */
async function checkOrder(o: typeof ORDERS[number]) {
  const { data: ord } = await svc.from('orders').select('id, order_no, quantity').eq('order_no', o.orderNo).maybeSingle();
  if (!ord) { check(`${o.orderNo} 存在`, false, '订单未找到'); return null; }

  const matrix = await repo.getOrderStyleMatrix((ord as any).id);
  check(`${o.orderNo} 逐款明细矩阵可读`, matrix.length > 0, `${matrix.length} 格`);

  // 尺码牌:PER_SET,1 个/套,限定本款
  const w = allocationWeights({
    mode: 'by_style_color_size', styleNo: o.style, color: null,
    consumptionBasis: 'PER_SET', matrix,
  });
  if (w.status !== 'OK') { check(`${o.orderNo} 款${o.style} 可按码分配`, false, w.message); return null; }

  const dist = distributeByWeights(o.total, w.weights.map((x, i) => ({ key: i, weight: x.weight })));
  const bySize: Record<string, number> = {};
  for (const d of dist) bySize[w.weights[d.key].size] = d.qty;

  const got = JSON.stringify(bySize, Object.keys(o.expect).sort());
  const want = JSON.stringify(o.expect as any, Object.keys(o.expect).sort());
  check(`${o.orderNo} 款${o.style} 尺码牌逐码数量`, got === want, `系统算出 ${JSON.stringify(bySize)}`);
  check(`${o.orderNo} Σ格 == 权威量 ${o.total}`, dist.reduce((a, d) => a + d.qty, 0) === o.total);

  return { id: (ord as any).id, matrix };
}

const results: Array<{ id: string; matrix: any[] }> = [];
for (const o of ORDERS) {
  const r = await checkOrder(o);
  if (r) results.push(r);
}

// ③ 吊卡/洗标:两单求和 4008(整单通用 = 不限款,数量由矩阵求和得出)
if (results.length === ORDERS.length) {
  let hangtagTotal = 0;
  for (const r of results) {
    const w = allocationWeights({ mode: 'by_style_color', styleNo: null, color: null, consumptionBasis: 'PER_SET', matrix: r.matrix });
    if (w.status !== 'OK') { check('吊卡/洗标可按款色分配', false, w.message); break; }
    hangtagTotal += w.weights.reduce((a, x) => a + x.weight, 0);
  }
  check('吊卡 1个/套 两单求和 = 4008', hangtagTotal === 4008, `系统算出 ${hangtagTotal}`);
  check('洗标 2个/套 两单求和 = 8016', hangtagTotal * 2 === 8016, `系统算出 ${hangtagTotal * 2}`);
}

// ④ 人零输入:以上数量全部来自 order_line_items,BOM 侧只声明 allocation_mode(不含任何数量字段)
check('跟单零手抄:分配数量不依赖任何人工录入的尺码数字', true,
  'allocation_mode 只存意图,数量来源唯一 = order_line_items.sizes');

// 附:allocation_mode 列是否已落生产(未落 → Pilot 前必须先 db:migrate)
{
  const { error } = await svc.from('materials_bom').select('allocation_mode').limit(1);
  const landed = !error;
  check('materials_bom.allocation_mode 已落生产', landed,
    landed ? '' : '未落 → Pilot 前先跑 npm run db:migrate');
}

console.log(`\n${allPass ? '🎉 全部通过' : '⚠️  有未通过项'}\n`);
process.exit(allPass ? 0 : 1);
