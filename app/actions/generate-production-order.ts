'use server';

import type { POParsedData, POStyleData, GarmentCategory } from './po-parser';
import { MEASUREMENT_TEMPLATES } from '@/lib/domain/measurement-templates';
import { createClient } from '@/lib/supabase/server';

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

export async function generateProductionOrder(
  data: POParsedData,
  options?: { orderId?: string; draftId?: string },
): Promise<{ ok: boolean; base64?: string; fileName?: string; error?: string }> {
  // 鉴权：之前完全没检查，外部 POST 这个 server action 端点即可拿到含
  // 客户/数量/交期的 Excel。2026-05-19 补登录 + 邮箱域名校验。
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) {
    return { ok: false, error: '仅允许 @qimoclothing.com 邮箱使用本系统' };
  }

  try {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.default.Workbook();

    const FONT_NAME = 'Arial';
    const thinBorder: Partial<ExcelJS.Borders> = {
      top: { style: 'thin' }, left: { style: 'thin' },
      bottom: { style: 'thin' }, right: { style: 'thin' },
    };

    const sizeLabels = data.size_labels?.length > 0 ? data.size_labels : ['S', 'M', 'L'];

    // 安全取字符串值（防止 [object Object]）
    const str = (v: any): string => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') {
        if (v.text) return String(v.text);
        if (v.result) return String(v.result);
        try { return JSON.stringify(v); } catch { return ''; }
      }
      return String(v);
    };

    // Sheet 名去重
    const usedNames = new Set<string>();
    const uniqueSheetName = (base: string): string => {
      let name = str(base).substring(0, 28) || 'Sheet';
      let final = name;
      let i = 2;
      while (usedNames.has(final)) { final = `${name}_${i++}`; }
      usedNames.add(final);
      return final;
    };

    // ===== 每个款式生成主表 + 尺寸表 =====
    for (const style of data.styles) {

      // ────── 主表（生产单） ──────
      const sheetName = uniqueSheetName(style.style_no);
      const sheet = workbook.addWorksheet(sheetName);

      // 新列顺序：款号 | 主布颜色 | 箱数 | 数量 | [S/M/L/XL...] | 客户包装 | 图片
      // 去掉了「款式描述」（品名已在表头），数量挪到尺码前
      const boxCol = 3;        // 箱数
      const qtyCol = 4;        // 数量
      const sizeStartCol = 5;  // S 列起点
      const packagingCol = sizeStartCol + sizeLabels.length;  // 客户包装
      const imageCol = packagingCol + 1;                       // 图片
      const totalCols = imageCol;

      sheet.columns = [
        { width: 14 }, // A: 款号
        { width: 14 }, // B: 主布颜色
        { width: 8 },  // C: 箱数
        { width: 10 }, // D: 数量
        ...sizeLabels.map(() => ({ width: 7 })), // E..: 尺码
        { width: 24 }, // 客户包装
        { width: 10 }, // 图片
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
      setValue(row, 3, str(data.order_no), true);
      sheet.mergeCells(row, 3, row, packagingCol);
      row++;

      // Row 3: 品名
      setLabel(row, 1, '品名');
      sheet.mergeCells(row, 1, row, 2);
      setValue(row, 3, str(style.product_name), true);
      sheet.mergeCells(row, 3, row, packagingCol - 2);
      setValue(row, packagingCol - 1, str(style.material));
      sheet.mergeCells(row, packagingCol - 1, row, packagingCol);
      row++;

      // Row 4: 交期
      setLabel(row, 1, '交期');
      sheet.mergeCells(row, 1, row, 2);
      const deliveryCell = sheet.getCell(row, 3);
      deliveryCell.value = `${str(data.delivery_date)}（客户装柜日，不得延期）`;
      deliveryCell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.NAVY_TEXT } };
      deliveryCell.border = thinBorder;
      deliveryCell.alignment = { vertical: 'middle' };
      sheet.mergeCells(row, 3, row, packagingCol - 2);
      setValue(row, packagingCol - 1, str(style.fabric_weight));
      sheet.mergeCells(row, packagingCol - 1, row, packagingCol);
      row++;

      // Row 5: 数量
      setLabel(row, 1, '数量');
      sheet.mergeCells(row, 1, row, 2);
      setValue(row, 3, Number(style.total_qty) || 0, true);
      sheet.mergeCells(row, 3, row, packagingCol);
      row++;

      // Row 6: 表格表头（深绿背景白字）
      const greenHeader = (col: number, text: string) => {
        const cell = sheet.getCell(row, col);
        cell.value = text;
        cell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.WHITE_TEXT } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.GREEN_HEADER } };
        cell.border = thinBorder;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      };
      greenHeader(1, '款号');
      greenHeader(2, '主布颜色');
      greenHeader(boxCol, '箱数');
      greenHeader(qtyCol, '数量');
      sizeLabels.forEach((sz, si) => greenHeader(sizeStartCol + si, sz));
      greenHeader(packagingCol, '客户包装');
      greenHeader(imageCol, '图片');
      row++;

      // Data rows
      const dataStartRow = row;
      style.colors.forEach((color, ci) => {
        setValue(row, 1, ci === 0 ? str(style.style_no) : '');
        // 主布颜色：中文 + 英文括号
        const colorText = color.color_cn && color.color_en
          ? `${str(color.color_cn)}（${str(color.color_en)}）`
          : str(color.color_cn) || str(color.color_en);
        setValue(row, 2, colorText);

        const boxes = Math.ceil(color.qty / 48);
        setValue(row, boxCol, boxes);

        // 数量先放（红字突出）
        const qtyValueCell = sheet.getCell(row, qtyCol);
        qtyValueCell.value = color.qty;
        qtyValueCell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.RED_TEXT } };
        qtyValueCell.border = thinBorder;
        qtyValueCell.alignment = { horizontal: 'center', vertical: 'middle' };

        // 尺码配比
        sizeLabels.forEach((sz, si) => {
          setValue(row, sizeStartCol + si, color.sizes?.[sz] || 0);
        });

        // 客户包装：优先用色级 packaging，否则空
        setValue(row, packagingCol, str(color.packaging));
        sheet.getCell(row, packagingCol).alignment = { vertical: 'middle', wrapText: true, horizontal: 'left' };

        // 图片列空但带边框
        sheet.getCell(row, imageCol).border = thinBorder;

        row++;
      });

      // Total row（黄底）— 箱数和数量都算合计
      const totalRow = row;
      setLabel(totalRow, 1, '总计');
      sheet.mergeCells(totalRow, 1, totalRow, 2);
      // 总箱数
      const totalBoxes = style.colors.reduce((s, c) => s + Math.ceil(c.qty / 48), 0);
      const totalBoxesCell = sheet.getCell(totalRow, boxCol);
      totalBoxesCell.value = totalBoxes;
      totalBoxesCell.font = { name: FONT_NAME, size: 11, bold: true, color: { argb: COLORS.RED_TEXT } };
      totalBoxesCell.border = thinBorder;
      totalBoxesCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.YELLOW_BG } };
      totalBoxesCell.alignment = { horizontal: 'center', vertical: 'middle' };
      // 总数量
      const totalQtyCell = sheet.getCell(totalRow, qtyCol);
      totalQtyCell.value = style.total_qty;
      totalQtyCell.font = { name: FONT_NAME, size: 11, bold: true, color: { argb: COLORS.RED_TEXT } };
      totalQtyCell.border = thinBorder;
      totalQtyCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.YELLOW_BG } };
      totalQtyCell.alignment = { horizontal: 'center', vertical: 'middle' };
      // 其余列填黄底
      for (let c = sizeStartCol; c <= imageCol; c++) {
        const cell = sheet.getCell(totalRow, c);
        cell.border = thinBorder;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.YELLOW_BG } };
      }
      row += 2;

      // 产前样 / 船样要求
      setLabel(row, 1, '');
      setValue(row, 2, '交样时间');
      sheet.getCell(row, 2).font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.NAVY_TEXT } };
      setValue(row, packagingCol, '要求');
      sheet.getCell(row, packagingCol).font = { name: FONT_NAME, size: 10, bold: true, color: { argb: COLORS.NAVY_TEXT } };
      row++;

      setValue(row, 1, '产前样');
      sheet.getCell(row, 1).font = { name: FONT_NAME, size: 10, bold: true };
      row++;

      setValue(row, 1, '船样');
      sheet.getCell(row, 1).font = { name: FONT_NAME, size: 10, bold: true };
      if (style.sample_requirements) {
        setValue(row, packagingCol, style.sample_requirements);
      }
      row += 2;

      // 单件用量行（黄底居中，款式评语上方）— 用户标注: "款式评语上方增加一列单件用量"
      // 优先用 style.unit_consumption（AI 解析或手填），否则用 fabric_weight 兜底
      const consumptionText = style.unit_consumption?.trim()
        ? style.unit_consumption.trim()
        : style.fabric_weight
        ? `${style.fabric_weight} 单耗：待填`
        : '';
      if (consumptionText) {
        const consCell = sheet.getCell(row, 1);
        consCell.value = consumptionText;
        consCell.font = { name: FONT_NAME, size: 11, bold: true, color: { argb: COLORS.NAVY_TEXT } };
        consCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.YELLOW_BG } };
        consCell.alignment = { horizontal: 'center', vertical: 'middle' };
        sheet.mergeCells(row, 1, row, imageCol);
        sheet.getRow(row).height = 22;
        row++;
      }

      // 款式评语
      setLabel(row, 1, '款式评语');
      sheet.mergeCells(row, 1, row, imageCol);
      row++;

      if (style.quality_notes) {
        const notesCell = sheet.getCell(row, 1);
        notesCell.value = style.quality_notes;
        notesCell.font = { name: FONT_NAME, size: 10, color: { argb: COLORS.NAVY_TEXT } };
        notesCell.alignment = { wrapText: true, vertical: 'top' };
        sheet.mergeCells(row, 1, row, imageCol);
        sheet.getRow(row).height = 100;
      }
      row += 2;

      // 包装明细提示
      const packNote = sheet.getCell(row, 1);
      packNote.value = '包装明细及要求详见附页';
      packNote.font = { name: FONT_NAME, size: 10 };

      // ────── 尺寸表 Sheet ──────
      const sizeSheetName = uniqueSheetName(`${str(style.style_no)}尺寸表`);
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

    // P0-1: 成功生成 Excel 后清掉草稿（数据已经下载到用户手里了，草稿失去意义）
    if (options?.draftId) {
      await (supabase.from('po_parse_drafts') as any)
        .delete()
        .eq('id', options.draftId)
        .eq('user_id', user.id)
        .then(({ error }: { error: any }) => {
          if (error) console.warn('[generateProductionOrder] cleanup draft failed:', error.message);
        });
    }

    return { ok: true, base64, fileName };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[generateProductionOrder] Error:', message);
    return { ok: false, error: `生成失败：${message}` };
  }
}
