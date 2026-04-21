/**
 * 部署前回归检查脚本
 *
 * 每次 git push 前运行，确保关键功能没被破坏
 * 用法：npx tsx scripts/pre-deploy-check.ts
 */

import { MILESTONE_TEMPLATE_V1, SAMPLE_MILESTONE_TEMPLATE, getApplicableMilestones } from '../lib/milestoneTemplate';
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
assert(MILESTONE_TEMPLATE_V1.length >= 20, `生产模板有 ${MILESTONE_TEMPLATE_V1.length} 个节点 (≥20)`);
assert(SAMPLE_MILESTONE_TEMPLATE.length === 8, `打样模板有 ${SAMPLE_MILESTONE_TEMPLATE.length} 个节点 (=8)`);

// 生产模板必须包含关键节点（含跟单/业务双重验货）
const requiredSteps = [
  'po_confirmed', 'finance_approval', 'production_kickoff',
  'mid_qc_check', 'mid_qc_sales_check',
  'final_qc_check', 'final_qc_sales_check',
  'inspection_release', 'payment_received',
];
for (const step of requiredSteps) {
  assert(MILESTONE_TEMPLATE_V1.some(m => m.step_key === step), `生产模板包含 ${step}`);
}

// 打样模板必须包含关键节点
const sampleSteps = ['sample_confirm', 'sample_making', 'sample_qc', 'sample_sent', 'sample_customer_confirm'];
for (const step of sampleSteps) {
  assert(SAMPLE_MILESTONE_TEMPLATE.some(m => m.step_key === step), `打样模板包含 ${step}`);
}

// ════ 2. getApplicableMilestones 路由正确 ════
console.log('\n🔀 模板路由');
const prodMilestones = getApplicableMilestones('bulk', false, 'export');
assert(prodMilestones.length >= 20, `export订单返回 ${prodMilestones.length} 个节点`);

const domesticMilestones = getApplicableMilestones('bulk', false, 'domestic');
assert(domesticMilestones.length < prodMilestones.length, `domestic订单节点数(${domesticMilestones.length}) < export(${prodMilestones.length})`);
assert(domesticMilestones.some(m => m.step_key === 'domestic_delivery'), 'domestic包含 domestic_delivery');
assert(!domesticMilestones.some(m => m.step_key === 'booking_done'), 'domestic不包含 booking_done');

const sampleMilestones = getApplicableMilestones('sample', false, 'domestic', 'sample');
assert(sampleMilestones.length === 8, `sample订单返回 ${sampleMilestones.length} 个节点 (=8)`);

// 跳过产前样（skip_all）：3 个产前样节点应被过滤掉
const skipSampleMilestones = getApplicableMilestones('bulk', false, 'export', 'production', true);
assert(
  !skipSampleMilestones.some(m => m.step_key === 'pre_production_sample_ready'),
  '跳过产前样模式：不包含 pre_production_sample_ready'
);
assert(
  skipSampleMilestones.length === prodMilestones.length - 3,
  `跳过产前样模式节点数(${skipSampleMilestones.length}) = 标准export(${prodMilestones.length}) - 3`
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

// 头样节点顺序正确：dev_sample → pre_production_sample
const devIdx = devSampleMilestones.findIndex((m: any) => m.step_key === 'dev_sample_customer_confirm');
const preIdx = devSampleMilestones.findIndex((m: any) => m.step_key === 'pre_production_sample_ready');
assert(devIdx < preIdx, `头样确认(${devIdx}) 在产前样准备(${preIdx})之前`);

// ════ 2b. 生产模板节点顺序正确性 ════
console.log('\n📐 节点顺序');
function stepIdx(template: typeof prodMilestones, key: string) {
  return template.findIndex((m: any) => m.step_key === key);
}
// 包装确认 → 船样寄送 → 尾查 → 工厂完成
const packingIdx = stepIdx(prodMilestones, 'packing_method_confirmed');
const shippingSampleIdx = stepIdx(prodMilestones, 'shipping_sample_send');
const finalQcIdx = stepIdx(prodMilestones, 'final_qc_check');
const factoryCompIdx = stepIdx(prodMilestones, 'factory_completion');
const bookingIdx = stepIdx(prodMilestones, 'booking_done');
assert(packingIdx < shippingSampleIdx, `包装确认(${packingIdx}) 在船样寄送(${shippingSampleIdx})之前`);
assert(shippingSampleIdx < finalQcIdx, `船样寄送(${shippingSampleIdx}) 在尾查(${finalQcIdx})之前`);
assert(finalQcIdx < factoryCompIdx, `尾查(${finalQcIdx}) 在工厂完成(${factoryCompIdx})之前`);
assert(factoryCompIdx < bookingIdx, `工厂完成(${factoryCompIdx}) 在订舱(${bookingIdx})之前`);
// 产前样流程顺序
const ppReadyIdx = stepIdx(prodMilestones, 'pre_production_sample_ready');
const ppSentIdx = stepIdx(prodMilestones, 'pre_production_sample_sent');
const ppApprovedIdx = stepIdx(prodMilestones, 'pre_production_sample_approved');
const kickoffIdx = stepIdx(prodMilestones, 'production_kickoff');
assert(ppReadyIdx < ppSentIdx, `产前样准备(${ppReadyIdx}) 在产前样寄出(${ppSentIdx})之前`);
assert(ppSentIdx < ppApprovedIdx, `产前样寄出(${ppSentIdx}) 在客户确认(${ppApprovedIdx})之前`);
assert(ppApprovedIdx < kickoffIdx, `客户确认产前样(${ppApprovedIdx}) 在生产启动(${kickoffIdx})之前`);

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
const requiredRoles = ['sales', 'merchandiser', 'finance', 'procurement', 'production', 'production_manager', 'admin_assistant', 'admin'];
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

// ════ 6. 行业知识库完整性 ════
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
