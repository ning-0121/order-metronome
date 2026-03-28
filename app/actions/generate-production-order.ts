'use server';

import type { POParsedData, POStyleData, GarmentCategory } from './po-parser';
import { MEASUREMENT_TEMPLATES } from '@/lib/domain/measurement-templates';

// ── 配色常量（对齐用户模板） ──
const COLORS = {
  YELLOW_BG: 'FFFFFF00',       // 黄色背景（标签、总计、高亮）
  GREEN_HEADER: 'FF006400',    // 深绿表头
  WHITE: 'FFFFFFFF',
  LIGHT_GRAY: 'FFF5F5F5',     // 浅灰交替行
  NAVY_TEXT: 'FF000080',       // 深蓝文字
  RED_TEXT: 'FFCC0000',        // 红色（总计数字）
  BLACK_TEXT: 'FF000000',
  WHITE_TEXT: 'FFFFFFFF',
};

export async function generateProductionOrder(data: POParsedData): Promise<{ ok: boolean; base64?: string; fileName?: string; error?: string }> {
  try {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.default.Workbook();

    const FONT_NAME = 'Arial';
    const thinBorder: Partial<ExcelJS.Borders> = {
      top: { style: 'thin' }, left: { style: 'thin' },
      bottom: { style: 'thin' }, right: { style: 'thin' },
    };

    const sizeLabels = data.size_labels?.length > 0 ? data.size_labels : ['S', 'M', 'L'];

    // ===== 每个款式生成主表 + 尺寸表 =====
    for (const style of data.styles) {

      // ────── 主表（生产单） ──────
      const sheetName = `${style.style_no}`.substring(0, 31);
      const sheet = workbook.addWorksheet(sheetName);

      const sizeStartCol = 5;
      const packagingCol = sizeStartCol + sizeLabels.length;
      const colorNoteCol = packagingCol + 1;
      const totalCols = colorNoteCol;

      sheet.columns = [
        { width: 14 }, // A: 款号
        { width: 14 }, // B: 大身颜色
        { width: 14 }, // C: 款式描述
        { width: 8 },  // D: 箱数
        ...sizeLabels.map(() => ({ width: 8 })), // sizes
        { width: 8 },  // 数量
        { width: 10 }, // 图片（预留）
      ];

      // 辅助函数
      const setLabel = (r: number, c: number, text: string) => {
        const cell = sheet.getCell(r, c);
        cell.value = text;
        cell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.NAVY_TEXT } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.YELLOW_BG } };
        cell.border = thinBorder;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      };

      const setValue = (r: number, c: number, text: string | number, bold = false) => {
        const cell = sheet.getCell(r, c);
        cell.value = text;
        cell.font = { name: FONT_NAME, size: 10, bold, color: { argb: COLORS.NAVY_TEXT } };
        cell.border = thinBorder;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      };

      let row = 1;

      // Row 1: 空行（顶部装饰区，可放公司logo）
      sheet.getRow(row).height = 30;
      row++;

      // Row 2: 订单号
      setLabel(row, 1, '订单号');
      sheet.mergeCells(row, 1, row, 2);
      setValue(row, 3, data.order_no, true);
      sheet.mergeCells(row, 3, row, packagingCol);
      row++;

      // Row 3: 品名
      setLabel(row, 1, '品名');
      sheet.mergeCells(row, 1, row, 2);
      setValue(row, 3, style.product_name, true);
      sheet.mergeCells(row, 3, row, packagingCol - 2);
      setValue(row, packagingCol - 1, style.material);
      sheet.mergeCells(row, packagingCol - 1, row, packagingCol);
      row++;

      // Row 4: 交期
      setLabel(row, 1, '交期');
      sheet.mergeCells(row, 1, row, 2);
      const deliveryCell = sheet.getCell(row, 3);
      deliveryCell.value = `${data.delivery_date}（客户装柜日，不得延期）`;
      deliveryCell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.NAVY_TEXT } };
      deliveryCell.border = thinBorder;
      deliveryCell.alignment = { vertical: 'middle' };
      sheet.mergeCells(row, 3, row, packagingCol - 2);
      setValue(row, packagingCol - 1, style.fabric_weight || '');
      sheet.mergeCells(row, packagingCol - 1, row, packagingCol);
      row++;

      // Row 5: 数量
      setLabel(row, 1, '数量');
      sheet.mergeCells(row, 1, row, 2);
      setValue(row, 3, style.total_qty, true);
      sheet.mergeCells(row, 3, row, packagingCol);
      row++;

      // Row 6: 表格表头（深绿背景白字）
      const headers = ['款号', '大身颜色', '款式描述', '箱数', ...sizeLabels.map(() => ''), '数量', '图片'];
      // 先写固定标签
      const headerLabels = ['款号', '大身颜色', '款式描述', '箱数'];
      headerLabels.forEach((h, i) => {
        const cell = sheet.getCell(row, i + 1);
        cell.value = h;
        cell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.WHITE_TEXT } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.GREEN_HEADER } };
        cell.border = thinBorder;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
      // 数量列头
      const qtyHeaderCol = sizeStartCol + sizeLabels.length;
      const qtyCell = sheet.getCell(row, qtyHeaderCol);
      qtyCell.value = '数量';
      qtyCell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.WHITE_TEXT } };
      qtyCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.GREEN_HEADER } };
      qtyCell.border = thinBorder;
      qtyCell.alignment = { horizontal: 'center', vertical: 'middle' };
      // 尺码列头
      sizeLabels.forEach((sz, si) => {
        const cell = sheet.getCell(row, sizeStartCol + si);
        cell.value = sz;
        cell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.WHITE_TEXT } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.GREEN_HEADER } };
        cell.border = thinBorder;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
      // 图片列头
      const imgCell = sheet.getCell(row, qtyHeaderCol + 1);
      imgCell.value = '图片';
      imgCell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.WHITE_TEXT } };
      imgCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.GREEN_HEADER } };
      imgCell.border = thinBorder;
      imgCell.alignment = { horizontal: 'center', vertical: 'middle' };
      row++;

      // Data rows
      const dataStartRow = row;
      style.colors.forEach((color, ci) => {
        setValue(row, 1, ci === 0 ? style.style_no : '');
        setValue(row, 2, `${color.color_en || ''} ${color.color_cn}`.trim());
        setValue(row, 3, ci === 0 ? style.product_name : '');
        const boxes = Math.ceil(color.qty / 48);
        setValue(row, 4, boxes);

        sizeLabels.forEach((sz, si) => {
          setValue(row, sizeStartCol + si, color.sizes[sz] || 0);
        });

        setValue(row, qtyHeaderCol, color.qty);
        // 图片列空
        sheet.getCell(row, qtyHeaderCol + 1).border = thinBorder;

        row++;
      });

      // Total row（黄底红字）
      const totalRow = row;
      setLabel(totalRow, 1, '总计');
      sheet.mergeCells(totalRow, 1, totalRow, 3);
      for (let c = 4; c <= qtyHeaderCol + 1; c++) {
        sheet.getCell(totalRow, c).border = thinBorder;
        sheet.getCell(totalRow, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.YELLOW_BG } };
      }
      const totalQtyCell = sheet.getCell(totalRow, qtyHeaderCol);
      totalQtyCell.value = style.total_qty;
      totalQtyCell.font = { name: FONT_NAME, size: 11, bold: true, color: { argb: COLORS.RED_TEXT } };
      totalQtyCell.alignment = { horizontal: 'center', vertical: 'middle' };
      row += 2;

      // 面料信息高亮行（黄底）
      if (style.fabric_weight || style.material) {
        const fabricInfo = `${style.fabric_weight || ''} 单耗：待填`.trim();
        const fabricCell = sheet.getCell(row, 1);
        fabricCell.value = fabricInfo;
        fabricCell.font = { name: FONT_NAME, size: 10, bold: true };
        fabricCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.YELLOW_BG } };
        sheet.mergeCells(row, 1, row, qtyHeaderCol + 1);
        row += 2;
      }

      // 产前样 / 船样要求
      setLabel(row, 1, '');
      setValue(row, 2, '交样时间');
      sheet.getCell(row, 2).font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.NAVY_TEXT } };
      setValue(row, qtyHeaderCol - 1, '要求');
      sheet.getCell(row, qtyHeaderCol - 1).font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.NAVY_TEXT } };
      row++;

      setValue(row, 1, '产前样');
      sheet.getCell(row, 1).font = { name: FONT_NAME, size: 10, bold: true };
      row++;

      setValue(row, 1, '船样');
      sheet.getCell(row, 1).font = { name: FONT_NAME, size: 10, bold: true };
      if (style.sample_requirements) {
        setValue(row, qtyHeaderCol - 1, style.sample_requirements);
      }
      row += 2;

      // 款式评语
      setLabel(row, 1, '款式评语');
      sheet.mergeCells(row, 1, row, qtyHeaderCol + 1);
      row++;

      if (style.quality_notes) {
        const notesCell = sheet.getCell(row, 1);
        notesCell.value = style.quality_notes;
        notesCell.font = { name: FONT_NAME, size: 10, color: { argb: COLORS.NAVY_TEXT } };
        notesCell.alignment = { wrapText: true, vertical: 'top' };
        sheet.mergeCells(row, 1, row, qtyHeaderCol + 1);
        sheet.getRow(row).height = 100;
      }
      row += 2;

      // 包装明细提示
      const packNote = sheet.getCell(row, 1);
      packNote.value = '包装明细及要求详见附页';
      packNote.font = { name: FONT_NAME, size: 10 };

      // ────── 尺寸表 Sheet ──────
      const sizeSheetName = `${style.style_no}尺寸表`.substring(0, 31);
      const sizeSheet = workbook.addWorksheet(sizeSheetName);

      // 确定测量项
      const category = data.garment_category || 'other';
      const templateMeasurements = MEASUREMENT_TEMPLATES[category] || [];
      const measurements = style.measurements && style.measurements.length > 0
        ? style.measurements
        : templateMeasurements.map(label => ({ label, values: {} }));

      // 列宽
      sizeSheet.columns = [
        { width: 22 }, // A: 部位
        ...sizeLabels.map(() => ({ width: 12 })),
      ];

      // Row 1: 标题
      let sRow = 1;
      const titleCell = sizeSheet.getCell(sRow, 1);
      titleCell.value = `${style.style_no}尺寸工艺平量要求（inch）`;
      titleCell.font = { name: FONT_NAME, size: 12, bold: true };
      sizeSheet.mergeCells(sRow, 1, sRow, 1 + sizeLabels.length);
      sRow++;

      // Row 2: 表头（深绿背景白字）
      const sizeHeaders = ['部位', ...sizeLabels];
      sizeHeaders.forEach((h, i) => {
        const cell = sizeSheet.getCell(sRow, i + 1);
        cell.value = h;
        cell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.WHITE_TEXT } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.GREEN_HEADER } };
        cell.border = thinBorder;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
      sRow++;

      // 数据行（交替浅灰底）
      measurements.forEach((m, mi) => {
        const isAlt = mi % 2 === 1;
        const labelCell = sizeSheet.getCell(sRow, 1);
        labelCell.value = m.label;
        labelCell.font = { name: FONT_NAME, size: 10 };
        labelCell.border = thinBorder;
        labelCell.alignment = { vertical: 'middle' };
        if (isAlt) {
          labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.LIGHT_GRAY } };
        }

        sizeLabels.forEach((sz, si) => {
          const cell = sizeSheet.getCell(sRow, 2 + si);
          cell.value = m.values[sz] || '';
          cell.font = { name: FONT_NAME, size: 10 };
          cell.border = thinBorder;
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          if (isAlt) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.LIGHT_GRAY } };
          }
        });
        sRow++;
      });
    }

    // ===== 辅料表 =====
    if (data.trims && data.trims.length > 0) {
      const trimsSheet = workbook.addWorksheet('辅料明细');
      trimsSheet.columns = [
        { width: 12 }, { width: 22 }, { width: 22 }, { width: 14 }, { width: 30 }, { width: 12 }, { width: 12 },
      ];

      // 标题
      const style0 = data.styles[0];
      trimsSheet.getCell(1, 1).value = `${style0?.style_no || data.order_no}包装方式`;
      trimsSheet.getCell(1, 1).font = { name: 'Arial', size: 12, bold: true };

      // 表头（深绿背景白字）
      const trimsHeaders = ['辅料', '示例画稿（以实际为准）', '位置说明及示意图', '款式数量', '备注', '工厂价格', '采购价格'];
      trimsHeaders.forEach((h, i) => {
        const cell = trimsSheet.getCell(2, i + 1);
        cell.value = h;
        cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: COLORS.WHITE_TEXT } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.GREEN_HEADER } };
        cell.border = thinBorder;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });

      data.trims.forEach((trim, i) => {
        const r = 3 + i;
        trimsSheet.getCell(r, 1).value = trim.name;
        trimsSheet.getCell(r, 1).font = { name: 'Arial', size: 10, bold: true };
        trimsSheet.getCell(r, 4).value = trim.position;
        trimsSheet.getCell(r, 4).font = { name: 'Arial', size: 10 };
        trimsSheet.getCell(r, 5).value = trim.notes;
        trimsSheet.getCell(r, 5).font = { name: 'Arial', size: 10 };
        trimsSheet.getRow(r).height = 80;
        for (let c = 1; c <= 7; c++) {
          trimsSheet.getCell(r, c).border = thinBorder;
          trimsSheet.getCell(r, c).alignment = { vertical: 'middle', wrapText: true };
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
