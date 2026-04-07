/**
 * 邮件-订单深度对比引擎
 *
 * 当邮件匹配到订单后，拿订单全量数据做逐项对比：
 * - 数量对比
 * - 交期对比
 * - 颜色/尺码对比
 * - 客户要求 vs 系统记录
 * - 订单状态 vs 邮件预期
 * - 生产进度 vs 客户催促
 */

export interface CompareResult {
  hasDiscrepancy: boolean;
  discrepancies: Array<{
    field: string;        // 哪个字段不一致
    emailValue: string;   // 邮件中提到的
    orderValue: string;   // 系统中的
    severity: 'high' | 'medium' | 'low';
    suggestion: string;   // 建议业务员做什么
  }>;
  summary: string;        // 一句话总结
}

/**
 * 深度对比邮件内容与订单数据
 *
 * @param mailInboxId 可选 — 传入则把差异持久化到 email_order_diffs 表
 *                     便于追溯"差异是否解决"
 */
export async function deepCompareEmailWithOrder(
  supabase: any,
  emailAnalysis: {
    subject: string;
    body: string;
    fromEmail: string;
    quantityMentioned: number | null;
    deliveryMentioned: string | null;
    changes: Array<{ type: string; description: string }>;
    sampleRelated: boolean;
  },
  orderId: string,
  mailInboxId?: string,
): Promise<CompareResult> {
  const defaultResult: CompareResult = { hasDiscrepancy: false, discrepancies: [], summary: '无明显差异' };

  // 1. 获取订单完整数据
  const { data: order } = await supabase
    .from('orders')
    .select('order_no, customer_name, quantity, style_count, color_count, factory_date, etd, warehouse_due_date, cancel_date, order_type, incoterm, factory_name, po_number, style_no, notes, sample_status, lifecycle_status, updated_at')
    .eq('id', orderId)
    .single();

  if (!order) return defaultResult;

  // 2. 获取里程碑进度
  const { data: milestones } = await supabase
    .from('milestones')
    .select('name, status, due_at, actual_at, step_key')
    .eq('order_id', orderId)
    .order('due_at', { ascending: true });

  const doneCount = (milestones || []).filter((m: any) => m.status === '已完成' || m.status === 'done').length;
  const totalCount = (milestones || []).length;
  const overdueNodes = (milestones || []).filter((m: any) =>
    m.status !== '已完成' && m.status !== 'done' && m.due_at && new Date(m.due_at) < new Date()
  ).map((m: any) => m.name);

  // 3. 获取客户记忆（已记录的要求）
  const { data: memories } = await supabase
    .from('customer_memory')
    .select('content, category, created_at')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(10);

  // 4. 构建对比上下文让 AI 做深度比对
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();

    const orderContext = [
      `订单号：${order.order_no}`,
      `客户PO：${order.po_number || '未填'}`,
      `数量：${order.quantity || '未填'}件`,
      `款数：${order.style_count || '未填'}款`,
      `颜色数：${order.color_count || '未填'}色`,
      `出厂日期：${order.factory_date || '未设'}`,
      `ETD/离港：${order.etd || '未设'}`,
      `到仓日期：${order.warehouse_due_date || '未设'}`,
      `Cancel Date：${order.cancel_date || '未设'}`,
      `工厂：${order.factory_name || '未定'}`,
      `订单状态：${order.lifecycle_status}`,
      `进度：${doneCount}/${totalCount} 已完成`,
      overdueNodes.length > 0 ? `逾期节点：${overdueNodes.join('、')}` : '无逾期节点',
      `备注：${order.notes || '无'}`,
      order.sample_status ? `样品状态：${order.sample_status}` : '',
    ].filter(Boolean).join('\n');

    const memoryContext = (memories || []).length > 0
      ? (memories || []).map((m: any) => `[${m.category}] ${m.content}`).join('\n')
      : '无历史记录';

    const milestoneContext = (milestones || []).slice(0, 15).map((m: any) => {
      const status = m.status === '已完成' ? '✅' : m.status === '进行中' ? '🔵' : '⬜';
      return `${status} ${m.name} (截止:${m.due_at?.slice(0, 10) || '?'} ${m.actual_at ? '实际:' + m.actual_at.slice(0, 10) : ''})`;
    }).join('\n');

    const prompt = `你是外贸服装订单管理系统的质量审计员。请严格逐项对比以下邮件内容和系统中的订单数据，找出所有不一致的地方。

## 客户邮件
发件人：${emailAnalysis.fromEmail}
主题：${emailAnalysis.subject}
正文：
${emailAnalysis.body.slice(0, 2000)}

## 系统中的订单数据
${orderContext}

## 订单进度
${milestoneContext}

## 已记录的客户要求
${memoryContext}

## 请严格检查以下方面：
1. **数量**：邮件提到的数量与系统中的 ${order.quantity || '未填'} 是否一致？
2. **交期**：邮件提到的交期与系统中的出厂日 ${order.factory_date || '未设'} / ETD ${order.etd || '未设'} 是否一致？
3. **颜色/尺码/款式**：邮件中提到的与系统记录是否一致？
4. **客户要求**：邮件中的特殊要求是否已在系统中记录？
5. **订单状态**：客户邮件的预期（如催货、确认样品）与系统中的实际进度是否匹配？
6. **新增变更**：邮件中有无新的变更请求尚未在系统中处理？

返回JSON：
{
  "hasDiscrepancy": true/false,
  "discrepancies": [
    {
      "field": "数量/交期/颜色/要求/状态/变更",
      "emailValue": "邮件中提到的内容",
      "orderValue": "系统中的内容",
      "severity": "high/medium/low",
      "suggestion": "建议业务员做什么（具体、可执行）"
    }
  ],
  "summary": "一句话总结比对结果"
}

严格比对！不要遗漏！如果确实没有差异就返回空数组。
只返回JSON。`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      const result: CompareResult = {
        hasDiscrepancy: parsed.hasDiscrepancy || false,
        discrepancies: (parsed.discrepancies || []).map((d: any) => ({
          field: d.field || '',
          emailValue: d.emailValue || '',
          orderValue: d.orderValue || '',
          severity: d.severity || 'medium',
          suggestion: d.suggestion || '',
        })),
        summary: parsed.summary || '对比完成',
      };

      // ── 差异持久化：可追溯"差异是否解决" ──
      if (mailInboxId && result.hasDiscrepancy && result.discrepancies.length > 0) {
        try {
          const rows = result.discrepancies.map(d => ({
            mail_inbox_id: mailInboxId,
            order_id: orderId,
            field: d.field,
            email_value: (d.emailValue || '').slice(0, 1000),
            order_value: (d.orderValue || '').slice(0, 1000),
            severity: d.severity,
            suggestion: (d.suggestion || '').slice(0, 1000),
          }));
          // upsert: dedup_key 已存在 → 跳过（保留最早检测时间和已有 status）
          await supabase.from('email_order_diffs').upsert(rows, {
            onConflict: 'dedup_key',
            ignoreDuplicates: true,
          });
        } catch (persistErr: any) {
          console.error('[emailOrderCompare] persist diff failed:', persistErr?.message);
        }
      }

      return result;
    }
  } catch (err: any) {
    console.error('[emailOrderCompare] AI error:', err?.message);
  }

  return defaultResult;
}
