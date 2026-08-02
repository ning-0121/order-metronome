#!/usr/bin/env node
/**
 * TDZ 硬闸(2026-07-31 事故后加)。
 *
 * 事故:把 useMemo/useEffect 插在它依赖的 useState **之前**,构建期完全不报错
 * (暂时性死区是运行时的),线上直接白屏 `Cannot access 'xx' before initialization`,
 * 建单页整页打不开。本地又因为要登录没能真机跑到,于是一路推到生产才发现。
 *
 * 这里只对**核心入口文件**做硬闸:出问题会瘫痪整条建单链路,不能靠人肉小心。
 * 其余文件在 eslint.config.mjs 里设为 warn(存量 8 个文件 31 处,待逐步清理)。
 *
 * 只统计 no-use-before-define 一条规则 —— eslint 的 --rule 是**追加**不是替换,
 * 直接用它的退出码会把 no-explicit-any 之类的既有告警一起算进来,误挡整条 check 链。
 */
import { ESLint } from 'eslint';

// POOrderForm 已随报价器整条下线删除(2026-08-01),不再守护。
const FILES = [
  'components/order/LegacyOrderForm.tsx',
  'components/order/FormSection.tsx',
];
const RULE = '@typescript-eslint/no-use-before-define';

const eslint = new ESLint({
  overrideConfig: {
    rules: {
      [RULE]: ['error', {
        variables: true, functions: false, typedefs: false,
        enums: false, classes: false, ignoreTypeReferences: true,
      }],
    },
  },
});

const results = await eslint.lintFiles(FILES);
const hits = [];
for (const r of results) {
  for (const m of r.messages) {
    if (m.ruleId === RULE) {
      hits.push(`${r.filePath.replace(process.cwd() + '/', '')}:${m.line}  ${m.message}`);
    }
  }
}

if (hits.length) {
  console.error(`\n❌ TDZ 检查未通过 —— ${hits.length} 处「先使用后声明」:\n`);
  for (const h of hits) console.error('   ' + h);
  console.error(
    '\n这类问题构建期不报错,但线上会白屏(Cannot access ... before initialization)。' +
    '\n把 useMemo/useEffect 移到它依赖的所有 useState **之后**即可。\n',
  );
  process.exit(1);
}
console.log(`✅ TDZ 检查通过(${FILES.length} 个核心表单文件,0 处先用后declare)`);
