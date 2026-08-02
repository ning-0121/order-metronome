#!/usr/bin/env node
/**
 * 「找不到标识符」硬闸(2026-08-01 事故后加)。
 *
 * 事故:批量把 'QIMO OS' 换成 BRAND.productName 时,脚本用「文件里是否出现过
 * lib/config/brand 这个字符串」来判断要不要补 import。app/login/page.tsx 上一轮
 * 已经 import 了 EMAIL_DOMAIN_SUFFIX,于是被误判为"已导入"、没补 BRAND ——
 * 结果整个登录页白屏 `ReferenceError: BRAND is not defined`。
 *
 * 为什么 npm run build 拦不住:next.config.ts 里 typescript.ignoreBuildErrors = true
 * (仓库有 ~194 个存量 TS 错,见 docs/sprint-0-ts-debt.md)。也就是说**类型错误从来
 * 不阻断构建**,这类"TS 一眼就能看出来"的错会一路推到生产。
 *
 * 清 194 个存量不是一天的事,但没必要因此放弃全部类型防线。这里只挑**必炸**的两类:
 *   TS2304  Cannot find name 'X'                     ← 今天这个
 *   TS2552  Cannot find name 'X'. Did you mean 'Y'?  ← 拼错的同类
 * 这两类在非测试源码里当前是 0,所以可以直接设成"一个都不许有",
 * 不用背存量债、也不会误挡别的告警。
 *
 * 测试文件排除:lib/agent/__tests__/ 里有 8 个 `Cannot find name 'expect'`
 * (vitest globals 没进 tsconfig),那是配置问题不是运行时炸点,单独治。
 */
import { execFileSync } from 'node:child_process';

const FATAL = /error (TS2304|TS2552):/;
const IS_TEST = /(^|\/)(__tests__|tests)\/|\.test\.tsx?$|\.spec\.tsx?$/;
const SOURCE = /^(app|lib|components)\//;

let out = '';
try {
  out = execFileSync('npx', ['tsc', '--noEmit'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  // tsc 有错时退出码非 0,诊断在 stdout
  out = `${e.stdout || ''}${e.stderr || ''}`;
}

const hits = out
  .split('\n')
  .filter((l) => FATAL.test(l))
  .filter((l) => SOURCE.test(l) && !IS_TEST.test(l));

if (hits.length) {
  console.error(`\n❌ 找不到标识符 —— ${hits.length} 处:\n`);
  for (const h of hits) console.error('   ' + h.trim());
  console.error(
    '\n这类错构建期不报错(ignoreBuildErrors=true),但线上会白屏' +
    '(ReferenceError: X is not defined)。\n最常见原因:用了某个符号却忘了 import,' +
    '或批量改名时只改了用处没改导入。\n',
  );
  process.exit(1);
}
console.log('✅ 标识符检查通过(app/lib/components 无 TS2304/TS2552)');
