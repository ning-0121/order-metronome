'use server';

/**
 * 导出「打样申请单」Excel — 1:1 复刻绮陌打样申请单模板
 *
 * 触发：样品单（order_type='sample' 或 order_purpose='sample'）详情页按钮
 * 返回：{ ok, base64, fileName }，前端 base64→Blob 下载（同 generate-production-order.ts）
 *
 * 设计原则（已与 CEO 对齐）：
 *  - 有结构化数据的字段自动填（客户/业务员/款号/款式描述/交期/尺码/总数量/面辅料/备注/颜色）
 *  - 无数据源的字段留空白格供打印后手填（样衣性质/留样数/特殊要求/上一轮修改意见/贴样处/款式图/审核签名）
 *  - 不新增表、不读外部、纯组装现有数据
 */

import { createClient } from '@/lib/supabase/server';

export interface ExportSampleResult {
  ok: boolean;
  base64?: string;
  fileName?: string;
  error?: string;
}

// 安全取字符串（防 [object Object]）
function str(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.text) return String(v.text);
    try { return JSON.stringify(v); } catch { return ''; }
  }
  return String(v);
}

// 从 colors jsonb 提取可读颜色名（兼容字符串数组 / 对象数组）
function colorName(c: any): string {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c;
  if (typeof c === 'object') {
    return str(c.color_cn || c.color_en || c.name || c.color || '');
  }
  return String(c);
}

export async function exportSampleRequest(orderId: string): Promise<ExportSampleResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '请先登录' };
  if (!user.email?.endsWith('@qimoclothing.com')) {
    return { ok: false, error: '仅允许 @qimoclothing.com 邮箱使用本系统' };
  }
  if (!orderId) return { ok: false, error: '缺少订单 ID' };

  try {
    // ── 取数 ──
    const { data: order, error: orderErr } = await (supabase.from('orders') as any)
      .select('id, order_no, customer_name, style_no, product_description, sizes, colors, quantity, owner_user_id, created_by, factory_date, etd, order_date, notes, order_type, order_purpose')
      .eq('id', orderId)
      .single();
    if (orderErr || !order) return { ok: false, error: '订单不存在：' + (orderErr?.message || orderId) };

    // 仅样品单允许导出
    const isSample = order.order_type === 'sample' || order.order_purpose === 'sample';
    if (!isSample) return { ok: false, error: '打样申请单仅适用于样品单' };

    // 业务员名
    let salesName = '';
    const sid = order.owner_user_id || order.created_by;
    if (sid) {
      const { data: p } = await (supabase.from('profiles') as any)
        .select('name, email').eq('user_id', sid).maybeSingle();
      salesName = str(p?.name) || str(p?.email);
    }

    // 面辅料（BOM）
    const { data: bom } = await (supabase.from('materials_bom') as any)
      .select('material_name, material_type, notes')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true });
    const bomRows: any[] = bom || [];
    const fabrics = bomRows.filter(b => b.material_type === 'fabric');
    const trims = bomRows.filter(b => b.material_type !== 'fabric');

    const colors: string[] = Array.isArray(order.colors)
      ? order.colors.map(colorName).filter(Boolean)
      : [];
    const sizes: string[] = Array.isArray(order.sizes)
      ? order.sizes.map((s: any) => str(s)).filter(Boolean)
      : [];

    const deliveryDate = str(order.factory_date) || str(order.etd);
    const applyDate = new Date().toISOString().slice(0, 10);

    // ── 构建 Excel ──
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.default.Workbook();
    const sheet = wb.addWorksheet('打样申请单');

    const ZH = '宋体';
    const thin = { style: 'thin' as const };
    const allBorder = { top: thin, left: thin, bottom: thin, right: thin };
    const LABEL_BG = 'FFF2F2F2'; // 标签浅灰底

    // 17 列（A-Q），对齐模板
    sheet.columns = [
      { width: 12 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 8 },
      { width: 8 }, { width: 10 }, { width: 8 }, { width: 8 }, { width: 10 },
      { width: 8 }, { width: 8 }, { width: 10 }, { width: 8 }, { width: 10 },
      { width: 12 }, { width: 12 },
    ];

    // 单元格样式辅助
    const cell = (
      r: number, c: number, value: any,
      opts: { bg?: string; bold?: boolean; size?: number; align?: 'left' | 'center' | 'right'; wrap?: boolean; color?: string } = {},
    ) => {
      const cc = sheet.getCell(r, c);
      if (value !== undefined) cc.value = value;
      cc.font = { name: ZH, size: opts.size ?? 11, bold: opts.bold ?? false, color: opts.color ? { argb: opts.color } : undefined };
      if (opts.bg) cc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
      cc.border = allBorder;
      cc.alignment = { horizontal: opts.align ?? 'center', vertical: 'middle', wrapText: opts.wrap ?? true };
      return cc;
    };
    const label = (r: number, c: number, text: string) => cell(r, c, text, { bg: LABEL_BG, bold: true });
    const border = (r1: number, c1: number, r2: number, c2: number) => {
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) sheet.getCell(r, c).border = allBorder;
    };
    const merge = (r1: number, c1: number, r2: number, c2: number) => sheet.mergeCells(r1, c1, r2, c2);

    // ── R1: 标题 ──
    sheet.getRow(1).height = 36;
    cell(1, 1, '打 样 申 请 单', { bold: true, size: 20 });
    merge(1, 1, 1, 17);

    // ── R2: 客户 | 样衣性质 | 业务员 | 申请日期 ──
    sheet.getRow(2).height = 26;
    label(2, 1, '客户'); cell(2, 2, str(order.customer_name)); merge(2, 2, 2, 5);
    label(2, 6, '样衣性质'); cell(2, 7, ''); merge(2, 7, 2, 10); // 留空手填
    label(2, 11, '业务员'); cell(2, 12, salesName); merge(2, 12, 2, 14);
    label(2, 15, '申请日期'); cell(2, 16, applyDate); merge(2, 16, 2, 17);

    // ── R3: 款式描述 | 款号 | 尺寸表 | 交期 ──
    sheet.getRow(3).height = 26;
    label(3, 1, '款式描述'); cell(3, 2, str(order.product_description)); merge(3, 2, 3, 5);
    label(3, 6, '款号'); cell(3, 7, str(order.style_no)); merge(3, 7, 3, 10);
    label(3, 11, '尺寸表'); cell(3, 12, ''); merge(3, 12, 3, 14); // 留空（另附尺寸表）
    label(3, 15, '交期'); cell(3, 16, deliveryDate); merge(3, 16, 3, 17);

    // ── R4: 尺码 | 总数量 | 留样数 ──
    sheet.getRow(4).height = 26;
    label(4, 1, '尺码'); cell(4, 2, sizes.join(' / ')); merge(4, 2, 4, 5);
    label(4, 6, '总数量'); cell(4, 7, order.quantity ?? ''); merge(4, 7, 4, 10);
    label(4, 11, '留样数'); cell(4, 12, ''); merge(4, 12, 4, 14); // 留空手填
    cell(4, 15, ''); merge(4, 15, 4, 17);

    // ── R5: 区块标题行：面辅料信息如下 | 贴样处如下 | 备注 | 款式图 ──
    sheet.getRow(5).height = 24;
    cell(5, 1, '面辅料信息如下', { bg: LABEL_BG, bold: true }); merge(5, 1, 5, 8);
    cell(5, 9, '贴样处如下', { bg: LABEL_BG, bold: true }); merge(5, 9, 5, 14);
    cell(5, 15, '备注', { bg: LABEL_BG, bold: true });
    cell(5, 16, '款式图', { bg: LABEL_BG, bold: true }); merge(5, 16, 5, 17);

    // ── R6-R11: 面辅料明细（左侧 A-H）；右侧 I-Q 为贴样/备注/款式图留空区 ──
    const fabricLine = (r: number, idx: number) => {
      label(r, 1, '面料' + idx);
      cell(r, 2, str(fabrics[idx - 1]?.material_name)); merge(r, 2, r, 5);
      label(r, 6, '克重');
      cell(r, 7, str(fabrics[idx - 1]?.notes)); merge(r, 7, r, 8); // 克重无专列，取 notes 或留空
    };
    sheet.getRow(6).height = 24; fabricLine(6, 1);
    sheet.getRow(7).height = 24; fabricLine(7, 2);

    const trimLine = (r: number, idx: number) => {
      label(r, 1, '辅料' + idx);
      cell(r, 2, str(trims[idx - 1]?.material_name)); merge(r, 2, r, 8);
    };
    sheet.getRow(8).height = 24; trimLine(8, 1);
    sheet.getRow(9).height = 24; trimLine(9, 2);
    sheet.getRow(10).height = 24; trimLine(10, 3);

    sheet.getRow(11).height = 24;
    label(11, 1, '特殊要求'); cell(11, 2, ''); merge(11, 2, 11, 8); // 留空手填

    // 右侧贴样处大区块（I6:N11 合并空白）+ 备注/款式图（O6:Q11 区）
    border(6, 9, 11, 14); merge(6, 9, 11, 14);
    border(6, 15, 11, 17); merge(6, 15, 11, 17);

    // ── R12: 备注 | 此处写上一轮的修改意见 ──
    sheet.getRow(12).height = 40;
    label(12, 1, '备注'); cell(12, 2, str(order.notes), { align: 'left', wrap: true }); merge(12, 2, 12, 8);
    cell(12, 9, '此处写上一轮的修改意见', { bg: LABEL_BG, bold: true }); merge(12, 9, 12, 10);
    cell(12, 11, ''); merge(12, 11, 12, 17); // 留空手填

    // ── R13: 尺码配比表头：样衣性质 | 颜色 | XXS XS S M L XL XXL | 总数量 ──
    const SIZE_COLS = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'];
    sheet.getRow(13).height = 24;
    label(13, 1, '样衣性质');
    label(13, 2, '颜色');
    SIZE_COLS.forEach((s, i) => label(13, 3 + i, s)); // C..I (3..9)
    label(13, 10, '总数量'); merge(13, 10, 13, 17);

    // ── R14+: 颜色行（每色一行，尺码数量留空供手填；首行总数量带订单总量）──
    const colorRows = colors.length > 0 ? colors : [''];
    let r = 14;
    colorRows.forEach((cn, ci) => {
      sheet.getRow(r).height = 22;
      cell(r, 1, ci === 0 ? '初样' : ''); // 样衣性质：默认首行「初样」，其余留空（可手改）
      cell(r, 2, cn);
      for (let i = 0; i < SIZE_COLS.length; i++) cell(r, 3 + i, ''); // 尺码配比留空手填
      cell(r, 10, ci === 0 ? (order.quantity ?? '') : ''); merge(r, 10, r, 17);
      r++;
    });

    // ── 末行：审核签名 | 审核日期 ──
    sheet.getRow(r).height = 30;
    label(r, 1, '审核签名'); cell(r, 2, ''); merge(r, 2, r, 9);
    label(r, 10, '审核日期'); cell(r, 11, ''); merge(r, 11, r, 17);

    // ── 输出 ──
    const buf = await wb.xlsx.writeBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    const safeNo = str(order.order_no) || 'sample';
    const fileName = `打样申请单_${safeNo}_${applyDate}.xlsx`;

    return { ok: true, base64, fileName };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[exportSampleRequest] Error:', message);
    return { ok: false, error: '生成失败：' + message };
  }
}
