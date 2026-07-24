'use server';

import { createClient } from '@/lib/supabase/server';
import { qimoAI, AIRuntimeError, type FileInput, type ImageInput } from '@/lib/ai/runtime';
import { poParsedSchema } from '@/lib/ai/scenes/po-schema';

/** 上传文件最大字节数：10MB。超过后拒绝读入内存。 */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
/** 草稿恢复时间窗：超过此分钟数视为陈旧不展示。 */
const DRAFT_FRESH_MINUTES = 30;

export type GarmentCategory = 'pants' | 'tops' | 'dress' | 'outerwear' | 'other';

export interface POStyleData {
  style_no: string;
  product_name: string;
  material: string;
  fabric_weight: string;
  total_qty: number;
  colors: {
    color_cn: string;
    color_en: string;
    qty: number;
    sizes: Record<string, number>;
    /** 每色独立的客户包装说明（如"一套一个小包袋，6套一中包"），可选 */
    packaging?: string;
  }[];
  packaging: string;
  quality_notes: string;
  sample_requirements: string;
  /** 单件用量 — 上印 "款式评语" 上方的黄色行，如 "280克直贡呢 1.2平方 0.346公斤" */
  unit_consumption?: string;
  measurements?: {
    label: string;
    values: Record<string, string>;
  }[];
}

export interface POParsedData {
  order_no: string;
  customer_name: string;
  delivery_date: string;
  order_date: string;
  garment_category?: GarmentCategory;
  styles: POStyleData[];
  trims: {
    name: string;
    position: string;
    notes: string;
  }[];
  size_labels: string[];
  confidence_notes: string[];
  /** 生产单右上「注意」框文字（业务员可编辑）。
   * 默认："注意：大货数量不能少出，也不能多出。交货期不能晚，延期会扣款。大货尺寸千万不能做小。" */
  warning_notes?: string;
  unit_price?: number;
  currency?: string;
  total_amount?: number;
  incoterm?: string;
  payment_terms?: string;
}

const SYSTEM_PROMPT = `你是绮陌服饰的订单录入专家。你正在为一张【生产单/生产任务单】提取数据。

⚠️ 最重要的原则:客户 PO 的格式、语言、排版千差万别——中文订货合同、英文 PO、邮件正文、
拍照、图片、老式 Excel 都有,同一个信息在不同客户那里放在完全不同的位置和叫法。
你的职责不是"套某个客户的模板",而是**不管来源长什么样,都把它统一映射到下面生产单需要的
固定字段**。以"生产单需要什么"为准,不受 PO 排版影响。看不懂/找不到的字段留空并写进
confidence_notes,绝不编造、不猜。

生产单需要的固定字段(逐个去 PO 里找,不管它叫什么、在哪):
- 订单头:PO号/订单号、客户名、下单日期、交期(出货日期)
- 每款:款号、品名、面料/原料成分、面料克重
- 每款每色:颜色(中文+英文原文)、色号/颜色参考、**每个尺码的件数**、该色总数量
- 要求类(生产单要印给工厂):包装方法、质量要求、产前样/船样要求、尺寸表(各码测量值)、辅料清单
- 价格(如有):单价、币种、总金额、贸易条款、付款条款

要求：
0. 常见字段中英对照(仅供识别,不是唯一叫法):
   Style#/Style No/Item/款号/货号 → style_no;Description/Item Name/品名/名称 → product_name;
   Color/Colour/Colorway/颜色 → color;Qty/Quantity/Units/数量/总数 → qty;
   Size Breakdown/Size Ratio/配比/尺码横排 → 尺码;Delivery/Ship/Cancel Date/交期/出货日期 → delivery_date;
   PO#/Order No/订单号 → order_no;Fabric/Material/Composition/面料/布面/原料 → material。
   品牌(Brand,如 otos-BP)如遇到,写进对应款的 product_name 或 confidence_notes 备注。
1. 仔细识别每个款式/SKU的颜色、尺码、数量。一份 PO 可能多款多色,逐个提取,别漏。
2. 尺码标签可能是 S/M/L/XL、加大码 1X/2X/3X/4X、数字码 2/4/6/8/28/30、F/均码 等——**原样提取**,别改名。
3. 如果PO是英文，颜色名请同时提供中文翻译(color_cn)和英文原文(color_en);中文 PO 则 color_en 可留空。
4. 找不到的字段：填空字符串或0，并在confidence_notes中说明是哪个字段没找到。
5. packaging、quality_notes、sample_requirements 等要求类信息,PO 里有就抓全(常在表格下方的
   "包装方法/质量要求/注意事项/船头版/布面要求"等段落),没有就留空。
6. 数量必须是纯数字，不要带单位。
7. 判断服装品类（pants/tops/dress/outerwear/other）。
8. 尺寸表/测量数据（measurements）——**只在 PO 里真的印着一张"部位×各尺码测量数值"的尺寸表时才提取，且必须逐个数值照抄，不许四舍五入不许补全**：
   - 表里确有「胸围/腰围/臀围/衣长/袖长…」等部位对应各尺码的实际数值 → 照抄(label=部位名，values=[{size:尺码,value:数值}])。
   - **PO 里没有尺寸表 → measurements 必须返回空数组 []。绝对禁止根据款式类型/经验/常识臆造、补齐或"帮忙生成"任何测量值。**
     这张表会原样印进生产任务单发给工厂照着裁做，编造的尺寸会直接导致做错货、整批报废——宁可空着让人补，也绝不能编。
   - 测量部位必须与品类吻合(短裤/裤子不会有胸围、肩宽、袖长这类上衣部位)；若发现对不上或拿不准，一律留空 [] 并在 confidence_notes 注明「PO无尺寸表，measurements 未提取」。
9. 单件用量（unit_consumption）：如果PO提到"单耗/用量/每件"加面料数据（如"1.2平方"、"0.346公斤"），合并成一个字符串返回；找不到就留空。
10. 每色客户包装（colors[].packaging）：如果PO对不同颜色有不同包装要求,分别提取到对应 color 的 packaging 字段。
11. 尺码件数换算（最关键！sizes 必须是"件数",不是比例）：
   - **若 PO 表里已直接给了每个尺码的件数(如列 1X=300, 2X=150, 3X=150)→ 就用这些件数**,
     并自检 各尺码之和 = 该色总数量,对不上在 confidence_notes 说明。此时哪怕另有一行"配比:1X-3X=211"
     也只作参考,不要拿配比去覆盖已有的件数。
   - **若只给了配比没给件数**(如表头/备注写 "配比 S:M:L:XL=1:2:2:1" 或 "1X-3X=211",或尺码下一行是小数字
     1/2/2/1)→ 按比例把该色总数量分摊到各尺码,填分摊后的整数件数,必须满足 各尺码之和 = 该色 qty
     (余数补给占比最大的码)。例:qty=3600、配比1:2:2:1 → {"S":600,"M":1200,"L":1200,"XL":600};
     "1X-3X=211" 表示 1X:2X:3X=2:1:1。
   - 完全没有尺码信息：sizes 留空数组[]，不要编造。

日期解析规则（重要！）：
- Excel的日期序列号（如46124）= 从1900-01-01起的天数，请转换为 YYYY.MM.DD
- 美式日期 MM/DD/YYYY 转为 YYYY.MM.DD
- 英式日期 DD/MM/YYYY 转为 YYYY.MM.DD（如果月份>12则按此格式）
- "Jan 15, 2026" 转为 "2026.01.15"
- 如不确定格式，在 confidence_notes 中注明

价格提取（重要！）：
- unit_price: 单价（数字），必须提取
- currency: 货币（USD/EUR/GBP/RMB等）
- total_amount: 总金额（如有）
- incoterm: 贸易条款（FOB/DDP/CIF等，如PO中注明）
- payment_terms: 付款条款（如T/T 30% deposit, 70% before shipment）

返回严格的JSON格式（不要markdown代码块包裹）：
{
  "order_no": "客户PO号",
  "customer_name": "客户名称",
  "delivery_date": "交期 YYYY.MM.DD",
  "order_date": "下单日期 YYYY.MM.DD",
  "garment_category": "pants",
  "styles": [
    {
      "style_no": "款号",
      "product_name": "品名（中文）",
      "material": "原料成分（如88%涤纶，12%氨纶）",
      "fabric_weight": "面料克重（如280克仿锦）",
      "total_qty": 5130,
      "colors": [
        {
          "color_cn": "黑色",
          "color_en": "BLACK",
          "qty": 2010,
          "sizes": [{ "label": "S", "qty": 670 }, { "label": "M", "qty": 670 }, { "label": "L", "qty": 670 }],
          "packaging": ""
        }
      ],
      "packaging": "包装要求描述",
      "quality_notes": "质量要求/工艺备注",
      "sample_requirements": "产前样/船样要求",
      "measurements": [
        { "label": "腰围", "values": [{ "size": "S", "value": "12.5" }, { "size": "M", "value": "13.5" }] },
        { "label": "臀围", "values": [{ "size": "S", "value": "17.5" }, { "size": "M", "value": "18.5" }] }
      ]
    }
  ],
  "trims": [
    { "name": "辅料名", "position": "位置说明", "notes": "备注" }
  ],
  "size_labels": ["S", "M", "L"],
  "unit_price": 5.80,
  "currency": "USD",
  "total_amount": 29754.00,
  "incoterm": "FOB",
  "payment_terms": "T/T 30% deposit, 70% before shipment",
  "confidence_notes": ["PO中未找到面料克重信息", "交期日期可能需要确认"]
}`;

export async function parsePO(
  formData: FormData,
  orderId?: string,
): Promise<{ ok: boolean; data?: POParsedData; error?: string; draftId?: string }> {
  // 鉴权 + 配额：之前直接调 Anthropic，任何拿到 server action 端点的人都能刷
  // API 配额（按 Sonnet 4 价格一次几毛钱，一天可烧几百）
  const { guardAICall, logAICall } = await import('@/lib/ai/rate-limit');
  const guard = await guardAICall('po_parse', orderId);
  if (!guard.ok) return { ok: false, error: guard.error };

  const file = formData.get('file') as File | null;
  if (!file) return { ok: false, error: '请上传文件' };

  // P0-3: 文件大小限制 —— 避免大文件 OOM + AI token 爆炸
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      error: `文件 ${mb}MB 超出 ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB 上限。请压缩后重传，或拍图上传。`,
    };
  }

  // 省 token(2026-07-03):同名同大小文件 30 分钟内已解析过 → 直接复用冻结草稿,零 AI 调用。
  // 覆盖:上传后重试、误操作二次上传、建单失败后重传同一 PO。
  try {
    const supabaseCache = await createClient();
    const { data: { user: cacheUser } } = await supabaseCache.auth.getUser();
    if (cacheUser) {
      const cutoff = new Date(Date.now() - DRAFT_FRESH_MINUTES * 60 * 1000).toISOString();
      const { data: cached } = await (supabaseCache.from('po_parse_drafts') as any)
        .select('id, parsed_json')
        .eq('user_id', cacheUser.id)
        .eq('file_name', file.name)
        .eq('file_size_bytes', file.size)
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .limit(1).maybeSingle();
      if (cached?.parsed_json) {
        console.log('[parsePO] 命中冻结草稿,跳过 AI 调用(零token):', file.name);
        return { ok: true, data: cached.parsed_json as POParsedData, draftId: cached.id };
      }
    }
  } catch { /* 缓存查询失败不阻断,继续走 AI */ }

  const startedAt = Date.now();
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileType = file.type;
    const fileName = file.name.toLowerCase();
    let prompt = '';
    let image: ImageInput | undefined;
    let inputFile: FileInput | undefined;

    if (fileType.startsWith('image/') || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') || fileName.endsWith('.png')) {
      const mediaType = fileType.startsWith('image/') ? fileType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' : 'image/jpeg';
      image = { mediaType, base64: buffer.toString('base64'), detail: 'high' };
      prompt = '请解析这个客户PO图片，提取订单信息。';
    } else if (fileName.endsWith('.pdf')) {
      inputFile = { filename: file.name, mediaType: 'application/pdf', base64: buffer.toString('base64') };
      prompt = '请解析这个客户PO文件，提取订单信息。';
    } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || fileName.endsWith('.csv')) {
      const textContent = await excelToText(buffer, fileName);
      prompt = `请解析以下客户PO内容，提取订单信息：\n\n${textContent}`;
    } else {
      return { ok: false, error: `不支持的文件格式：${file.type}。请上传 Excel、PDF 或图片文件。` };
    }

    const result = await qimoAI.generateObject({
      scene: 'order.po.parse', capability: 'structured-extraction',
      logicalModel: 'qimo.structured-extraction', riskLevel: 'high',
      system: SYSTEM_PROMPT, prompt, schema: poParsedSchema, image, file: inputFile,
      timeoutMs: 45_000, maxOutputTokens: 8192, fallback: 'disabled',
    });
    const parsed = result.data;

    // 确定性兜底(2026-07-11):prompt 已强约束不许臆造尺寸,这里再补一道确定性网 ——
    // 若「品类/款名是下装(裤/短裤/legging)」却给了只属上衣的测量部位(胸围/肩宽/袖长/领围…),
    // 判定为 AI 臆造,自动丢弃这些行(零误伤:下装本就没有这些部位),防假尺寸印进生产单。
    try {
      const UPPER_ONLY = /胸围|胸宽|前胸|后胸|肩宽|全肩|落肩|袖长|袖口|袖笼|袖窿|夹圈|领围|领宽|领深|chest|bust|shoulder|sleeve|armhole|collar|cuff/i;
      const BOTTOM_NAME = /裤|短裤|长裤|legging|pants|shorts|trouser/i;
      const catBottom = /pants|shorts|bottom|trouser/i.test(String((parsed as any)?.garment_category || ''));
      let dropped = 0;
      for (const st of ((parsed as any)?.styles || [])) {
        if (!Array.isArray(st?.measurements) || st.measurements.length === 0) continue;
        const isBottom = catBottom || BOTTOM_NAME.test(`${st?.product_name || ''} ${st?.style_no || ''}`);
        if (!isBottom) continue;
        const kept = st.measurements.filter((m: any) => !UPPER_ONLY.test(String(m?.label || '')));
        dropped += st.measurements.length - kept.length;
        st.measurements = kept;
      }
      if (dropped > 0) {
        (parsed as any).confidence_notes = [
          ...(Array.isArray((parsed as any).confidence_notes) ? (parsed as any).confidence_notes : []),
          `已自动丢弃 ${dropped} 条与品类不符的测量行(下装却出现胸围/肩宽/袖长等上衣部位,疑似AI臆造),请核对尺寸表`,
        ];
      }
    } catch { /* 兜底本身绝不阻断解析 */ }

    logAICall('po_parse', orderId || null, 'success', Date.now() - startedAt,
      `${result.metadata.provider}/${result.metadata.model}; fallback=${result.metadata.fallbackUsed}; trace=${result.metadata.traceId}`).catch(() => {});

    // P0-1: 解析成功后落库，防关闭/刷新丢数据
    const draftId = await savePOParseDraft(orderId, file.name, file.size, parsed).catch((e) => {
      console.warn('[parsePO] save draft failed (non-blocking):', e?.message);
      return undefined;
    });

    // 冻结底档(2026-07-10 用户拍板:解析后要冻结,方便以后其他地方提取——生产单/辅料/要求类
    // 都从 orders.po_parse_snapshot 读)。首冻不覆盖:已有底档不动(人工「重新冻结」按钮才覆盖);
    // 走 user session 受 RLS 管;失败不阻断解析结果返回。
    // await 而非 fire-and-forget:Vercel serverless 响应返回后悬空 Promise 会被掐,冻结必须落地。
    if (orderId) {
      try { await freezeSnapshotIfEmpty(orderId, parsed); }
      catch (e: any) { console.warn('[parsePO] freeze snapshot failed (non-blocking):', e?.message); }
    }

    return { ok: true, data: parsed, draftId };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[parsePO] Error:', message);
    const runtimeError = err instanceof AIRuntimeError ? err : undefined;
    const runtimeCause = runtimeError?.cause as { lastError?: AIRuntimeError } | undefined;
    const isTimeout = runtimeError?.code === 'TIMEOUT' || runtimeCause?.lastError?.code === 'TIMEOUT';
    logAICall('po_parse', orderId || null, isTimeout ? 'timeout' : 'error', Date.now() - startedAt, message.slice(0, 200)).catch(() => {});
    const lastCode = runtimeCause?.lastError?.code;
    const code = lastCode || runtimeError?.code;
    // 2026-07-22:Anthropic 余额不足返回 400 → 归类成 PROVIDER_ERROR(不在下面识别列表)→ 以前
    // 掉进末尾兜底显示「PO 识别失败,请改用手工录入」,把人误导去查文件格式。挖底层 provider 报文,
    // 命中余额/计费关键词就明说"账户余额不足",并给 PROVIDER_ERROR/TRANSIENT_PROVIDER 兜底成"AI 服务不可用"。
    const rawProviderMsg = String(
      (runtimeCause?.lastError?.cause as { message?: string } | undefined)?.message
      ?? (runtimeError?.cause as { message?: string } | undefined)?.message
      ?? message ?? '',
    );
    // 账户级用量上限(Anthropic 控制台设的月度 usage limit)触顶,报文形如
    // "You have reached your specified API usage limits. You will regain access on YYYY-MM-DD…"
    const isUsageLimit = /usage limit|regain access|spending limit|monthly limit/i.test(rawProviderMsg);
    const isBilling = /credit balance|billing|insufficient|too low|quota|余额/i.test(rawProviderMsg);
    const regain = rawProviderMsg.match(/regain access on\s*([0-9-]+(?:\s*at\s*[0-9:]+\s*UTC)?)/i)?.[1];
    const safe = isUsageLimit
      ? `已达 Anthropic 账户用量上限（月度限额），${regain ? `${regain} 自动恢复；` : ''}请管理员到 Anthropic 控制台 Settings → Limits 调高或移除限额后即可恢复；可先手工录入创建订单`
      : isBilling
      ? 'AI 服务账户余额不足，请管理员到 Anthropic 控制台（Plans & Billing）充值后重试；可先手工录入创建订单'
      : code === 'MODEL_NOT_CONFIGURED' || code === 'AUTHENTICATION'
        ? 'AI 配置缺失，请联系管理员检查模型或访问权限'
        : code === 'RATE_LIMIT'
          ? 'AI 服务当前请求过多，请稍后重试'
          : code === 'PROVIDER_UNAVAILABLE' || code === 'ALL_PROVIDERS_FAILED' || code === 'PROVIDER_ERROR' || code === 'TRANSIENT_PROVIDER'
            ? 'AI 服务暂时不可用，请稍后重试或改用手工录入'
            : code === 'SCHEMA_MISMATCH' || code === 'INVALID_JSON' || code === 'EMPTY_RESPONSE' || code === 'REFUSAL'
              ? 'PO 内容提取失败，请核对文件后重试或改用手工录入'
              : isTimeout ? 'PO 识别超时，请稍后重试或改用手工录入' : 'PO 识别失败，请改用手工录入';
    return { ok: false, error: safe };
  }
}

// ──────────────────────────────────────────────────────────
// P0-1: 草稿持久化（po_parse_drafts 表）
// ──────────────────────────────────────────────────────────

/**
 * 内部辅助:解析成功后把 AI 原文冻结到 orders.po_parse_snapshot(只读底档,别处提取用)。
 * 只在底档为空时写(首冻);已有底档不静默覆盖——人工走「重新冻结」(refreezePoParseSnapshot)。
 * 走 user session(RLS 管权限:无权改该订单的人写不进,静默跳过)。
 */
async function freezeSnapshotIfEmpty(orderId: string, parsed: POParsedData): Promise<void> {
  const supabase = await createClient();
  const { data: ord } = await (supabase.from('orders') as any)
    .select('id, po_parse_snapshot').eq('id', orderId).maybeSingle();
  if (!ord || (ord as any).po_parse_snapshot) return;   // 订单不存在/已有底档 → 不动
  const { error } = await (supabase.from('orders') as any)
    .update({ po_parse_snapshot: parsed, po_parse_snapshot_at: new Date().toISOString() })
    .eq('id', orderId);
  if (error) console.warn('[freezeSnapshotIfEmpty] update failed:', error.message);
  else console.log('[parsePO] 底档已冻结到订单:', orderId);
}

/**
 * 内部辅助：把解析结果存入草稿表。返回 draftId。
 * RLS 已保证 user_id 必须 = auth.uid()，service-role 不在此用，走 user session。
 */
async function savePOParseDraft(
  orderId: string | undefined,
  fileName: string,
  fileSize: number,
  parsedJson: POParsedData,
): Promise<string | undefined> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return undefined;
  const { data, error } = await (supabase.from('po_parse_drafts') as any)
    .insert({
      user_id: user.id,
      order_id: orderId || null,
      file_name: fileName,
      file_size_bytes: fileSize,
      parsed_json: parsedJson,
    })
    .select('id')
    .single();
  if (error) {
    console.warn('[savePOParseDraft] insert failed:', error.message);
    return undefined;
  }
  return data?.id;
}

/**
 * Server Action：取当前用户在此订单上最近 30 分钟内的草稿（最新一条）。
 * 用于 Modal 打开时检测"是否有未完成的解析草稿"。
 */
export async function getRecentPOParseDraft(orderId: string): Promise<{
  ok: boolean;
  draft?: {
    id: string;
    parsed_json: POParsedData;
    file_name: string | null;
    age_minutes: number;
  };
  error?: string;
}> {
  if (!orderId) return { ok: false, error: 'orderId 不能为空' };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '未登录' };

  const cutoff = new Date(Date.now() - DRAFT_FRESH_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await (supabase.from('po_parse_drafts') as any)
    .select('id, parsed_json, file_name, updated_at')
    .eq('user_id', user.id)
    .eq('order_id', orderId)
    .gte('updated_at', cutoff)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn('[getRecentPOParseDraft] query failed:', error.message);
    return { ok: false, error: error.message };
  }
  if (!data) return { ok: true };

  const ageMs = Date.now() - new Date(data.updated_at).getTime();
  return {
    ok: true,
    draft: {
      id: data.id,
      parsed_json: data.parsed_json,
      file_name: data.file_name,
      age_minutes: Math.round(ageMs / 60000),
    },
  };
}

/**
 * Server Action：用户在 preview 中编辑后关闭 Modal 时调用，把当前状态盖回草稿。
 */
export async function updatePOParseDraft(
  draftId: string,
  parsedJson: POParsedData,
): Promise<{ ok: boolean; error?: string }> {
  if (!draftId) return { ok: false, error: 'draftId 不能为空' };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: '未登录' };

  const { error } = await (supabase.from('po_parse_drafts') as any)
    .update({ parsed_json: parsedJson, updated_at: new Date().toISOString() })
    .eq('id', draftId)
    .eq('user_id', user.id); // RLS 已保护，这里双保险
  if (error) {
    console.warn('[updatePOParseDraft] update failed:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Server Action：生成 Excel 成功 / 用户主动丢弃草稿时调用。
 */
export async function deletePOParseDraft(draftId: string): Promise<{ ok: boolean }> {
  if (!draftId) return { ok: false };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  await (supabase.from('po_parse_drafts') as any)
    .delete()
    .eq('id', draftId)
    .eq('user_id', user.id);
  return { ok: true };
}

async function excelToText(buffer: Buffer, fileName: string): Promise<string> {
  // 统一走 SheetJS:exceljs 读不了老 .xls(BIFF)会静默返回空表 → PO 被读成空。
  const { readWorkbookText } = await import('@/lib/services/excel-read');
  return readWorkbookText(buffer, fileName);
}
