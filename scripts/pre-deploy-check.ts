/**
 * 部署前回归检查脚本
 *
 * 每次 git push 前运行，确保关键功能没被破坏
 * 用法：npx tsx scripts/pre-deploy-check.ts
 */

import { MILESTONE_TEMPLATE_V1, MILESTONE_TEMPLATE_V2, SAMPLE_MILESTONE_TEMPLATE, TRADE_MILESTONE_TEMPLATE, getApplicableMilestones } from '../lib/milestoneTemplate';
import { MILESTONE_CONFIRMATION_PARTIES } from '../lib/domain/confirmationParties';
import { overReceiptCheck } from '../lib/domain/procurement';
import { computeSuggestedPurchaseQty } from '../lib/services/procurement-consolidation';
import { matchBaseline, checkOverBaseline, checkTrimTotalOverBudget } from '../lib/domain/cost-baseline';
import { evaluateBudgetGate } from '../lib/procurement/approval';
import { calcDueDates } from '../lib/schedule';
import { CIRCUIT_BREAKER, ACTION_CONFIG } from '../lib/agent/types';
import { buildPurchaseOrderSyncPayload, mapPoLineForFinance } from '../lib/integration/finance-sync';
import { distributeBySize } from '../lib/services/procurement-execution';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

console.log('\n🔍 部署前回归检查\n');

// ════ 1. 里程碑模板完整性 ════
console.log('📋 里程碑模板');
// 2026-07-03 节点体系 V2:生产模板 9 节点(设计 docs/Designs/Milestone-V2-Departments-Redesign.md)。
//   V2 只对新订单生效;V1(11节点)保留服务在途订单与回滚,故仍校验其存在。
assert(MILESTONE_TEMPLATE_V2.length === 15, `标准生产模板有 ${MILESTONE_TEMPLATE_V2.length} 个节点 (=15,业务执行节拍:含订单评审会/包装方式确认,移除生产启动)`);
assert(MILESTONE_TEMPLATE_V1.length >= 11, `V1 生产模板(在途兜底)有 ${MILESTONE_TEMPLATE_V1.length} 个节点 (≥11)`);
assert(SAMPLE_MILESTONE_TEMPLATE.length === 8, `打样模板有 ${SAMPLE_MILESTONE_TEMPLATE.length} 个节点 (=8)`);

// 标准生产模板(14 节点)必须包含的节点(顺序=排期递增)
const requiredSteps = [
  'po_confirmed', 'pi_confirmed', 'production_order_upload', 'order_kickoff_meeting', 'procurement_order_placed',
  'pre_production_sample_sent', 'pre_production_sample_approved',
  'mid_qc_sales_check', 'packing_method_confirmed', 'shipping_sample_send', 'final_qc_sales_check',
  'booking_done', 'ci_made', 'shipment_execute', 'payment_received',
];
for (const step of requiredSteps) {
  assert(MILESTONE_TEMPLATE_V2.some(m => m.step_key === step), `标准生产模板包含 ${step}`);
}
// 已折叠/移除的旧节点不应再出现在标准模板(production_kickoff 归生产中心,2026-07-09 移出业务节拍)
for (const gone of ['finance_approval', 'factory_completion', 'inspection_release', 'mo_released', 'pre_prod_meeting', 'final_qc_check', 'production_kickoff']) {
  assert(!MILESTONE_TEMPLATE_V2.some(m => m.step_key === gone), `标准生产模板不含 ${gone}`);
}
// 新增节点必须在 calcDueDates 有排期(否则建单缺日期)
{
  const due = calcDueDates({ orderDate: '2026-07-03', incoterm: 'FOB', etd: '2026-09-30' });
  for (const step of ['pi_confirmed', 'ci_made', 'order_kickoff_meeting', 'packing_method_confirmed']) {
    assert(due[step] instanceof Date && !isNaN(due[step].getTime()), `calcDueDates 含节点 ${step}`);
  }
}

// ════ 1b. V2 多方确认配置(P1b)════
console.log('\n🤝 多方确认');
{
  const expected: Record<string, number> = {
    po_confirmed: 2,                     // 业务 + 财务
    pre_production_sample_approved: 2,   // 采购 + 业务执行
    final_qc_sales_check: 2,             // QC + 业务执行
    shipment_execute: 3,                 // 业务执行 + 采购 + 财务
  };
  for (const [step, n] of Object.entries(expected)) {
    const parties = MILESTONE_CONFIRMATION_PARTIES[step] || [];
    assert(parties.length === n, `${step} 要求 ${n} 方确认(实际 ${parties.length})`);
    assert(MILESTONE_TEMPLATE_V2.some(m => m.step_key === step), `多方确认节点 ${step} 在 V2 模板里`);
    assert(parties.every(p => p.roles.length > 0 && p.key && p.label), `${step} 各确认方 key/label/roles 完整`);
  }
  // 配置里不能出现 V2 模板没有的节点(防拼写漂移)
  for (const step of Object.keys(MILESTONE_CONFIRMATION_PARTIES)) {
    assert(MILESTONE_TEMPLATE_V2.some(m => m.step_key === step), `确认配置的 ${step} 存在于 V2 模板`);
  }
}

// ════ 采购算账口径(2026-07-04 审计补测试盲区)════
console.log('\n🧮 采购算账');
{
  // 收货 ±10% 闸:1000 → 1100 恰好不超,1101 超,批次累计,ordered=0 不判
  assert(!overReceiptCheck(1000, 0, 1000).over, '收货 1000/1000 不超');
  assert(!overReceiptCheck(1000, 0, 1100).over, '收货 1100/1000 =110% 恰好不超');
  assert(overReceiptCheck(1000, 0, 1101).over, '收货 1101/1000 超10%');
  assert(overReceiptCheck(1000, 900, 250).over, '批次累计 900+250=1150 超');
  assert(!overReceiptCheck(1000, 900, 150).over, '批次累计 900+150=1050 不超');
  assert(!overReceiptCheck(0, 0, 9999).over, 'ordered=0 不判超收');
  // 建议采购量:损耗只乘一次 + 安全库存 + MOQ 取整(废除大货/开发比例)
  assert(computeSuggestedPurchaseQty({ total_required_qty: 1000, procurement_loss_pct: 3 }) === 1030, '建议=1000×1.03=1030(损耗一次)');
  assert(computeSuggestedPurchaseQty({ total_required_qty: 1000, procurement_loss_pct: 0, safety_stock_qty: 50 }) === 1050, '建议=1000+安全50=1050');
  assert(computeSuggestedPurchaseQty({ total_required_qty: 1000, procurement_loss_pct: 0, moq: 500 }) === 1000, 'MOQ 500 对齐 1000');
  assert(computeSuggestedPurchaseQty({ total_required_qty: 1001, procurement_loss_pct: 0, moq: 500 }) === 1500, 'MOQ 500:1001→1500');
  assert(computeSuggestedPurchaseQty({ total_required_qty: null as any }) === null, '无需求量→null');
}

// ════ 采购单→财务 lines(P1-2 修 2026-07-06:预算原辅料 + 收货核销共同源)════
console.log('\n🧾 采购单→财务明细行');
{
  const line = mapPoLineForFinance({ id: 'L1', order_id: 'O1', order_no: 'QM-1', internal_order_no: '1022',
    material_name: '面料A', material_code: 'M1', category: 'fabric', supplier_id: 'S1', supplier_name: '供A',
    ordered_qty: 100, ordered_unit: 'KG', unit_price: 20, ordered_amount: 2000 });
  assert(line.line_id === 'L1', 'line_id = procurement_line_items.id(必与收货同源)');
  assert(line.order_no === 'QM-1' && line.internal_order_no === '1022', '订单号带上(财务反查订单)');
  assert(line.category === 'fabric', 'category 透传(财务分原/辅料预算桶)');
  assert(line.budget_bucket === 'fabric', '面料 budget_bucket=fabric(预算桶)');
  assert(mapPoLineForFinance({ id: 'X', category: 'trim' }).budget_bucket === 'accessory', '辅料(trim)budget_bucket=accessory(不分细类)');
  assert(mapPoLineForFinance({ id: 'Y', category: 'packing' }).budget_bucket === 'accessory', '包装(packing)也归 accessory 桶');
  assert(line.supplier_id === 'S1' && line.supplier_name === '供A', 'supplier 带上(财务按供应商分组)');
  assert(line.amount === 2000, 'amount 取生成列 ordered_amount');
  assert(mapPoLineForFinance({ id: 'L2', ordered_qty: 10, unit_price: 5 }).amount === 50, '无 ordered_amount → 回退 qty×price');
  const trim = mapPoLineForFinance({ id: 'L3', category: 'trim', unit_price: null, ordered_qty: 8 });
  assert(trim.amount === null, '无价 → amount null(无价版不污染台账)');
  assert(trim.category === 'trim', '辅料 category=trim 透传');
  const payload = buildPurchaseOrderSyncPayload({ id: 'PO1', po_no: 'PO-1', total_amount: 2000, supplier_name: '华航布行' }, undefined, undefined,
    [{ id: 'L1', ordered_qty: 100, unit_price: 20, ordered_amount: 2000, category: 'fabric' }]);
  assert(Array.isArray(payload.lines) && (payload.lines as any[]).length === 1, 'payload 含 lines 数组');
  assert((payload.lines as any[])[0].line_id === 'L1', 'payload.lines[0].line_id 同源');
  assert(payload.supplier_name === '华航布行', '单头 supplier_name 必带(财务显示供应商)');
  // 整单一口价(lines 空)也必带单头供应商名 —— 修复 2026-07-08 财务"未带供应商"
  const flat = buildPurchaseOrderSyncPayload({ id: 'PO3', po_no: 'PO-3', total_amount: 67577, supplier_name: '华航布行' });
  assert(flat.supplier_name === '华航布行', 'lines 空时单头 supplier_name 仍必带');
  // caller 未附 supplier_name → 从明细行第一个非空兜底
  const derived = buildPurchaseOrderSyncPayload({ id: 'PO4', po_no: 'PO-4', total_amount: 500 }, undefined, undefined,
    [{ id: 'L9', supplier_name: '供B', ordered_qty: 5, unit_price: 100 }]);
  assert(derived.supplier_name === '供B', 'po 无 supplier_name → 从 lines 兜底');
  const empty = buildPurchaseOrderSyncPayload({ id: 'PO2', po_no: 'PO-2' });
  assert(Array.isArray(empty.lines) && (empty.lines as any[]).length === 0, '无 lines 参数 → 空数组(不 crash)');
  assert(empty.supplier_name === null, '无 supplier_name 无 lines → null(不 crash)');
}

// ════ N1 尺码分摊(2026-07-07:采购执行行按订单各码件数拆行,保 Σ=总量)════
console.log('\n📏 尺码分摊(N1)');
{
  const sum = (a: { qty: number }[]) => a.reduce((s, x) => s + x.qty, 0);
  const r1 = distributeBySize(1500, { S: 600, M: 300, L: 600 });
  assert(sum(r1) === 1500, '1500 按 600:300:600 分,Σ=1500');
  assert(r1.find(x => x.size === 'M')?.qty === 300, 'M 码 = 300(2:1:2 中的 1 份)');
  const r2 = distributeBySize(10, { S: 1, M: 1, L: 1 });
  assert(sum(r2) === 10, '10 按 1:1:1 分,Σ=10(余数补最大码)');
  const r3 = distributeBySize(100, {});
  assert(r3.length === 1 && r3[0].size === null && r3[0].qty === 100, '无尺码件数→单行整量(老口径)');
  const r4 = distributeBySize(0, { S: 5 });
  assert(r4.length === 1 && r4[0].qty === 0, '总量 0→单行 0');
  const r5 = distributeBySize(2364.6, { S: 1, M: 1, L: 1 });
  assert(Math.abs(sum(r5) - 2364.6) < 0.001, 'kg 小数 2364.6 分后 Σ 保 2364.6(余数落最大码)');
  const r6 = distributeBySize(7957, { S: 2650, M: 2650, L: 2657 });
  assert(sum(r6) === 7957, '7957 按 2650:2650:2657 分,Σ=7957');
}

console.log('\n▶ 报价基线对照(P2:超单耗/超价,容差 0)');
{
  const lines = [
    { material_name: '280克直贡呢', color: '黑色', quote_consumption: 0.382, quote_unit_price: 20 },
    { material_name: '拉链', color: null, quote_consumption: 1, quote_unit_price: 0.8 },
  ];
  assert(matchBaseline(lines, '280克直贡呢', '黑色').matched, '同料同色匹配');
  assert(matchBaseline(lines, '拉链', '任意色').matched, '基线通用色(color空)匹配任意色');
  assert(!matchBaseline(lines, '不存在的料', null).matched, '无此料不匹配');
  const b = matchBaseline(lines, '280克直贡呢', '黑色');
  assert(checkOverBaseline(b, 0.383, 20).over_consumption, '大货单耗 0.383>0.382 超');
  assert(!checkOverBaseline(b, 0.382, 20).over_consumption, '大货单耗 0.382=0.382 不超(容差0=严格大于)');
  assert(checkOverBaseline(b, 0.382, 21).over_price, '采购价 21>20 超');
  assert(!checkOverBaseline(b, 0.382, 20).over_price, '采购价 20=20 不超');
  assert(!checkOverBaseline({ matched: true, quote_consumption: null, quote_unit_price: null }, 0.5, 99).over_consumption, '基线值空→不判超');
  assert(checkTrimTotalOverBudget(1001, 1000).over, '辅料总价 1001>1000 超');
  assert(!checkTrimTotalOverBudget(1000, 1000).over, '辅料总价 1000=1000 不超');
  assert(!checkTrimTotalOverBudget(9999, null).over, '预算空→不判超');
  // 款(STYLE)维度:同款优先;旧基线无款向后兼容
  const styled = [
    { style_no: 'A', material_name: '布', color: '黑', quote_consumption: 0.3 },
    { style_no: 'B', material_name: '布', color: '黑', quote_consumption: 0.4 },
  ];
  assert(matchBaseline(styled, '布', '黑', 'A').quote_consumption === 0.3, '款A命中0.3');
  assert(matchBaseline(styled, '布', '黑', 'B').quote_consumption === 0.4, '款B命中0.4(不混款)');
  assert(matchBaseline([{ material_name: '布', quote_consumption: 0.5 }], '布', null, 'A').quote_consumption === 0.5, '旧基线无款→向后兼容匹配');
}

// ── 预算闸(2026-07-05:结合报价预算单,整单总额+单料累计超预算→拦下需财务审批,截付重)──
console.log('\n💰 预算闸(整单+单料累计)');
{
  const M = (name: string, budget: number | null, committed: number, thisPo: number) => ({ name, budget, committed, thisPo });
  // 预算内 → 不拦
  assert(!evaluateBudgetGate({ totalBudget: 10000, committedTotal: 0, thisPoTotal: 8000, byMaterial: [M('布', 10000, 0, 8000)] }).over, '预算内不拦');
  // 付重:料累计(已下单5000+本单5000)超该料预算5000 → 单料+整单超
  const dup = evaluateBudgetGate({ totalBudget: 5000, committedTotal: 5000, thisPoTotal: 5000, byMaterial: [M('布', 5000, 5000, 5000)] });
  assert(dup.reasons.includes('over_budget_material') && dup.overMaterials.includes('布'), '付重→单料超预算截住');
  // 无冻结预算 → 不判(优雅降级)
  assert(!evaluateBudgetGate({ totalBudget: null, committedTotal: 0, thisPoTotal: 99999, byMaterial: [M('布', null, 0, 99999)] }).over, '无预算→不拦');
  // 容差内(超0.3%<0.5%)不误拦;真超(1%)要拦
  assert(!evaluateBudgetGate({ totalBudget: 10000, committedTotal: 0, thisPoTotal: 10030, byMaterial: [] }).over, '容差内不误拦');
  assert(evaluateBudgetGate({ totalBudget: 10000, committedTotal: 0, thisPoTotal: 10100, byMaterial: [] }).overTotal, '真超整单要拦');
  // 单料超但整单不超(别的料没下单)→ 只报单料
  const onlyMat = evaluateBudgetGate({ totalBudget: 20000, committedTotal: 0, thisPoTotal: 6000, byMaterial: [M('布', 5000, 0, 6000), M('扣', 15000, 0, 0)] });
  assert(onlyMat.reasons.length === 1 && onlyMat.reasons[0] === 'over_budget_material', '单料超而整单不超→只报单料');
}

// 打样模板必须包含关键节点
const sampleSteps = ['sample_confirm', 'sample_making', 'sample_qc', 'sample_sent', 'sample_customer_confirm'];
for (const step of sampleSteps) {
  assert(SAMPLE_MILESTONE_TEMPLATE.some(m => m.step_key === step), `打样模板包含 ${step}`);
}

// ════ 2. getApplicableMilestones 路由正确 ════
console.log('\n🔀 模板路由');
const prodMilestones = getApplicableMilestones('bulk', false, 'export');
assert(prodMilestones.length === 15, `export订单返回 ${prodMilestones.length} 个节点 (=15,业务执行节拍)`);
assert(prodMilestones.some(m => m.step_key === 'shipment_execute'), 'export包含 shipment_execute');
assert(prodMilestones.some(m => m.step_key === 'booking_done'), 'export包含订舱出货');

const domesticMilestones = getApplicableMilestones('bulk', false, 'domestic');
// 2026-07-09 更正:送仓单也要船样,只跳「订舱」(送仓无海运订舱)→ 15-1=14
assert(domesticMilestones.length === 14, `domestic生产单 ${domesticMilestones.length} 节点 (=14,只跳订舱,保留船样)`);
assert(domesticMilestones.some(m => m.step_key === 'shipment_execute'), 'domestic含 shipment_execute');
assert(domesticMilestones.some(m => m.step_key === 'shipping_sample_send'), 'domestic保留船样(送仓也要船样)');
assert(!domesticMilestones.some(m => m.step_key === 'booking_done'), 'domestic不含订舱(仅出口海运订舱)');

const sampleMilestones = getApplicableMilestones('sample', false, 'domestic', 'sample');
assert(sampleMilestones.length === 8, `sample订单返回 ${sampleMilestones.length} 个节点 (=8)`);

// ════ 2b. trade(采购成品/经销单)模板 ════
console.log('\n🛒 trade 模板');
// 1) 能生成
assert(TRADE_MILESTONE_TEMPLATE.length > 0, `trade 模板有 ${TRADE_MILESTONE_TEMPLATE.length} 个节点 (>0)`);
const tradeExport = getApplicableMilestones('bulk', false, 'export', 'trade');
assert(tradeExport.length > 0, `trade export 返回 ${tradeExport.length} 个节点`);
// 2) export 含出运/回款
for (const step of ['po_confirmed', 'procurement_order_placed', 'inspection_release', 'booking_done', 'customs_export', 'shipment_execute', 'payment_received']) {
  assert(tradeExport.some(m => m.step_key === step), `trade export 包含 ${step}`);
}
// 4) 不含生产节点
const tradeForbidden = ['production_kickoff', 'cutting_start', 'mid_qc_check', 'final_qc_check', 'factory_completion', 'pre_production_sample_ready', 'pre_production_sample_approved', 'dev_sample_making'];
for (const step of tradeForbidden) {
  assert(!tradeExport.some(m => m.step_key === step), `trade export 不含生产节点 ${step}`);
}
// 3) domestic 用 domestic_delivery 替代出口三件
const tradeDomestic = getApplicableMilestones('bulk', false, 'domestic', 'trade');
assert(tradeDomestic.some(m => m.step_key === 'domestic_delivery'), 'trade domestic 包含 domestic_delivery');
assert(!tradeDomestic.some(m => m.step_key === 'booking_done'), 'trade domestic 不含 booking_done');
assert(!tradeDomestic.some(m => m.step_key === 'shipment_execute'), 'trade domestic 不含 shipment_execute');

// 5) 所有 trade step_key 必须能被 schedule 排期(防止未来新增未知 key 导致 calcDueDates/排期 throw)
const tradeScheduleKeys = new Set<string>([
  ...tradeExport.map(m => m.step_key),
  ...tradeDomestic.map(m => m.step_key),
]);
const tradeDue = calcDueDates({ orderDate: '2026-01-01', createdAt: new Date('2026-01-01'), incoterm: 'FOB', etd: '2026-03-01' });
for (const k of tradeScheduleKeys) {
  assert(tradeDue[k] instanceof Date && !isNaN(tradeDue[k].getTime()), `trade step_key ${k} 能被 schedule 排期(calcDueDates 返回有效日期)`);
}

// ════ 2c. consign(委托加工/外发单)模板 ════
console.log('\n🏭 consign 模板');
// = 标准生产 V2 砍掉「采购核料提交」;出口 14 / 送仓 13
const consignExport = getApplicableMilestones('bulk', false, 'export', 'consign');
assert(consignExport.length === 14, `consign export ${consignExport.length} 节点 (=15-采购核料=14)`);
assert(!consignExport.some(m => m.step_key === 'procurement_order_placed'), 'consign 不含采购核料提交');
// 保留:生产单/评审/产前样/中查/尾查/CI报关/订舱/出运/收款
for (const step of ['po_confirmed', 'production_order_upload', 'order_kickoff_meeting', 'pre_production_sample_approved', 'mid_qc_sales_check', 'final_qc_sales_check', 'ci_made', 'booking_done', 'shipment_execute', 'payment_received']) {
  assert(consignExport.some(m => m.step_key === step), `consign export 保留 ${step}`);
}
const consignDomestic = getApplicableMilestones('bulk', false, 'domestic', 'consign');
assert(consignDomestic.length === 13, `consign domestic ${consignDomestic.length} 节点 (=14-订舱=13)`);
assert(!consignDomestic.some(m => m.step_key === 'booking_done'), 'consign domestic 不含订舱');
assert(consignDomestic.some(m => m.step_key === 'shipping_sample_send'), 'consign domestic 保留船样(与生产同口径)');
// 所有 consign step_key 必须能被 schedule 排期
const consignDue = calcDueDates({ orderDate: '2026-01-01', createdAt: new Date('2026-01-01'), incoterm: 'FOB', etd: '2026-03-01' });
for (const k of new Set<string>([...consignExport.map(m => m.step_key), ...consignDomestic.map(m => m.step_key)])) {
  assert(consignDue[k] instanceof Date && !isNaN(consignDue[k].getTime()), `consign step_key ${k} 能被 schedule 排期`);
}

// 2026-07-09:出口标准单固定 15 节点(业务执行节拍)—— 免产前样/头样/二次样 都不再增删,均返回标准 15(出口)。
const skipSampleMilestones = getApplicableMilestones('bulk', false, 'export', 'production', true);
assert(skipSampleMilestones.length === 15, `免产前样仍固定 ${skipSampleMilestones.length} 节点 (=15)`);
assert(skipSampleMilestones.some(m => m.step_key === 'pre_production_sample_approved'), '免产前样仍含产前样确认(固定15节点)');

const devSampleMilestones = getApplicableMilestones('bulk', false, 'export', 'production', false, 'dev_sample');
assert(devSampleMilestones.length === 15, `头样模式仍固定 ${devSampleMilestones.length} 节点 (=15,不再插头样节点)`);

const devRevisionMilestones = getApplicableMilestones('bulk', false, 'export', 'production', false, 'dev_sample_with_revision');
assert(devRevisionMilestones.length === 15, `二次样模式仍固定 ${devRevisionMilestones.length} 节点 (=15)`);

// ════ 2b. 标准生产模板(15 节点)节点顺序正确性 ════
console.log('\n📐 节点顺序');
function stepIdx(template: typeof prodMilestones, key: string) {
  return template.findIndex((m: any) => m.step_key === key);
}
// 骨架顺序(=业务执行节拍,移除生产启动,新增订单评审会/包装方式确认)
const spine = [
  'po_confirmed', 'pi_confirmed', 'production_order_upload', 'order_kickoff_meeting', 'procurement_order_placed',
  'pre_production_sample_sent', 'pre_production_sample_approved',
  'mid_qc_sales_check', 'packing_method_confirmed', 'final_qc_sales_check',
  'shipping_sample_send', 'ci_made', 'booking_done', 'shipment_execute', 'payment_received',
];
let prevIdx = -1;
for (const key of spine) {
  const idx = stepIdx(prodMilestones, key);
  assert(idx > prevIdx, `节点顺序:${key}(${idx}) 在前一节点之后`);
  prevIdx = idx;
}

// ════ 3. Agent 配置完整性 ════
console.log('\n🤖 Agent 配置');
assert(CIRCUIT_BREAKER.maxPerOrderPerDay === 5, `单订单限制 ${CIRCUIT_BREAKER.maxPerOrderPerDay}/天`);
assert(CIRCUIT_BREAKER.maxGlobalPerHour === 20, `全局限制 ${CIRCUIT_BREAKER.maxGlobalPerHour}/小时`);
assert(CIRCUIT_BREAKER.maxSuggestionsPerOrder === 3, `每单建议 ${CIRCUIT_BREAKER.maxSuggestionsPerOrder} 条`);

const actionTypes = Object.keys(ACTION_CONFIG);
assert(actionTypes.length >= 9, `Agent动作类型 ${actionTypes.length} 种 (≥9)`);
assert(actionTypes.includes('assign_owner'), 'Agent包含 assign_owner');
assert(actionTypes.includes('escalate_ceo'), 'Agent包含 escalate_ceo');

// 每个动作必须有 buttonLabel
for (const [type, config] of Object.entries(ACTION_CONFIG)) {
  assert(!!config.buttonLabel, `${type} 有 buttonLabel`);
}

// ════ 4. 角色定义完整性 ════
console.log('\n👥 角色');
const { ROLE_MAP_TO_DB, ROLE_MAP_FROM_DB } = require('../lib/domain/roles');
const requiredRoles = ['sales', 'sales_manager', 'merchandiser', 'finance', 'procurement', 'production', 'production_manager', 'admin_assistant', 'admin'];
for (const role of requiredRoles) {
  assert(role in ROLE_MAP_TO_DB, `ROLE_MAP_TO_DB 包含 ${role}`);
  assert(role in ROLE_MAP_FROM_DB, `ROLE_MAP_FROM_DB 包含 ${role}`);
}

// ════ 5. Feature Flags 完整性 ════
console.log('\n🚩 Feature Flags');
const { AGENT_FLAGS } = require('../lib/agent/featureFlags');
const requiredFlags = ['autoNudge', 'autoNotifyNext', 'chainActions', 'crossOrderAnalysis', 'aiEnhance', 'wechatPush', 'customerProfile', 'factoryProfile', 'complianceCheck', 'dailyBriefing'];
for (const flag of requiredFlags) {
  assert(typeof AGENT_FLAGS[flag] === 'function', `Flag ${flag} 存在且是函数`);
  assert(typeof AGENT_FLAGS[flag]() === 'boolean', `Flag ${flag}() 返回 boolean`);
}

// ════ 6. Runtime Engine Phase 1 完整性 ════
console.log('\n⚡ Runtime Engine');
const {
  CRITICAL_STEP_KEYS,
  isCriticalStep,
  isShipmentStep,
  STEP_WEIGHT,
} = require('../lib/runtime/criticalNodes');
assert(CRITICAL_STEP_KEYS instanceof Set, 'CRITICAL_STEP_KEYS 是 Set');
assert(CRITICAL_STEP_KEYS.size >= 6, `关键节点 ${CRITICAL_STEP_KEYS.size} 个 (≥6)`);
const requiredCriticalKeys = [
  'finance_approval',
  'production_kickoff',
  'factory_completion',
  'booking_done',
  'domestic_delivery',
];
for (const k of requiredCriticalKeys) {
  assert(isCriticalStep(k), `关键节点包含 ${k}`);
}
assert(isShipmentStep('booking_done'), '出运节点识别正常');
assert(STEP_WEIGHT.production_kickoff === 'critical', 'production_kickoff 权重为 critical');

const { computeDeliveryConfidence, findNextCriticalBlocker } = require('../lib/runtime/deliveryConfidence');
assert(typeof computeDeliveryConfidence === 'function', 'computeDeliveryConfidence 已导出');
assert(typeof findNextCriticalBlocker === 'function', 'findNextCriticalBlocker 已导出');

// 算法 smoke test：空订单不崩
const smokeOut = computeDeliveryConfidence({
  order: { id: 'x', factory_date: null },
  milestones: [],
  now: new Date('2026-05-07T00:00:00Z'),
});
assert(typeof smokeOut.confidence === 'number', 'smoke: 空订单返回 confidence 数字');
assert(smokeOut.confidence >= 0 && smokeOut.confidence <= 100, 'smoke: confidence ∈ [0, 100]');
assert(['green', 'yellow', 'orange', 'red', 'gray'].includes(smokeOut.riskLevel),
  'smoke: riskLevel 合法');
assert(smokeOut.explain && typeof smokeOut.explain.headline === 'string',
  'smoke: explain.headline 是字符串');

// Runtime feature flag helpers 存在
const {
  runtimeConfidenceMode,
  runtimeProjectionEnabled,
  runtimeConfidenceVisible,
} = require('../lib/engine/featureFlags');
assert(typeof runtimeConfidenceMode === 'function', 'runtimeConfidenceMode() 存在');
assert(['off', 'admin', 'on'].includes(runtimeConfidenceMode()),
  `runtimeConfidenceMode() 返回值合法：${runtimeConfidenceMode()}`);
assert(typeof runtimeProjectionEnabled === 'function', 'runtimeProjectionEnabled() 存在');
assert(typeof runtimeConfidenceVisible === 'function', 'runtimeConfidenceVisible() 存在');

// 部署期保护：默认应该是 off（除非显式开启）
const currentMode = runtimeConfidenceMode();
if (currentMode !== 'off') {
  console.log(`  ⚠️  RUNTIME_CONFIDENCE_ENGINE = ${currentMode}（确认是预期的灰度配置）`);
}

// ════ 7. 行业知识库完整性 ════
console.log('\n📚 行业知识');
const { FABRIC_RISKS, QUALITY_ISSUES, BEST_PRACTICES } = require('../lib/agent/industryKnowledge');
assert(Object.keys(FABRIC_RISKS).length >= 4, `面料风险 ${Object.keys(FABRIC_RISKS).length} 种 (≥4)`);
assert(QUALITY_ISSUES.length >= 5, `品质问题 ${QUALITY_ISSUES.length} 种 (≥5)`);
assert(!!BEST_PRACTICES.sampleTimeline, '最佳实践包含 sampleTimeline');

// ════ 结果 ════
console.log(`\n${'═'.repeat(40)}`);
console.log(`✅ 通过: ${passed}`);
console.log(`❌ 失败: ${failed}`);
console.log(`${'═'.repeat(40)}\n`);

if (failed > 0) {
  console.error('🚨 回归检查未通过！请修复后再部署。');
  process.exit(1);
}
console.log('🎉 全部通过，可以安全部署。');
