/**
 * AI 服装质检缺陷识别
 *
 * 跟单上传验货照片 → Claude Vision 自动识别缺陷
 * 返回结构化缺陷报告：类型、位置、严重度、建议
 *
 * 支持场景：
 *   - 中查/尾查现场照片
 *   - 封样照片
 *   - 面料验收照片
 *   - 包装照片
 */

import { callClaudeJSON } from '@/lib/agent/anthropicClient';

export interface DetectedDefect {
  type: string;         // 缺陷类型
  location: string;     // 缺陷位置
  severity: 'critical' | 'major' | 'minor';
  description: string;  // 详细描述
  suggestion: string;   // 处理建议
}

export interface DefectDetectionResult {
  overall: 'pass' | 'warning' | 'fail';
  defects: DetectedDefect[];
  summary: string;        // 一句话总结
  quality_score: number;  // 0-100
  details: string;        // 详细分析
}

const GARMENT_QC_SYSTEM_PROMPT = `你是一位有15年经验的服装品控专家。你擅长从照片中识别服装缺陷。

你的检查维度：
1. **缝制工艺**：跳针、断线、线头外露、针距不均、拼缝不齐、缝份外翻
2. **面料问题**：色差（件间色差、部位色差）、织物疵点、抽丝、起球、污渍
3. **印花/绣花**：位置偏移、图案模糊、颜色不准、脱胶风险、绣花起皱
4. **辅料**：拉链不顺滑、纽扣松动、织带歪斜、魔术贴不粘
5. **整烫**：皱折、烫伤、变色、粘合衬起泡
6. **尺寸**：明显的不对称、比例失调（从照片可判断的）
7. **包装**：折叠不整齐、包装破损、标签位置不对

严重度定义：
- critical（严重）：影响穿着安全或完全无法使用（如针断在衣服里、大面积破洞）
- major（主要）：明显影响外观或功能（如明显色差、大面积跳针、拉链坏）
- minor（次要）：轻微外观问题（如小线头、轻微皱折、微小污点）

重要规则：
- 只报告你在照片中**确实看到的**问题，不要猜测
- 如果照片模糊或角度不够，说明"无法确认，建议重新拍照"
- 对于正常的缝制特征不要误报为缺陷
- 如果是一张整体照片看不清细节，给出整体评价并建议拍局部特写

返回严格JSON格式：
{
  "overall": "pass/warning/fail",
  "quality_score": 85,
  "defects": [
    {
      "type": "跳针",
      "location": "右侧腰缝",
      "severity": "major",
      "description": "右侧腰部缝线处有连续3针跳针，缝线松弛",
      "suggestion": "需要补针修复，检查该工位缝纫机张力"
    }
  ],
  "summary": "发现1个主要缺陷（跳针），整体做工一般",
  "details": "详细的质检分析..."
}`;

// 不同场景的补充提示
const SCENE_PROMPTS: Record<string, string> = {
  mid_qc: '这是中期验货（生产完成30-50%）的现场照片。重点关注：做工一致性、尺寸偏差、色差、生产问题的趋势。',
  final_qc: '这是尾期验货的照片。重点关注：成品整体质量、AQL缺陷、包装状态、是否达到出货标准。',
  sample: '这是封样/产前样照片。重点关注：与客户要求的一致性、做工水平、面料质感、尺寸准确性。',
  fabric: '这是大货面料验收照片。重点关注：色差、克重手感、织物疵点、与色卡的对比。',
  packing: '这是包装检查照片。重点关注：内包装整齐度、外箱状态、唛头正确性、吊牌洗标位置。',
  general: '这是服装质检照片。请全面检查可见的质量问题。',
};

/**
 * 分析单张照片
 */
export async function detectGarmentDefects(
  imageBase64: string,
  mimeType: string,
  scene: keyof typeof SCENE_PROMPTS = 'general',
  orderContext?: string,
): Promise<DefectDetectionResult | null> {
  const scenePrompt = SCENE_PROMPTS[scene] || SCENE_PROMPTS.general;
  const contextStr = orderContext ? `\n订单信息：${orderContext}` : '';

  const result = await callClaudeJSON<DefectDetectionResult>({
    scene: 'garment-defect-detect',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 2048,
    timeoutMs: 45_000,
    system: GARMENT_QC_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: imageBase64,
          },
        },
        {
          type: 'text',
          text: `${scenePrompt}${contextStr}\n\n请分析这张照片中的质量问题，返回JSON格式的缺陷报告。`,
        },
      ],
    }],
  });

  return result;
}

/**
 * 批量分析多张照片（合并结果）
 */
export async function detectDefectsBatch(
  images: Array<{ base64: string; mimeType: string; fileName: string }>,
  scene: keyof typeof SCENE_PROMPTS = 'general',
  orderContext?: string,
): Promise<DefectDetectionResult> {
  const allDefects: DetectedDefect[] = [];
  let worstOverall: 'pass' | 'warning' | 'fail' = 'pass';
  let totalScore = 0;
  let analyzed = 0;
  const summaries: string[] = [];

  // 最多分析5张（节省API成本）
  const toAnalyze = images.slice(0, 5);

  for (const img of toAnalyze) {
    if (!img.mimeType.startsWith('image/')) continue;
    const result = await detectGarmentDefects(img.base64, img.mimeType, scene, orderContext);
    if (!result) continue;

    analyzed++;
    allDefects.push(...result.defects);
    totalScore += result.quality_score;
    summaries.push(`${img.fileName}: ${result.summary}`);

    if (result.overall === 'fail') worstOverall = 'fail';
    else if (result.overall === 'warning' && worstOverall !== 'fail') worstOverall = 'warning';
  }

  const avgScore = analyzed > 0 ? Math.round(totalScore / analyzed) : 0;
  const critical = allDefects.filter(d => d.severity === 'critical').length;
  const major = allDefects.filter(d => d.severity === 'major').length;
  const minor = allDefects.filter(d => d.severity === 'minor').length;

  return {
    overall: worstOverall,
    defects: allDefects,
    quality_score: avgScore,
    summary: analyzed === 0
      ? '未找到可分析的图片'
      : `分析 ${analyzed} 张照片：${critical > 0 ? `严重${critical}` : ''}${major > 0 ? ` 主要${major}` : ''}${minor > 0 ? ` 次要${minor}` : ''}${allDefects.length === 0 ? '未发现明显缺陷 ✓' : ''}，质量评分 ${avgScore}/100`,
    details: summaries.join('\n'),
  };
}
