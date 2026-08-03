/**
 * PO 解析结果的数量自洽自检(2026-08-03 事故后加)。
 *
 * 背景:po-parser 的 prompt 里要求 AI「自检 各尺码之和 = 该色总数量」,
 * 但那只是**请求**,没有代码兜底。实际发生的:
 *   EHL PO 79042 的 31407BA —— AI 自己声明 total_qty=306,
 *   却只给出黑色 184 + 酒红 92 = 276。**它的输出自己前后矛盾**,系统照单全收,
 *   建单后订单头 816 件、明细 786 件,差 30 件。
 * 全库同类问题当时 12 张单、差额合计近 10 万件(docs/明细核对清单-20260803.md)。
 *
 * CEO 2026-08-03 定性:「填写的没错误,是系统识别出错了……AI 填入了错误的数量」。
 * 所以这不是人的疏忽,是解析质量问题 + 缺入库前自检。
 *
 * 本模块**只告警、不改数** —— 到底是款总量对还是各色之和对,得人对着 PO 判,
 * 系统替不了;但必须让人当场看见,而不是等一个月后对账才发现。
 *
 * 放在 lib/ 而不是 po-parser.ts 里,是因为后者是 'use server' 文件、只能导出 async
 * (见 [[use-server-export-guard]]),纯函数放那儿过不了构建期的规矩、也没法直接测。
 */

export interface POColorLike {
  color_cn?: string | null;
  color_en?: string | null;
  qty?: number | null;
  sizes?: Record<string, unknown> | null;
}

export interface POStyleLike {
  style_no?: string | null;
  product_name?: string | null;
  total_qty?: number | null;
  colors?: POColorLike[] | null;
}

const sumValues = (o: Record<string, unknown> | null | undefined): number =>
  Object.values(o || {}).reduce((s: number, v) => s + (Number(v) || 0), 0);

/**
 * 返回需要提示给人的数量矛盾。没有矛盾就返回空数组。
 *
 * 两层检查:
 *   ① 逐色:各尺码之和 vs 该色数量
 *   ② 款级:各色之和 vs AI 声明的款总量
 * 只在两边都 > 0 时才比 —— 一边为 0 通常是「这项没提取到」,那是另一类问题(留空),
 * 不该报成「数量对不上」,否则告警会被噪音淹掉。
 */
export function checkPOQuantityConsistency(styles: POStyleLike[] | null | undefined): string[] {
  const notes: string[] = [];
  for (const st of styles || []) {
    const label = String(st?.style_no || st?.product_name || '某款').slice(0, 24);
    const colors = Array.isArray(st?.colors) ? st.colors : [];

    for (const c of colors) {
      const sizeSum = sumValues(c?.sizes);
      const cQty = Number(c?.qty) || 0;
      if (sizeSum > 0 && cQty > 0 && sizeSum !== cQty) {
        const colorName = c?.color_cn || c?.color_en || '某色';
        notes.push(`⚠️ 数量对不上:${label} / ${colorName} 各尺码之和 ${sizeSum} ≠ 该色数量 ${cQty},请核对`);
      }
    }

    const colorSum = colors.reduce((a: number, c) => a + (Number(c?.qty) || sumValues(c?.sizes)), 0);
    const declared = Number(st?.total_qty) || 0;
    if (declared > 0 && colorSum > 0 && colorSum !== declared) {
      notes.push(
        `⚠️ 数量对不上:${label} 各色之和 ${colorSum} ≠ 款总量 ${declared}` +
        `(差 ${declared - colorSum}),多半是漏了一个颜色,请对照 PO 补齐`,
      );
    }
  }
  return notes;
}
