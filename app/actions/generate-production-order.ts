'use server';

import type { POParsedData, POStyleData, GarmentCategory } from './po-parser';
import { MEASUREMENT_TEMPLATES } from '@/lib/domain/measurement-templates';
import { createClient } from '@/lib/supabase/server';
import { pushFileToWecomGroup, wecomGroupConfigured } from '@/lib/utils/wecom-file';

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
    // 2026-05-27 模板深度复刻：1:1 对齐绮陌《订单资料.xlsx》布局
    // 详细映射：13 列固定，A-M；高度/合并范围/字体（18pt 宋体/Calibri）/
    // 黄色填充/红字数量/蓝字注意 全部按用户提供的模板还原
    for (const style of data.styles) {
      const sheetName = uniqueSheetName(`${str(style.style_no)} ${str(style.product_name)}`.trim());
      const sheet = workbook.addWorksheet(sheetName);

      // ── 模板常量 ──
      const ZH_FONT = '宋体';
      const NUM_FONT = 'Calibri';
      const FS = 18;
      const Y_BG = 'FFFFFF00';                                            // 黄底
      const PEACH_BG = 'FFFFE4E1';                                        // 顶部公司头浅橘
      const BLUE = 'FF0000FF';                                            // 蓝字（注意 / 船样要求）
      const RED = 'FFFF0000';                                             // 红字（数量 / 总计）
      const thin = { style: 'thin' as const };
      const allBorder = { top: thin, left: thin, bottom: thin, right: thin };

      // 列宽（实测自模板）
      sheet.columns = [
        { width: 15.53 }, // A 款号
        { width: 23.22 }, // B 主布颜色
        { width: 17.50 }, // C 箱数
        { width: 12.68 }, // D 数量
        { width: 9.99 },  // E S
        { width: 9 },     // F M
        { width: 9 },     // G L
        { width: 9 },     // H XL
        { width: 25.15 }, // I 客户包装
        { width: 15.53 }, // J 颜色备注（左半）
        { width: 16.71 }, // K 颜色备注（右半）
        { width: 9 },     // L 图片位（左半）
        { width: 31.25 }, // M 图片位（右半）/ 注意框
      ];

      const N = Math.max(style.colors.length, 1); // 颜色数（至少 1 行）

      // 行索引（动态根据颜色数计算）
      const R_TITLE = 1;
      const R_ORDER = 2;
      const R_NAME = 3;
      const R_DUE = 4;
      const R_QTY = 5;
      const R_HEADER = 6;
      const R_DATA_START = 7;
      const R_DATA_END = R_DATA_START + N - 1;
      const R_TOTAL = R_DATA_END + 1;
      const R_FABRIC = R_TOTAL + 1;
      const R_SAMPLE_TIME = R_FABRIC + 1;
      const R_PRE_SAMPLE = R_SAMPLE_TIME + 1;
      const R_SHIP_SAMPLE = R_PRE_SAMPLE + 1;
      const R_COMMENT_TITLE = R_SHIP_SAMPLE + 1;
      const R_COMMENT_BODY = R_COMMENT_TITLE + 1;
      const R_PACK_NOTE = R_COMMENT_BODY + 1;
      const R_SIGN = R_PACK_NOTE + 1;

      // 行高
      sheet.getRow(R_TITLE).height = 61;
      [R_ORDER, R_NAME, R_DUE, R_QTY, R_HEADER].forEach((r) => (sheet.getRow(r).height = 63));
      for (let r = R_DATA_START; r <= R_DATA_END; r++) sheet.getRow(r).height = 40;
      sheet.getRow(R_TOTAL).height = 51;
      sheet.getRow(R_FABRIC).height = 73;
      sheet.getRow(R_SAMPLE_TIME).height = 48;
      [R_PRE_SAMPLE, R_SHIP_SAMPLE].forEach((r) => (sheet.getRow(r).height = 64));
      sheet.getRow(R_COMMENT_TITLE).height = 40;
      sheet.getRow(R_COMMENT_BODY).height = 304;
      [R_PACK_NOTE, R_SIGN].forEach((r) => (sheet.getRow(r).height = 64));

      // ── 通用样式辅助 ──
      const styleCell = (
        r: number,
        c: number,
        value: any,
        opts: {
          bg?: string;
          color?: string;
          font?: string;
          bold?: boolean;
          align?: 'left' | 'center' | 'right';
          wrap?: boolean;
          border?: boolean;
        } = {},
      ) => {
        const cell = sheet.getCell(r, c);
        if (value !== undefined) cell.value = value;
        cell.font = {
          name: opts.font || ZH_FONT,
          size: FS,
          bold: opts.bold !== false, // 默认 bold
          color: opts.color ? { argb: opts.color } : undefined,
        };
        if (opts.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
        if (opts.border !== false) cell.border = allBorder;
        cell.alignment = {
          horizontal: opts.align || 'center',
          vertical: 'middle',
          wrapText: opts.wrap ?? false,
        };
        return cell;
      };
      const fillRange = (r1: number, c1: number, r2: number, c2: number, bg: string) => {
        for (let r = r1; r <= r2; r++) {
          for (let c = c1; c <= c2; c++) {
            const cell = sheet.getCell(r, c);
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
            cell.border = allBorder;
          }
        }
      };
      const borderRange = (r1: number, c1: number, r2: number, c2: number) => {
        for (let r = r1; r <= r2; r++) {
          for (let c = c1; c <= c2; c++) {
            sheet.getCell(r, c).border = allBorder;
          }
        }
      };

      // ── R1: 公司头 绮陌服饰 (A1:M1) ──
      styleCell(R_TITLE, 1, '绮陌服饰', { bg: PEACH_BG });
      sheet.mergeCells(R_TITLE, 1, R_TITLE, 13);

      // ── R2-R5: 头部信息 4 列网格 ──
      // R2: 订单号(A:C) | 值(D:I) | 下单日期(J) | 值(K:M)
      const customerSuffix = data.customer_name ? `（${str(data.customer_name)}）` : '';
      styleCell(R_ORDER, 1, '订单号', { bg: Y_BG });
      sheet.mergeCells(R_ORDER, 1, R_ORDER, 3);
      styleCell(R_ORDER, 4, `${str(data.order_no)}${customerSuffix}`, { font: NUM_FONT });
      sheet.mergeCells(R_ORDER, 4, R_ORDER, 9);
      styleCell(R_ORDER, 10, '下单日期', { bg: Y_BG });
      styleCell(R_ORDER, 11, str(data.order_date) || '—', { font: NUM_FONT });
      sheet.mergeCells(R_ORDER, 11, R_ORDER, 13);

      // R3: 品名(A:C) | 值(D:I) | 原料(J) | 值(K:M)
      styleCell(R_NAME, 1, '品名', { bg: Y_BG });
      sheet.mergeCells(R_NAME, 1, R_NAME, 3);
      styleCell(R_NAME, 4, str(style.product_name));
      sheet.mergeCells(R_NAME, 4, R_NAME, 9);
      styleCell(R_NAME, 10, '原料', { bg: Y_BG });
      styleCell(R_NAME, 11, str(style.material), { font: NUM_FONT, wrap: true });
      sheet.mergeCells(R_NAME, 11, R_NAME, 13);

      // R4: 交期(A:C) | 值(D:I) | 面料克重(J 跨2行) | 值(K:M 跨2行)
      styleCell(R_DUE, 1, '交期', { bg: Y_BG });
      sheet.mergeCells(R_DUE, 1, R_DUE, 3);
      styleCell(R_DUE, 4, str(data.delivery_date), { font: NUM_FONT, wrap: true });
      sheet.mergeCells(R_DUE, 4, R_DUE, 9);
      styleCell(R_DUE, 10, '面料克重', { bg: Y_BG });
      sheet.mergeCells(R_DUE, 10, R_QTY, 10);
      styleCell(R_DUE, 11, str(style.fabric_weight), { font: NUM_FONT, wrap: true });
      sheet.mergeCells(R_DUE, 11, R_QTY, 13);

      // R5: 数量(A:C) | =D{TOTAL_ROW} (D:I)
      styleCell(R_QTY, 1, '数量', { bg: Y_BG });
      sheet.mergeCells(R_QTY, 1, R_QTY, 3);
      styleCell(R_QTY, 4, { formula: `D${R_TOTAL}` } as any, { font: NUM_FONT, color: RED });
      sheet.mergeCells(R_QTY, 4, R_QTY, 9);

      // ── R6: 表头 黄底 ──
      const HEADERS: Array<[number, string, number?]> = [
        [1, '款号'],
        [2, '主布颜色'],
        [3, '箱数'],
        [4, '数量'],
        [5, 'S'],
        [6, 'M'],
        [7, 'L'],
        [8, 'XL'],
        [9, '客户包装'],
      ];
      HEADERS.forEach(([col, label]) => styleCell(R_HEADER, col, label, { bg: Y_BG, wrap: true }));
      // 颜色备注合并 J:K
      styleCell(R_HEADER, 10, '颜色备注', { bg: Y_BG });
      sheet.mergeCells(R_HEADER, 10, R_HEADER, 11);
      // 图片位预留 L6:M(R_DATA_END) — 跨表头 + 数据行
      borderRange(R_HEADER, 12, R_DATA_END, 13);
      sheet.mergeCells(R_HEADER, 12, R_DATA_END, 13);

      // ── R7..R{N+6}: 数据行 ──
      style.colors.forEach((color, ci) => {
        const r = R_DATA_START + ci;
        if (ci === 0) styleCell(r, 1, str(style.style_no), { font: NUM_FONT, wrap: true, bold: false });
        // 主布颜色：sz14（模板里小一号）
        const colorCell = sheet.getCell(r, 2);
        colorCell.value = str(color.color_cn) || str(color.color_en);
        colorCell.font = { name: ZH_FONT, size: 14, color: { argb: 'FF000000' } };
        colorCell.border = allBorder;
        colorCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        // 箱数：公式 =D{r}/48
        styleCell(r, 3, { formula: `D${r}/48` } as any, { font: NUM_FONT, bold: false, color: 'FF000000' });
        // 数量：该色【全尺码】真实总量(修 P2 2026-07-09:此前 =E+F+G+H 只加 S/M/L/XL,
        //   含 XXL/数字码时少算、纯数字码整单归 0 → 工厂裁错量。总量按所有尺码求和;逐码明细见「尺寸表」sheet)。
        const colorTotal = Object.values((color.sizes && typeof color.sizes === 'object' ? color.sizes : {}))
          .reduce((s: number, v: any) => s + (Number(v) || 0), 0);
        styleCell(r, 4, colorTotal, { font: NUM_FONT, bold: false, color: RED });
        // 尺码配比(主表展示标准 S/M/L/XL;非标码在「尺寸表」sheet 动态全列)
        ['S', 'M', 'L', 'XL'].forEach((sz, si) => {
          styleCell(r, 5 + si, color.sizes?.[sz] || 0, { font: NUM_FONT, bold: false });
        });
        // 客户包装 — 只在第一行填，后面合并
        if (ci === 0) {
          const packCell = sheet.getCell(r, 9);
          packCell.value = str(color.packaging);
          packCell.font = { name: ZH_FONT, size: 14 };
          packCell.border = allBorder;
          packCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
        }
        // 颜色备注（英文）合并 J:K
        styleCell(r, 10, str(color.color_en), { bold: false });
        sheet.mergeCells(r, 10, r, 11);
      });
      // 款号 A 列合并（跨 N 行）+ 客户包装 I 列合并
      if (N > 1) {
        sheet.mergeCells(R_DATA_START, 1, R_DATA_END, 1);
        sheet.mergeCells(R_DATA_START, 9, R_DATA_END, 9);
      }

      // ── 总计行（R_TOTAL，黄底）──
      styleCell(R_TOTAL, 1, '总计');
      sheet.mergeCells(R_TOTAL, 1, R_TOTAL, 2);
      // 总箱数公式 =SUM(C{start}:C{end})
      styleCell(R_TOTAL, 3, { formula: `SUM(C${R_DATA_START}:C${R_DATA_END})` } as any, {
        font: NUM_FONT,
        bold: false,
      });
      // 总数量公式 =SUM(D{start}:D{end}) 红字
      styleCell(R_TOTAL, 4, { formula: `SUM(D${R_DATA_START}:D${R_DATA_END})` } as any, {
        font: NUM_FONT,
        bold: false,
        color: RED,
      });
      // 其余 E-M 列空但带边框
      for (let c = 5; c <= 13; c++) sheet.getCell(R_TOTAL, c).border = allBorder;

      // ── R_FABRIC: 面料克重 黄行 (A:M 合并) ──
      // 优先 unit_consumption（含单耗详情），否则 fabric_weight 兜底
      const fabricText = style.unit_consumption?.trim() || str(style.fabric_weight) || '面料信息待填';
      styleCell(R_FABRIC, 1, fabricText, { bg: Y_BG });
      sheet.mergeCells(R_FABRIC, 1, R_FABRIC, 13);

      // ── R_SAMPLE_TIME: 交样时间标题 (B:C) | 要求 (D:L) | 注意框 (M 跨 3 行) ──
      sheet.getCell(R_SAMPLE_TIME, 1).border = allBorder;
      styleCell(R_SAMPLE_TIME, 2, '交样时间');
      sheet.mergeCells(R_SAMPLE_TIME, 2, R_SAMPLE_TIME, 3);
      styleCell(R_SAMPLE_TIME, 4, '要求');
      sheet.mergeCells(R_SAMPLE_TIME, 4, R_SAMPLE_TIME, 12);
      // 注意框（M12:M14 合并）
      const warnText = (data as any).warning_notes?.trim()
        || '注意：大货数量不能少出，也不能多出。交货期不能晚，延期会扣款。大货尺寸千万不能做小。';
      styleCell(R_SAMPLE_TIME, 13, warnText, { color: BLUE, wrap: true });
      sheet.mergeCells(R_SAMPLE_TIME, 13, R_SHIP_SAMPLE, 13);

      // ── R_PRE_SAMPLE: 产前样 ──
      styleCell(R_PRE_SAMPLE, 1, '产前样');
      styleCell(R_PRE_SAMPLE, 2, '');
      sheet.mergeCells(R_PRE_SAMPLE, 2, R_PRE_SAMPLE, 3);
      styleCell(R_PRE_SAMPLE, 4, '');
      sheet.mergeCells(R_PRE_SAMPLE, 4, R_PRE_SAMPLE, 12);

      // ── R_SHIP_SAMPLE: 船样 ──
      styleCell(R_SHIP_SAMPLE, 1, '船样');
      styleCell(R_SHIP_SAMPLE, 2, '', { font: NUM_FONT });
      sheet.mergeCells(R_SHIP_SAMPLE, 2, R_SHIP_SAMPLE, 3);
      styleCell(R_SHIP_SAMPLE, 4, str(style.sample_requirements), { color: BLUE, wrap: true });
      sheet.mergeCells(R_SHIP_SAMPLE, 4, R_SHIP_SAMPLE, 12);

      // ── R_COMMENT_TITLE: 款式评语标题（黄底）──
      styleCell(R_COMMENT_TITLE, 1, '款式评语', { bg: Y_BG });
      sheet.mergeCells(R_COMMENT_TITLE, 1, R_COMMENT_TITLE, 13);

      // ── R_COMMENT_BODY: 9 条评语（黄底，wrap）──
      const commentText = style.quality_notes?.trim() || '（待填）';
      const commentCell = styleCell(R_COMMENT_BODY, 1, commentText, { bg: Y_BG, wrap: true, align: 'center' });
      commentCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      sheet.mergeCells(R_COMMENT_BODY, 1, R_COMMENT_BODY, 13);

      // ── R_PACK_NOTE: 包装明细及要求详见附页 ──
      styleCell(R_PACK_NOTE, 1, '包装明细及要求详见附页');
      sheet.mergeCells(R_PACK_NOTE, 1, R_PACK_NOTE, 13);

      // ── R_SIGN: 签收人 | 签收时间 ──
      styleCell(R_SIGN, 1, '签收人：', { align: 'left' });
      sheet.getCell(R_SIGN, 2).border = allBorder;
      sheet.mergeCells(R_SIGN, 2, R_SIGN, 9);
      styleCell(R_SIGN, 10, '签收时间：', { align: 'left' });
      sheet.mergeCells(R_SIGN, 10, R_SIGN, 13);

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

    // 方案B：为【真实订单】生成生产单后，自动发到企业微信群（团队可在群里直接拿到 + 一键转存微盘）。
    // 仅 options.orderId 存在时触发（排除报价/草稿预览，避免刷屏）；fire-and-forget，永不阻塞生成。
    if (options?.orderId && wecomGroupConfigured()) {
      try {
        await pushFileToWecomGroup(
          { content: base64, filename: fileName },
          { caption: `🏭 生产单已生成：${data.order_no}（${data.customer_name || '—'}）` },
        );
      } catch (e: unknown) {
        console.warn('[generateProductionOrder] WeCom 推送失败:', e instanceof Error ? e.message : String(e));
      }
    }

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
