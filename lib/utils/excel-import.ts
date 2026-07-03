'use client';

/**
 * Excel 批量导入的浏览器侧工具(供应商/物料主数据共用)。
 * 解析和模板生成都在浏览器完成(动态加载 xlsx,不进首屏 bundle);
 * 服务端只收结构化行数据 → 查重/校验/入库。
 */

/** 读上传的 .xlsx/.xls/.csv 第一个工作表 → 行对象数组(键=表头文本,全部转字符串)。 */
export async function parseExcelFile(file: File): Promise<Record<string, string>[]> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  // defval:'' 保证空单元格也有键;raw:false 统一拿显示文本(避免日期/数字系列化怪值)
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '', raw: false });
  return rows.map(r => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) out[String(k).trim()] = String(v ?? '').trim();
    return out;
  });
}

/** 生成并下载导入模板(表头 + 示例行)。 */
export async function downloadExcelTemplate(filename: string, headers: string[], exampleRows: string[][]) {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([headers, ...exampleRows]);
  ws['!cols'] = headers.map(h => ({ wch: Math.max(12, h.length * 2 + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '导入模板');
  XLSX.writeFile(wb, filename);
}

/** 按别名列表从行对象取值(容忍表头带 * / 空格 / 括号差异)。 */
export function pickCell(row: Record<string, string>, aliases: string[]): string {
  const norm = (s: string) => s.replace(/[*＊\s()（）]/g, '');
  for (const key of Object.keys(row)) {
    if (aliases.some(a => norm(key) === norm(a) || norm(key).startsWith(norm(a)))) {
      return row[key] || '';
    }
  }
  return '';
}

/** 导入结果的统一文案。 */
export function importResultText(res: { created?: number; skipped?: Array<{ row: number; name: string; reason: string }>; failed?: Array<{ row: number; name: string; reason: string }> }): string {
  const parts = [`✅ 导入成功 ${res.created || 0} 条`];
  if (res.skipped?.length) parts.push(`⏭ 跳过 ${res.skipped.length} 条(重复/缺必填)`);
  if (res.failed?.length) parts.push(`❌ 失败 ${res.failed.length} 条`);
  return parts.join(' · ');
}
