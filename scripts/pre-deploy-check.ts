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
assert(SAMPLE_MILESTONE_TEMPLATE.length === 7, `打样模板有 ${SAMPLE_MILESTONE_TEMPLATE.length} 个节点 (=7)`);

// 生产模板必须包含关键节点
const requiredSteps = ['po_confirmed', 'finance_approval', 'production_kickoff', 'mid_qc_check', 'final_qc_check', 'inspection_release', 'payment_received'];
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
assert(sampleMilestones.length === 7, `sample订单返回 ${sampleMilestones.length} 个节点 (=7)`);

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
