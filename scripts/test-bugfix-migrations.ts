import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), 'supabase/migrations', name), 'utf8');
const size = read('20260715_size_chart_import_status.sql');
const accessory = read('20260715_accessory_workflow_fields.sql');

for (const [name, sql] of [['size chart', size], ['accessory', accessory]] as const) {
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN)\b/i, `${name}: destructive DROP`);
  assert.doesNotMatch(sql, /\bTRUNCATE\b|\bDELETE\s+FROM\b/i, `${name}: data mutation`);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i, `${name}: RLS missing`);
  assert.match(sql, /user_can_access_order\(auth\.uid\(\), order_id\)/, `${name}: order scope missing`);
  assert.match(sql, /created_at timestamptz NOT NULL DEFAULT now\(\)/i);
  assert.match(sql, /updated_at timestamptz NOT NULL DEFAULT now\(\)/i);
}

for (const status of ['UPLOADED','PARSING','PARSED','NEEDS_REVIEW','APPROVED','FAILED','DUPLICATE']) {
  assert.match(size, new RegExp(`'${status}'`));
}
for (const field of ['source_filename','checksum_sha256','parser_version','worksheet_name','parsed_row_count','error_code','safe_error_message','parsed_json','reviewed_by','reviewed_at']) {
  assert.match(size, new RegExp(`\\b${field}\\b`));
}

assert.match(accessory, /ADD COLUMN IF NOT EXISTS consumption_basis text NULL/i);
assert.doesNotMatch(accessory, /consumption_basis text NOT NULL DEFAULT/i, 'must not reinterpret legacy rows');
assert.doesNotMatch(accessory, /ADD COLUMN[^;]*(supplier_quote|factory_quote|purchase_price)/i, 'financial truth must not be duplicated onto BOM');
for (const status of ['SOURCE_IMPORTED','MATCHED_TO_EXISTING','NEW_ACCESSORY','NEEDS_REVIEW','APPROVED','EXCLUDED']) {
  assert.match(accessory, new RegExp(`'${status}'`));
}
assert.match(accessory, /APPROVED'[\s\S]*approved_value IS NOT NULL/);

console.log('✅ Bugfix migration static safety assertions passed');
