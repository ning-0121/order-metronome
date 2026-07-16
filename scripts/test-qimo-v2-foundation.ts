import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const qimoDir = join(root, 'components/qimo-v2');
  const files = (await readdir(qimoDir)).sort();
  assert(
    files.length === 3 &&
      files.includes('QimoDashboard.tsx') &&
      files.includes('icons.tsx') &&
      files.includes('index.ts'),
    `unexpected qimo-v2 file set: ${files.join(', ')}`,
  );

  const indexTs = await readFile(join(qimoDir, 'index.ts'), 'utf8');
  assert(indexTs.includes("export * from './QimoDashboard'"), 'index.ts must re-export QimoDashboard');
  assert(indexTs.includes("export * from './icons'"), 'index.ts must re-export icons');

  const dashboard = await readFile(join(qimoDir, 'QimoDashboard.tsx'), 'utf8');
  for (const symbol of ['QimoQuickEntryItem', 'QimoQuickEntryRow', 'QimoKpiGrid', 'QimoKpiCard', 'QimoCommandGrid', 'QimoCommandPanel', 'QimoAiToday', 'QimoApprovalCard', 'QimoRiskCard', 'QimoCollapsibleSection']) {
    assert(dashboard.includes(symbol), `QimoDashboard missing ${symbol}`);
  }

  const icons = await readFile(join(qimoDir, 'icons.tsx'), 'utf8');
  for (const symbol of ['ScheduleIcon', 'FactoryIcon', 'ProgressIcon', 'ShieldIcon', 'ChevronRightIcon']) {
    assert(icons.includes(`export function ${symbol}`), `icons.tsx missing ${symbol}`);
  }

  const globals = await readFile(join(root, 'app/globals.css'), 'utf8');
  assert(globals.includes('@import "../styles/qimo-v2-tokens.css";'), 'globals.css must import qimo-v2 tokens');

  const tokens = await readFile(join(root, 'styles/qimo-v2-tokens.css'), 'utf8');
  for (const token of ['--qimo-primary', '--qimo-primary-soft', '--qimo-focus', '--qimo-page', '--qimo-text']) {
    assert(tokens.includes(token), `tokens file missing ${token}`);
  }

  console.log('✅ QIMO V2 foundation checks passed');
}

main().catch((error) => {
  console.error('❌ QIMO V2 foundation checks failed');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
