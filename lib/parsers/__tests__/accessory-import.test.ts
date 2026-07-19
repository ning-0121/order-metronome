import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { matchAccessory, parseAccessoryWorkbook } from '../accessory-import';

async function fixture() {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('TEST NOT REAL PROCUREMENT');
  ws.addRow(['辅料编码','辅料名称','规格','颜色','使用部位','单位','单耗','用量基准','数量','图片','画稿','备注','特殊要求']);
  ws.addRow(['TRM-001','测试拉链','20cm','黑色','前中','条',1,'PER_SET',100,'https://img.example/a.png','https://doc.example/a.pdf','门襟用',''])
  ws.addRow(['','测试吊牌','5x8cm','','','个','','PER_SET',100,'https://img.example/b.png','','','防水']);
  return wb.xlsx.writeBuffer();
}

test('parses and normalizes accessory XLSX rows', async () => {
  const p = await parseAccessoryWorkbook(await fixture() as ArrayBuffer);
  assert.equal(p.rows.length, 2); assert.equal(p.rows[0].normalized.unit_consumption, 1);
  assert.deepEqual(p.rows[1].missingFields, ['usage_position','unit_consumption']);
});

test('exact code wins, composite exact match is supported, fuzzy is not auto matched', () => {
  const bom = [{ id:'a', material_code:'TRM-001', material_name:'测试拉链', spec:'20cm', color:'黑色', placement:'前中' }];
  assert.equal(matchAccessory({ accessory_code:'trm-001', accessory_name:'别名', specification:null,color:null,usage_position:null,unit:'条',unit_consumption:1,consumption_basis:'PER_SET',quantity:1, notes:null, special_requirements:null, sample_reference:null, position_description:null, image_urls:[], attachment_files:[] }, bom)?.id, 'a');
  assert.equal(matchAccessory({ accessory_code:null, accessory_name:'测试拉链', specification:'20cm',color:'黑色',usage_position:'前中',unit:'条',unit_consumption:1,consumption_basis:'PER_SET',quantity:1, notes:null, special_requirements:null, sample_reference:null, position_description:null, image_urls:[], attachment_files:[] }, bom)?.id, 'a');
  assert.equal(matchAccessory({ accessory_code:null, accessory_name:'测试拉练', specification:'20cm',color:'黑色',usage_position:'前中',unit:'条',unit_consumption:1,consumption_basis:'PER_SET',quantity:1, notes:null, special_requirements:null, sample_reference:null, position_description:null, image_urls:[], attachment_files:[] }, bom), null);
});

test('code match with differences surfaces diff fields for review', () => {
  const bom = [{ id:'a', material_code:'TRM-001', material_name:'测试拉链', spec:'20cm', color:'黑色', placement:'前中', unit:'个', qty_per_piece: 1 }];
  const hit = matchAccessory({ accessory_code:'TRM-001', accessory_name:'测试拉链', specification:'22cm',color:'黑色',usage_position:'前中',unit:'条',unit_consumption:2,consumption_basis:'PER_SET',quantity:1, notes:null, special_requirements:null, sample_reference:null, position_description:null, image_urls:[], attachment_files:[] }, bom);
  assert.equal(hit?.id, 'a');
  assert.ok((hit?.fieldDiffs || []).includes('specification'));
  assert.ok((hit?.fieldDiffs || []).includes('unit'));
});

test('parses extended optional fields for procurement imports', async () => {
  const p = await parseAccessoryWorkbook(await fixture() as ArrayBuffer);
  assert.equal(p.rows[0].normalized.image_urls[0], 'https://img.example/a.png');
  assert.equal(p.rows[0].normalized.attachment_files[0], 'https://doc.example/a.pdf');
  assert.equal(p.rows[1].normalized.special_requirements, '防水');
});
