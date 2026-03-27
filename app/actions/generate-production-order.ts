'use server';

import type { POParsedData, POStyleData } from './po-parser';

export async function generateProductionOrder(data: POParsedData): Promise<{ ok: boolean; base64?: string; fileName?: string; error?: string }> {
  try {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.default.Workbook();

    const FONT_NAME = 'Arial';
    const HEADER_FONT = { name: FONT_NAME, size: 11, bold: true };
    const CELL_FONT = { name: FONT_NAME, size: 10 };
    const TITLE_FONT = { name: FONT_NAME, size: 14, bold: true };

    const thinBorder: Partial<ExcelJS.Borders> = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    };

    const sizeLabels = data.size_labels?.length > 0 ? data.size_labels : ['S', 'M', 'L'];

    // Generate one sheet per style
    for (const style of data.styles) {
      const sheetName = `${style.style_no}-${style.product_name}`.substring(0, 31);
      const sheet = workbook.addWorksheet(sheetName);

      // Column widths
      sheet.columns = [
        { width: 14 }, // A: 款号
        { width: 10 }, // B: 主布颜色
        { width: 8 },  // C: 箱数
        { width: 12 }, // D: 数量
        ...sizeLabels.map(() => ({ width: 8 })), // E,F,G...: sizes
        { width: 40 }, // 客户包装
        { width: 12 }, // 颜色备注
      ];

      const sizeStartCol = 5; // column E
      const packagingCol = sizeStartCol + sizeLabels.length;
      const colorNoteCol = packagingCol + 1;

      let row = 1;

      // Row 1: Company name
      sheet.getCell(row, 1).value = '绮陌服饰';
      sheet.getCell(row, 1).font = TITLE_FONT;
      sheet.mergeCells(row, 1, row, 4);
      row++;

      // Row 2: Order no + Order date
      sheet.getCell(row, 1).value = '订单号';
      sheet.getCell(row, 1).font = HEADER_FONT;
      sheet.getCell(row, 4).value = data.order_no;
      sheet.getCell(row, 4).font = CELL_FONT;
      sheet.getCell(row, packagingCol - 1).value = '下单日期';
      sheet.getCell(row, packagingCol - 1).font = HEADER_FONT;
      sheet.getCell(row, packagingCol).value = data.order_date;
      sheet.getCell(row, packagingCol).font = CELL_FONT;
      row++;

      // Row 3: Product name + Material
      sheet.getCell(row, 1).value = '品名';
      sheet.getCell(row, 1).font = HEADER_FONT;
      sheet.getCell(row, 4).value = style.product_name;
      sheet.getCell(row, 4).font = CELL_FONT;
      sheet.getCell(row, packagingCol - 1).value = '原料';
      sheet.getCell(row, packagingCol - 1).font = HEADER_FONT;
      sheet.getCell(row, packagingCol).value = style.material;
      sheet.getCell(row, packagingCol).font = CELL_FONT;
      row++;

      // Row 4: Delivery date + Fabric weight
      sheet.getCell(row, 1).value = '交期';
      sheet.getCell(row, 1).font = HEADER_FONT;
      sheet.getCell(row, 4).value = data.delivery_date;
      sheet.getCell(row, 4).font = CELL_FONT;
      sheet.getCell(row, packagingCol - 1).value = '面料克重';
      sheet.getCell(row, packagingCol - 1).font = HEADER_FONT;
      sheet.getCell(row, packagingCol).value = style.fabric_weight;
      sheet.getCell(row, packagingCol).font = CELL_FONT;
      row++;

      // Row 5: Total qty
      sheet.getCell(row, 1).value = '数量';
      sheet.getCell(row, 1).font = HEADER_FONT;
      sheet.getCell(row, 4).value = style.total_qty;
      sheet.getCell(row, 4).font = CELL_FONT;
      row++;

      // Row 6: Table header
      const headers = ['款号', '主布颜色', '箱数', '数量', ...sizeLabels, '客户包装', '颜色备注'];
      headers.forEach((h, i) => {
        const cell = sheet.getCell(row, i + 1);
        cell.value = h;
        cell.font = HEADER_FONT;
        cell.border = thinBorder;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
      });
      row++;

      // Data rows
      const dataStartRow = row;
      style.colors.forEach((color, ci) => {
        sheet.getCell(row, 1).value = ci === 0 ? style.style_no : '';
        sheet.getCell(row, 1).font = CELL_FONT;
        sheet.getCell(row, 2).value = color.color_cn;
        sheet.getCell(row, 2).font = CELL_FONT;
        // boxes = ceil(qty / 30) as rough estimate
        const boxes = Math.ceil(color.qty / 30);
        sheet.getCell(row, 3).value = boxes;
        sheet.getCell(row, 3).font = CELL_FONT;
        sheet.getCell(row, 4).value = color.qty;
        sheet.getCell(row, 4).font = CELL_FONT;

        sizeLabels.forEach((sz, si) => {
          sheet.getCell(row, sizeStartCol + si).value = color.sizes[sz] || 0;
          sheet.getCell(row, sizeStartCol + si).font = CELL_FONT;
        });

        sheet.getCell(row, packagingCol).value = ci === 0 ? style.packaging : '';
        sheet.getCell(row, packagingCol).font = CELL_FONT;
        sheet.getCell(row, colorNoteCol).value = color.color_en;
        sheet.getCell(row, colorNoteCol).font = CELL_FONT;

        // Borders for data row
        for (let c = 1; c <= headers.length; c++) {
          sheet.getCell(row, c).border = thinBorder;
          sheet.getCell(row, c).alignment = { horizontal: 'center', vertical: 'middle' };
        }
        row++;
      });

      // Total row
      sheet.getCell(row, 1).value = '总计';
      sheet.getCell(row, 1).font = HEADER_FONT;
      sheet.getCell(row, 4).value = style.total_qty;
      sheet.getCell(row, 4).font = HEADER_FONT;
      // Sum formula for boxes
      const boxCol = 'C';
      sheet.getCell(row, 3).value = { formula: `SUM(${boxCol}${dataStartRow}:${boxCol}${row - 1})` };
      sheet.getCell(row, 3).font = HEADER_FONT;
      for (let c = 1; c <= headers.length; c++) {
        sheet.getCell(row, c).border = thinBorder;
        sheet.getCell(row, c).alignment = { horizontal: 'center', vertical: 'middle' };
      }
      row += 2;

      // Sample requirements section
      sheet.getCell(row, 2).value = '交样时间';
      sheet.getCell(row, 2).font = HEADER_FONT;
      sheet.getCell(row, 4).value = '要求';
      sheet.getCell(row, 4).font = HEADER_FONT;
      row++;

      sheet.getCell(row, 1).value = '产前样';
      sheet.getCell(row, 1).font = HEADER_FONT;
      row++;

      sheet.getCell(row, 1).value = '船样';
      sheet.getCell(row, 1).font = HEADER_FONT;
      sheet.getCell(row, 4).value = style.sample_requirements || '';
      sheet.getCell(row, 4).font = CELL_FONT;
      row++;

      // Quality notes
      sheet.getCell(row, 1).value = '款式评语';
      sheet.getCell(row, 1).font = HEADER_FONT;
      row++;

      if (style.quality_notes) {
        sheet.getCell(row, 1).value = style.quality_notes;
        sheet.getCell(row, 1).font = CELL_FONT;
        sheet.getCell(row, 1).alignment = { wrapText: true, vertical: 'top' };
        sheet.mergeCells(row, 1, row, headers.length);
        sheet.getRow(row).height = 80;
      }
      row += 2;

      sheet.getCell(row, 1).value = '包装明细及要求详见附页';
      sheet.getCell(row, 1).font = CELL_FONT;
      row++;

      sheet.getCell(row, 1).value = '签收人：';
      sheet.getCell(row, 1).font = CELL_FONT;
      sheet.getCell(row, packagingCol - 1).value = '签收时间：';
      sheet.getCell(row, packagingCol - 1).font = CELL_FONT;
    }

    // Trims sheet
    if (data.trims && data.trims.length > 0) {
      const trimsSheet = workbook.addWorksheet('辅料明细');
      trimsSheet.columns = [
        { width: 14 },
        { width: 20 },
        { width: 20 },
        { width: 40 },
        { width: 20 },
        { width: 12 },
        { width: 12 },
      ];

      trimsSheet.getCell(1, 1).value = `${data.order_no}辅料明细`;
      trimsSheet.getCell(1, 1).font = TITLE_FONT;

      const trimsHeaders = ['辅料', '示例画稿（以实际为准）', '位置说明及示意图', '位置说明', '备注', '工厂价格', '采购价格'];
      trimsHeaders.forEach((h, i) => {
        const cell = trimsSheet.getCell(2, i + 1);
        cell.value = h;
        cell.font = HEADER_FONT;
        cell.border = thinBorder;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
      });

      data.trims.forEach((trim, i) => {
        const r = 3 + i;
        trimsSheet.getCell(r, 1).value = trim.name;
        trimsSheet.getCell(r, 1).font = CELL_FONT;
        trimsSheet.getCell(r, 4).value = trim.position;
        trimsSheet.getCell(r, 4).font = CELL_FONT;
        trimsSheet.getCell(r, 5).value = trim.notes;
        trimsSheet.getCell(r, 5).font = CELL_FONT;
        for (let c = 1; c <= 7; c++) {
          trimsSheet.getCell(r, c).border = thinBorder;
        }
      });
    }

    // Generate buffer
    const xlsxBuffer = await workbook.xlsx.writeBuffer();
    const base64 = Buffer.from(xlsxBuffer).toString('base64');
    const fileName = `${data.order_no}_生产单_${new Date().toISOString().slice(0, 10)}.xlsx`;

    return { ok: true, base64, fileName };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[generateProductionOrder] Error:', message);
    return { ok: false, error: `生成失败：${message}` };
  }
}
