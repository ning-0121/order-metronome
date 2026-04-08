'use server';

/**
 * 导出「生产跟单表」Excel
 *
 * 生产部每天下载这个表格，对着它更新进度、填写备注。
 * 管理员 / 生产主管 / 行政督办 / 跟单 可以导出。
 *
 * 列：订单号 · 客户 · 款号 · 数量 · 工厂 · 加急 · 下单日 · 出厂日 · 剩余天数
 *     · 生产启动 · 中查 · 尾查 · 工厂完成 · 验货放行
 *     · 累计产量 · 进度% · 风险 · 跟单 · 跟单备注（空白给生产部填）
 */

import { createClient } from '@/lib/supabase/server';

interface ExportRow {
  order_no: string;
  internal_order_no: string;
  customer: string;
  style_no: string;
  quantity: number;
  colors: string;
  factory: string;
  urgent: string;
  order_date: string;
  factory_date: string;
  etd: string;
  cancel_date: string;
  days_left: number | null;
  production_kickoff: string;
  mid_qc: string;
  final_qc: string;
  factory_completion: string;
  inspection_release: string;
  cumulative_qty: number;
  progress_pct: number;
  risk_label: string;
  risk_level: 'green' | 'yellow' | 'red';
  sales: string;
  owner: string;
}

/** 把 colors jsonb 数组格式化为人类可读文本 */
function formatColors(colorsJson: any): string {
  if (!colorsJson) return '';
  const arr = Array.isArray(colorsJson) ? colorsJson : [];
  if (arr.length === 0) return '';
  return arr
    .map((c: any) => {
      if (typeof c === 'string') return c;
      const name = c.color_cn || c.color_en || c.name || '';
      const qty = c.qty || c.quantity;
      return qty ? `${name}×${qty}` : name;
    })
    .filter(Boolean)
    .join('、');
}

export async function exportProductionTrackingSheet(): Promise<{
  error?: string;
  base64?: string;
  fileName?: string;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: '请先登录' };

  // 权限：admin / production_manager / admin_assistant / merchandiser
  const { data: profile } = await (supabase.from('profiles') as any)
    .select('role, roles')
    .eq('user_id', user.id)
    .single();
  const userRoles: string[] =
    (profile as any)?.roles?.length > 0 ? (profile as any).roles : [(profile as any)?.role].filter(Boolean);
  const allowed = userRoles.some((r: string) =>
    ['admin', 'production_manager', 'admin_assistant', 'merchandiser', 'sales'].includes(r)
  );
  if (!allowed) return { error: '无权限导出' };

  // 只导出进行中的订单
  const { data: orders, error: orderErr } = await (supabase.from('orders') as any)
    .select(
      'id, order_no, internal_order_no, customer_name, style_no, quantity, colors, factory_name, special_tags, order_date, factory_date, etd, cancel_date, status, owner_user_id, created_by',
    )
    .not('status', 'in', '("completed","archived","cancelled","已完成","已归档","已取消")')
    .order('factory_date', { ascending: true, nullsFirst: false });

  if (orderErr) return { error: orderErr.message };
  if (!orders || orders.length === 0) return { error: '当前没有进行中的订单' };

  const orderIds = (orders as any[]).map((o: any) => o.id);

  // 批量拿关键节点
  const { data: allMilestones } = await (supabase.from('milestones') as any)
    .select('order_id, step_key, due_at, status')
    .in('order_id', orderIds)
    .in('step_key', [
      'production_kickoff',
      'mid_qc_check',
      'final_qc_check',
      'factory_completion',
      'inspection_release',
    ]);

  // 批量拿生产日报累计
  const { data: reports } = await (supabase.from('production_reports') as any)
    .select('order_id, qty_produced')
    .in('order_id', orderIds);

  const cumulativeByOrder = new Map<string, number>();
  for (const r of (reports || []) as any[]) {
    cumulativeByOrder.set(r.order_id, (cumulativeByOrder.get(r.order_id) || 0) + (r.qty_produced || 0));
  }

  // 批量拿跟单 + 业务（created_by）名字
  const allUserIds = [
    ...new Set(
      (orders as any[]).flatMap((o: any) => [o.owner_user_id, o.created_by]).filter(Boolean),
    ),
  ];
  const nameMap = new Map<string, string>();
  if (allUserIds.length > 0) {
    const { data: profiles } = await (supabase.from('profiles') as any)
      .select('user_id, name, email')
      .in('user_id', allUserIds);
    for (const p of (profiles || []) as any[]) {
      nameMap.set(p.user_id, p.name || p.email?.split('@')[0] || '');
    }
  }

  // 节点日期 + 状态 格式化
  const msByOrder = new Map<string, Map<string, any>>();
  for (const m of (allMilestones || []) as any[]) {
    if (!msByOrder.has(m.order_id)) msByOrder.set(m.order_id, new Map());
    msByOrder.get(m.order_id)!.set(m.step_key, m);
  }

  function formatMs(orderId: string, stepKey: string): string {
    const ms = msByOrder.get(orderId)?.get(stepKey);
    if (!ms) return '—';
    const date = ms.due_at ? new Date(ms.due_at).toISOString().slice(0, 10) : '—';
    const st = ms.status;
    let mark = '';
    if (st === 'done' || st === '已完成' || st === 'completed') mark = ' ✔';
    else if (st === 'blocked' || st === '卡住' || st === '卡单') mark = ' ⛔';
    else if (st === 'in_progress' || st === '进行中') mark = ' ▶';
    return `${date}${mark}`;
  }

  // 组织行数据
  const today = new Date();
  const rows: ExportRow[] = (orders as any[]).map((o: any) => {
    const anchor = o.factory_date || o.etd;
    const daysLeft = anchor
      ? Math.ceil((new Date(anchor).getTime() - today.getTime()) / 86400000)
      : null;

    const cumulative = cumulativeByOrder.get(o.id) || 0;
    const progressPct = o.quantity > 0 ? Math.round((cumulative / o.quantity) * 100) : 0;

    // 简易风险：剩余天数 < 7 且进度 < 60% = 红；剩余天数 < 14 且进度 < 40% = 黄
    let riskLevel: 'green' | 'yellow' | 'red' = 'green';
    let riskLabel = '正常';
    if (daysLeft !== null) {
      if (daysLeft < 0) {
        riskLevel = 'red';
        riskLabel = `逾期 ${-daysLeft} 天`;
      } else if (daysLeft < 7 && progressPct < 60) {
        riskLevel = 'red';
        riskLabel = '危险';
      } else if (daysLeft < 14 && progressPct < 40) {
        riskLevel = 'yellow';
        riskLabel = '注意';
      }
    }

    const tags: string[] = Array.isArray(o.special_tags) ? o.special_tags : [];
    const urgent = tags.includes('rush') || tags.includes('加急') ? '🔥 加急' : '';

    return {
      order_no: o.order_no || '',
      internal_order_no: o.internal_order_no || '',
      customer: o.customer_name || '',
      style_no: o.style_no || '',
      quantity: o.quantity || 0,
      colors: formatColors(o.colors),
      factory: o.factory_name || '',
      urgent,
      order_date: o.order_date ? String(o.order_date).slice(0, 10) : '',
      factory_date: o.factory_date ? String(o.factory_date).slice(0, 10) : '',
      etd: o.etd ? String(o.etd).slice(0, 10) : '',
      cancel_date: o.cancel_date ? String(o.cancel_date).slice(0, 10) : '',
      days_left: daysLeft,
      production_kickoff: formatMs(o.id, 'production_kickoff'),
      mid_qc: formatMs(o.id, 'mid_qc_check'),
      final_qc: formatMs(o.id, 'final_qc_check'),
      factory_completion: formatMs(o.id, 'factory_completion'),
      inspection_release: formatMs(o.id, 'inspection_release'),
      cumulative_qty: cumulative,
      progress_pct: progressPct,
      risk_label: riskLabel,
      risk_level: riskLevel,
      sales: nameMap.get(o.created_by) || '',
      owner: nameMap.get(o.owner_user_id) || '',
    };
  });

  // 生成 Excel
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.default.Workbook();
  wb.creator = '订单节拍器';
  wb.created = new Date();
  const ws = wb.addWorksheet('生产跟单表', { views: [{ state: 'frozen', ySplit: 2 }] });

  // 标题
  ws.mergeCells('A1:Y1');
  const titleCell = ws.getCell('A1');
  titleCell.value = `生产跟单表 — ${new Date().toLocaleDateString('zh-CN')}（共 ${rows.length} 单）`;
  titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  ws.getRow(1).height = 28;

  // 表头
  const headers = [
    '订单号', '内部单号', '客户', '款号', '数量', '颜色', '工厂', '加急',
    '下单日', '出厂日', 'ETD/交期', '取消日', '剩余天数',
    '生产启动', '中查', '尾查', '工厂完成', '验货放行',
    '累计产量', '进度%', '风险',
    '业务', '跟单', '跟单备注', '生产部备注',
  ];
  const headerRow = ws.getRow(2);
  headerRow.values = headers;
  headerRow.height = 22;
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FF1F2937' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
    };
  });

  // 数据行
  rows.forEach((r, i) => {
    const row = ws.getRow(i + 3);
    row.values = [
      r.order_no,
      r.internal_order_no,
      r.customer,
      r.style_no,
      r.quantity,
      r.colors,
      r.factory,
      r.urgent,
      r.order_date,
      r.factory_date,
      r.etd,
      r.cancel_date,
      r.days_left === null ? '' : r.days_left,
      r.production_kickoff,
      r.mid_qc,
      r.final_qc,
      r.factory_completion,
      r.inspection_release,
      r.cumulative_qty,
      `${r.progress_pct}%`,
      r.risk_label,
      r.sales,
      r.owner,
      '', // 跟单备注
      '', // 生产部备注
    ];
    row.height = 20;
    row.alignment = { vertical: 'middle' };

    // 风险染色整行
    const riskColor =
      r.risk_level === 'red' ? 'FFFEE2E2' :
      r.risk_level === 'yellow' ? 'FFFEF3C7' :
      undefined;
    if (riskColor) {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: riskColor } };
      });
    }

    // 风险列（第 21 列）文字颜色
    const riskCell = row.getCell(21);
    if (r.risk_level === 'red') riskCell.font = { bold: true, color: { argb: 'FFDC2626' } };
    else if (r.risk_level === 'yellow') riskCell.font = { bold: true, color: { argb: 'FFD97706' } };

    // 剩余天数（第 13 列）染色
    if (r.days_left !== null) {
      const dl = row.getCell(13);
      if (r.days_left < 0) dl.font = { bold: true, color: { argb: 'FFDC2626' } };
      else if (r.days_left < 7) dl.font = { bold: true, color: { argb: 'FFD97706' } };
    }

    row.eachCell(cell => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFF3F4F6' } },
        bottom: { style: 'thin', color: { argb: 'FFF3F4F6' } },
        left: { style: 'thin', color: { argb: 'FFF3F4F6' } },
        right: { style: 'thin', color: { argb: 'FFF3F4F6' } },
      };
    });
  });

  // 列宽
  const widths = [
    16, 14, 18, 14, 8, 20, 18, 8,
    11, 11, 11, 11, 9,
    14, 14, 14, 14, 14,
    10, 9, 12,
    10, 10, 24, 24,
  ];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // 说明页
  const ws2 = wb.addWorksheet('说明');
  ws2.getColumn(1).width = 80;
  const notes = [
    '生产跟单表使用说明',
    '',
    '1. 本表每次导出都是实时数据（导出时刻）',
    '2. 节点日期旁的符号：',
    '   ✔ = 已完成    ▶ = 进行中    ⛔ = 卡住',
    '3. 行颜色：',
    '   🔴 红色 = 危险（剩余<7天且进度<60%，或已逾期）',
    '   🟡 黄色 = 注意（剩余<14天且进度<40%）',
    '   ⬜ 白色 = 正常',
    '4. "累计产量"来自订单详情页"生产进度"Tab 的日报汇总',
    '5. 空白的"生产部备注"列给你们自由填写，填完可以直接发给跟单',
    '6. 如需更新进度，请通知跟单在系统里提交生产日报，此表下次会同步',
  ];
  notes.forEach((line, i) => {
    const c = ws2.getCell(`A${i + 1}`);
    c.value = line;
    if (i === 0) c.font = { bold: true, size: 14 };
    else if (line.startsWith('   ')) c.font = { size: 11, color: { argb: 'FF6B7280' } };
  });

  const buffer = await wb.xlsx.writeBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const fileName = `生产跟单表_${new Date().toISOString().slice(0, 10)}.xlsx`;

  return { base64, fileName };
}
