'use server';

/**
 * 拍照解析 — 生产 QC / 入库 单据
 *
 * 业务背景：
 *   生产/质检/仓管在车间外勤，单据多为手写或纸质表格。打开电脑录入门槛高，
 *   经常「实际做了但忘了点」。本 action 接收手机拍的照片，用 Claude Vision
 *   识别关键字段，返回 { [checklist_key]: value } 让前端一键填表。
 *
 * 不直接写库 — 由前端用户确认后走原有的 markMilestoneDone 路径，保证审计、
 * 权限、状态机一致。这里只是把「打字录入」改成「拍照 + 确认」。
 *
 * 支持的节点（按 checklist.ts 的 key 输出）：
 *   - mid_qc_check         中查报告
 *   - final_qc_check       尾查报告（AQL）
 *   - finished_goods_warehouse  成品入库（数量 + 日期）
 *
 * 模型：Claude Sonnet 4（vision），与 po-parser 一致
 */

import Anthropic from '@anthropic-ai/sdk';
import { guardAICall, logAICall } from '@/lib/ai/rate-limit';

export interface PhotoParseResult {
  ok: boolean;
  fields?: Record<string, string | number | null>;
  /** 置信度备注，让用户重点核对 */
  notes?: string[];
  /** AI 看到的整体描述（无法对齐字段时也能给点参考） */
  summary?: string;
  error?: string;
}

const PROMPTS: Record<string, { schema: string; instruction: string }> = {
  mid_qc_check: {
    instruction: '这是一份服装订单的中期验货单（中查报告），请提取数据。',
    schema: `{
  "qc_date": "YYYY-MM-DD（验货日期）",
  "qty_completed": 数字（已完成数量，件）,
  "qc_progress_pct": 数字（完成进度百分比 0-100）,
  "size_pass_rate": "100%合格" | "90%以上" | "80%以上" | "低于80%",
  "size_deviation": "超差部位文字描述，无填空字符串",
  "color_diff": "无色差" | "件间轻微色差" | "与封样有色差",
  "workmanship": "优良" | "一般(有小问题)" | "较差(问题较多)",
  "main_issues": "主要问题描述",
  "zipper_button": "正常" | "有问题" | "不适用",
  "print_embroidery": "正常" | "有脱落风险" | "不适用",
  "mid_qc_result": "继续生产" | "需整改后继续" | "需停产整改",
  "rectification": "整改要求"
}`,
  },
  final_qc_check: {
    instruction: '这是一份服装订单的尾期验货报告（AQL 抽检），请提取数据。',
    schema: `{
  "final_qc_date": "YYYY-MM-DD（验货日期）",
  "total_qty": 数字（验货总数）,
  "aql_standard": "AQL 1.5" | "AQL 2.5" | "AQL 4.0" | "客户指定标准",
  "sample_qty": 数字（抽检数量）,
  "check_size": "合格" | "不合格",
  "check_workmanship": "合格" | "不合格",
  "check_appearance": "合格" | "不合格",
  "check_color": "合格" | "不合格",
  "check_function": "合格" | "不合格" | "不适用",
  "critical_defects": 数字,
  "major_defects": 数字,
  "minor_defects": 数字,
  "defect_desc": "缺陷描述",
  "final_result": "PASS" | "PENDING（待整改复验）" | "FAIL（不通过）",
  "rectification": "整改要求"
}`,
  },
  finished_goods_warehouse: {
    instruction: '这是一份成品入库单，请提取入库信息。',
    schema: `{
  "warehouse_date": "YYYY-MM-DD（入库日期）",
  "received_qty": 数字（入库件数）,
  "carton_count": 数字（箱数，无则 null）,
  "warehouse_location": "仓库/库位说明",
  "receiver": "收货人/签收人",
  "remarks": "其他备注（破损、短缺等）"
}`,
  },
};

export async function parseProductionPhoto(
  base64Image: string,
  mediaType: string,
  stepKey: string,
  orderId: string,
): Promise<PhotoParseResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: 'AI 服务未配置，请联系管理员' };

  // 鉴权 + 限速 — 统一走 rate-limit helper（之前自己实现的版本没限速）
  const guard = await guardAICall('photo_ocr', orderId);
  if (!guard.ok) return { ok: false, error: guard.error };

  const cfg = PROMPTS[stepKey];
  if (!cfg) return { ok: false, error: `节点「${stepKey}」暂不支持拍照解析` };

  if (!base64Image || base64Image.length < 100) {
    return { ok: false, error: '图片数据为空' };
  }
  if (base64Image.length > 8 * 1024 * 1024) {
    // ~6MB 原始图片转 base64 后约 8MB
    return { ok: false, error: '图片太大（> 6MB），请压缩后再传' };
  }
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const normalizedMedia = allowed.includes(mediaType) ? mediaType : 'image/jpeg';
  const startedAt = Date.now();

  const systemPrompt = `你是服装外贸订单的单据识别专家。${cfg.instruction}

返回严格 JSON（不要 markdown 代码块包裹），格式如下：
{
  "fields": ${cfg.schema},
  "summary": "一句话总结照片内容（10-30字）",
  "notes": ["低置信度的字段提示，例：『手写不清，数量需核对』"]
}

规则：
- 字段值找不到或不确定 → 填 null（不要瞎猜）
- 数字字段必须是数字，不带单位（"500 件" → 500）
- 日期统一 YYYY-MM-DD
- 字段名严格按 schema，不要自己改名
- notes 数组：每个低把握字段一条提示，让用户重点核对
- 只返回 JSON，前后不加任何说明`;

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create(
      {
        model: 'claude-sonnet-5', thinking: { type: 'disabled' },
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: normalizedMedia as any, data: base64Image } },
            { type: 'text', text: '请按要求识别。' },
          ],
        }],
      },
      { signal: AbortSignal.timeout(45_000) },
    );

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('');
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      logAICall('photo_ocr', orderId, 'error', Date.now() - startedAt, 'JSON parse failed').catch(() => {});
      return { ok: false, error: 'AI 返回格式异常，请重试或检查图片是否清晰' };
    }

    logAICall('photo_ocr', orderId, 'success', Date.now() - startedAt,
      `step=${stepKey} fields=${Object.keys(parsed.fields || {}).length}`).catch(() => {});

    return {
      ok: true,
      fields: parsed.fields || {},
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      summary: parsed.summary || '',
    };
  } catch (err: any) {
    const isTimeout = err?.name === 'AbortError';
    logAICall('photo_ocr', orderId, isTimeout ? 'timeout' : 'error',
      Date.now() - startedAt, err?.message?.slice(0, 200)).catch(() => {});
    if (isTimeout) return { ok: false, error: 'AI 解析超时（>45s），请换张清晰的照片' };
    return { ok: false, error: `识别失败：${err.message || String(err)}` };
  }
}
