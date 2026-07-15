import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const scanRoots = ['app', 'lib'];
const providerDirectory = 'lib/ai/runtime/providers/';
const runtimeTestsDirectory = 'lib/ai/runtime/__tests__/';

// Audited 2026-07-15. This is migration debt, not permission for new call sites.
const legacyAllowlist = new Set([
  'app/actions/agent-chat.ts', 'app/actions/ai-knowledge.ts', 'app/actions/analytics.ts',
  'app/actions/documents.ts', 'app/actions/photo-parser.ts', 'app/actions/po-extract.ts',
  'app/actions/po-verify.ts', 'app/actions/smart-insights.ts', 'app/api/agent-chat/route.ts',
  'app/api/cron/agent-learn/route.ts', 'lib/agent/anthropicClient.ts',
  'lib/agent/complianceCheck.ts', 'lib/agent/customerEmailMapping.ts', 'lib/agent/dailyBriefing.ts',
  'lib/agent/emailDraft.ts', 'lib/agent/emailLearning.ts', 'lib/agent/emailMatcher.ts',
  'lib/agent/emailOrderCompare.ts', 'lib/agent/orderCommunicationLog.ts',
]);

const forbidden = [
  { name: 'Anthropic SDK import', pattern: /@anthropic-ai\/sdk/ },
  { name: 'OpenAI SDK import', pattern: /(?:from\s+['"]openai['"]|import\(['"]openai['"]\)|require\(['"]openai['"]\))/ },
  { name: 'Anthropic HTTP endpoint', pattern: /api\.anthropic\.com/ },
  { name: 'OpenAI HTTP endpoint', pattern: /api\.openai\.com/ },
  { name: 'Provider secret access', pattern: /process\.env\.(?:OPENAI_API_KEY|ANTHROPIC_API_KEY)/ },
];

async function filesBelow(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.claude') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(path));
    else if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(entry.name))) output.push(path);
  }
  return output;
}

async function main() {
  const violations: string[] = [];
  for (const directory of scanRoots) {
    for (const absolute of await filesBelow(join(root, directory))) {
      const path = relative(root, absolute).replaceAll('\\', '/');
      if (path.startsWith(providerDirectory) || path.startsWith(runtimeTestsDirectory)) continue;
      const source = await readFile(absolute, 'utf8');
      for (const rule of forbidden) {
        if (rule.pattern.test(source) && !legacyAllowlist.has(path)) violations.push(`${path}: ${rule.name}`);
      }
    }
  }

  if (violations.length) {
    console.error('AI Provider boundary violations:\n' + violations.map(item => `- ${item}`).join('\n'));
    process.exitCode = 1;
    return;
  }

  console.log(`AI Provider boundary check passed; ${legacyAllowlist.size} audited legacy bypasses remain.`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
