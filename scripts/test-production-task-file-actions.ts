import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectBudgetUnitPriceMismatches } from '../lib/domain/budget-unit-price';
import { base64ToBlob, triggerBlobDownload } from '../lib/browser/download';
import { loadProductionTaskTemplate, safeProductionTaskFilename } from '../lib/exports/production-task-template';
import { PRODUCTION_TASK_SHEETS } from '../lib/exports/production-task-template-map';

type MockAnchor = {
  href: string;
  download: string;
  rel: string;
  style: { display: string };
  click(): void;
  remove(): void;
};

type MockDocument = {
  body: { appendChild(node: MockAnchor): void };
  createElement(tag: 'a'): MockAnchor;
};

type MockURL = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
};

async function main() {
  const template = await loadProductionTaskTemplate();
  assert.deepEqual(template.worksheets.map((sheet) => sheet.name), [PRODUCTION_TASK_SHEETS.main, PRODUCTION_TASK_SHEETS.size]);

  assert.equal(safeProductionTaskFilename('QM/1001', 'A:*?'), 'QM_1001_生产任务单_A___.xlsx');
  const blob = base64ToBlob(Buffer.from('QIMO').toString('base64'));
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  const calls: string[] = [];
  const removed: string[] = [];
  const oldDocument = globalThis.document;
  const oldURL = globalThis.URL;
  const oldSetTimeout = globalThis.setTimeout;
  try {
    const anchor: MockAnchor = {
      href: '',
      download: '',
      rel: '',
      style: { display: '' },
      click() { calls.push('click'); },
      remove() { removed.push('remove'); },
    };
    const mockDocument: MockDocument = {
      body: {
        appendChild(node: MockAnchor) {
          calls.push(`append:${node.download}`);
        },
      },
      createElement(tag: 'a') {
        assert.equal(tag, 'a');
        return anchor;
      },
    };
    const mockURL: MockURL = {
      createObjectURL() { calls.push('create'); return 'blob:preview'; },
      revokeObjectURL(url: string) { calls.push(`revoke:${url}`); },
    };
    (globalThis as unknown as { document: MockDocument }).document = mockDocument;
    (globalThis as unknown as { URL: MockURL }).URL = mockURL;
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: TimerHandler) => { fn(); return 1; }) as typeof setTimeout;
    const url = triggerBlobDownload(blob, '生产任务单.xlsx', 0);
    assert.equal(url, 'blob:preview');
    assert.deepEqual(calls, ['create', 'append:生产任务单.xlsx', 'click', 'revoke:blob:preview']);
    assert.deepEqual(removed, ['remove']);
  } finally {
    (globalThis as unknown as { document: typeof oldDocument }).document = oldDocument;
    (globalThis as unknown as { URL: typeof oldURL }).URL = oldURL;
    (globalThis as unknown as { setTimeout: typeof oldSetTimeout }).setTimeout = oldSetTimeout;
  }

  assert.deepEqual(collectBudgetUnitPriceMismatches(
    [{ id: 'bom-1', budget_unit_price: 12.5 }, { id: 'bom-2', budget_unit_price: null }],
    { 'bom-1': 12.5, 'bom-2': null, 'bom-3': 3 },
  ), [{ id: 'bom-3', expected: '3', actual: '' }]);

  const moButton = readFileSync('app/procurement/verify/[orderId]/MoDownloadButton.tsx', 'utf8');
  assert.match(moButton, /import \{ base64ToBlob, triggerBlobDownload \} from '@\/lib\/browser\/download'/);
  assert.match(moButton, /type="button"/);
  assert.match(moButton, /aria-busy=\{busy\}/);
  assert.match(moButton, /生成失败，请重试/);

  const bulk = readFileSync('components/BulkConsumptionEditor.tsx', 'utf8');
  assert.match(bulk, /const \[techMsg, setTechMsg\] = useState\(''\);/);
  assert.match(bulk, /setTechMsg\(`❌ \$\{\(r as any\)\.error\}`\)/);
  assert.doesNotMatch(bulk, /alert\(/);

  const budget = readFileSync('components/tabs/BomBudgetEntry.tsx', 'utf8');
  assert.match(budget, /collectBudgetUnitPriceMismatches/);
  assert.match(budget, /预算已提交，但有 \$\{mismatches\.length\} 行回显不一致/);

  const procurement = readFileSync('components/tabs/ProcurementItemsTab.tsx', 'utf8');
  assert.match(procurement, /collectBudgetUnitPriceMismatches/);
  assert.match(procurement, /已提交预算单价，但有 \$\{mismatches\.length\} 行回显不一致/);

  console.log('production task file actions: 12 assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
