import ExcelJS from 'exceljs';

export interface ParsedSizeChart {
  sheetName: string;
  sizes: string[];
  rows: Array<{ measurement: string; values: Record<string, string | number | null> }>;
}

const cellText = (value: ExcelJS.CellValue): string => {
  if (value == null) return '';
  if (typeof value === 'object' && 'result' in value) return String(value.result ?? '').trim();
  if (typeof value === 'object' && 'text' in value) return String(value.text ?? '').trim();
  return String(value).trim();
};

export async function parseSizeChartWorkbook(bytes: ArrayBuffer): Promise<ParsedSizeChart> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  for (const sheet of workbook.worksheets) {
    const limit = Math.min(sheet.rowCount, 40);
    for (let rowNo = 1; rowNo <= limit; rowNo++) {
      const row = sheet.getRow(rowNo);
      const values: string[] = [];
      for (let col = 1; col <= Math.min(sheet.columnCount, 30); col++) values.push(cellText(row.getCell(col).value));
      const first = values.findIndex(v => /^(部位|测量部位|measurement|规格|尺寸项目)$/i.test(v));
      if (first < 0) continue;
      const sizes = values.slice(first + 1).filter(v => /^(XXS|XS|S|M|L|XL|XXL|XXXL|\d{2,3})$/i.test(v));
      if (!sizes.length) continue;
      const parsedRows: ParsedSizeChart['rows'] = [];
      for (let dataRow = rowNo + 1; dataRow <= sheet.rowCount; dataRow++) {
        const measurement = cellText(sheet.getRow(dataRow).getCell(first + 1).value);
        if (!measurement) continue;
        const result: Record<string, string | number | null> = {};
        sizes.forEach((size, index) => {
          const raw = sheet.getRow(dataRow).getCell(first + 2 + index).value;
          const text = cellText(raw);
          result[size] = text === '' ? null : Number.isFinite(Number(text)) ? Number(text) : text;
        });
        parsedRows.push({ measurement, values: result });
      }
      if (parsedRows.length) return { sheetName: sheet.name, sizes, rows: parsedRows };
    }
  }
  throw new Error('未找到“部位/测量部位”表头及尺码列（如 S、M、L）');
}
