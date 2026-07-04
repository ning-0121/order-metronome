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
import { calcDueDates } from '../lib/schedule';
import { CIRCUIT_BREAKER, ACTION_CONFIG } from '../lib/agent/types';

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
assert(MILESTONE_TEMPLATE_V2.length === 9, `V2 生产模板有 ${MILESTONE_TEMPLATE_V2.length} 个节点 (=9)`);
assert(MILESTONE_TEMPLATE_V1.length >= 11, `V1 生产模板(在途兜底)有 ${MILESTONE_TEMPLATE_V1.length} 个节点 (≥11)`);
assert(SAMPLE_MILESTONE_TEMPLATE.length === 8, `打样模板有 ${SAMPLE_MILESTONE_TEMPLATE.length} 个节点 (=8)`);

// V2 生产模板必须包含的 9 个节点(顺序=排期递增)
const requiredSteps = [
  'po_confirmed', 'mo_released', 'pre_prod_meeting', 'procurement_order_placed',
  'pre_production_sample_approved', 'production_kickoff', 'final_qc_check',
  'shipment_execute', 'payment_received',
];
for (const step of requiredSteps) {
  assert(MILESTONE_TEMPLATE_V2.some(m => m.step_key === step), `V2 生产模板包含 ${step}`);
}
// V2 已折叠/移除的旧节点不应再出现在新模板
for (const gone of ['finance_approval', 'factory_completion', 'inspection_release', 'booking_done']) {
  assert(!MILESTONE_TEMPLATE_V2.some(m => m.step_key === gone), `V2 生产模板已移除 ${gone}`);
}
// V2 新增节点必须在 calcDueDates 有排期(否则建单缺日期)
{
  const due = calcDueDates({ orderDate: '2026-07-03', incoterm: 'FOB', etd: '2026-09-30' });
  for (const step of ['mo_released', 'pre_prod_meeting']) {
    assert(due[step] instanceof Date && !isNaN(due[step].getTime()), `calcDueDates 含 V2 节点 ${step}`);
  }
}

// ════ 1b. V2 多方确认配置(P1b)════
console.log('\n🤝 多方确认');
{
  const expected: Record<string, number> = {
    po_confirmed: 2,                     // 业务执行 + 财务
    pre_prod_meeting: 3,                 // 业务执行 + 生产 + 采购
    pre_production_sample_approved: 2,   // 采购 + 业务执行
    final_qc_check: 2,                   // QC + 业务执行
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
}

// 打样模板必须包含关键节点
const sampleSteps = ['sample_confirm', 'sample_making', 'sample_qc', 'sample_sent', 'sample_customer_confirm'];
for (const step of sampleSteps) {
  assert(SAMPLE_MILESTONE_TEMPLATE.some(m => m.step_key === step), `打样模板包含 ${step}`);
}

// ════ 2. getApplicableMilestones 路由正确 ════
console.log('\n🔀 模板路由');
const prodMilestones = getApplicableMilestones('bulk', false, 'export');
assert(prodMilestones.length === 9, `export订单返回 ${prodMilestones.length} 个节点 (=9, V2)`);
assert(prodMilestones.some(m => m.step_key === 'shipment_execute'), 'export包含 shipment_execute');

const domesticMilestones = getApplicableMilestones('bulk', false, 'domestic');
// V2:domestic 用 domestic_delivery 替换 shipment_execute(节点数与 export 相同)
assert(domesticMilestones.some(m => m.step_key === 'domestic_delivery'), 'domestic包含 domestic_delivery');
assert(!domesticMilestones.some(m => m.step_key === 'shipment_execute'), 'domestic不含出运 shipment_execute');

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

// 跳过产前样（skip_all）：极简模板里产前样只剩"产前样客户确认"一个 → 应被过滤掉
const skipSampleMilestones = getApplicableMilestones('bulk', false, 'export', 'production', true);
assert(
  !skipSampleMilestones.some(m => m.step_key === 'pre_production_sample_approved'),
  '跳过产前样模式：不包含 pre_production_sample_approved'
);
assert(
  skipSampleMilestones.length === prodMilestones.length - 1,
  `跳过产前样模式节点数(${skipSampleMilestones.length}) = 标准export(${prodMilestones.length}) - 1`
);

// 头样模式：增加 3 个头样节点
const devSampleMilestones = getApplicableMilestones('bulk', false, 'export', 'production', false, 'dev_sample');
assert(
  devSampleMilestones.some(m => m.step_key === 'dev_sample_making'),
  '头样模式：包含 dev_sample_making'
);
assert(
  devSampleMilestones.some(m => m.step_key === 'dev_sample_customer_confirm'),
  '头样模式：包含 dev_sample_customer_confirm'
);
assert(
  devSampleMilestones.length === prodMilestones.length + 3,
  `头样模式节点数(${devSampleMilestones.length}) = 标准export(${prodMilestones.length}) + 3`
);

// 头样+二次样模式：增加 6 个节点
const devRevisionMilestones = getApplicableMilestones('bulk', false, 'export', 'production', false, 'dev_sample_with_revision');
assert(
  devRevisionMilestones.some(m => m.step_key === 'dev_sample_revision'),
  '二次样模式：包含 dev_sample_revision'
);
assert(
  devRevisionMilestones.some(m => m.step_key === 'dev_sample_revision_confirm'),
  '二次样模式：包含 dev_sample_revision_confirm'
);
assert(
  devRevisionMilestones.length === prodMilestones.length + 6,
  `二次样模式节点数(${devRevisionMilestones.length}) = 标准export(${prodMilestones.length}) + 6`
);

// 头样节点顺序:头样确认 在 产前样客户确认 之前(极简模板锚点改为 approved)
const devIdx = devSampleMilestones.findIndex((m: any) => m.step_key === 'dev_sample_customer_confirm');
const devPreIdx = devSampleMilestones.findIndex((m: any) => m.step_key === 'pre_production_sample_approved');
assert(devIdx >= 0 && devIdx < devPreIdx, `头样确认(${devIdx}) 在产前样客户确认(${devPreIdx})之前`);

// ════ 2b. V2 生产模板(9 节点骨架)节点顺序正确性 ════
console.log('\n📐 节点顺序');
function stepIdx(template: typeof prodMilestones, key: string) {
  return template.findIndex((m: any) => m.step_key === key);
}
// V2 骨架顺序(=排期递增):PO确认→生产任务单下发→产前会→采购下单→产前样确认→生产启动→尾查验货→发货出运→收款
const spine = [
  'po_confirmed', 'mo_released', 'pre_prod_meeting', 'procurement_order_placed',
  'pre_production_sample_approved', 'production_kickoff', 'final_qc_check',
  'shipment_execute', 'payment_received',
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
