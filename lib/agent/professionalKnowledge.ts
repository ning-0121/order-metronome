/**
 * 业务员专业知识库 — "10 年外贸业务员的 tribal knowledge"
 *
 * 与 industryKnowledge.ts 的分工：
 *   - industryKnowledge.ts → 面料/品质/QC 技术知识（工厂视角）
 *   - professionalKnowledge.ts → 客户/付款/物流/时间常数（业务员视角）
 *
 * 所有知识带 `confidence` 标记：
 *   - 'confirmed'   — 已经被 CEO 或老业务员确认过
 *   - 'heuristic'   — 行业通用经验，高概率正确但没被公司内部验证
 *   - 'ask_user'    — 需要问用户确认，AI 不要直接引用
 *
 * 使用方式：
 *   1. Skill 在生成 prompt 时把相关知识注入 system prompt
 *   2. /admin/knowledge-qa 页面让 CEO 回答问题来补充 'ask_user' 条目
 *   3. 知识库的扩展走代码提交，不直接写数据库（便于 review）
 */

export type KnowledgeConfidence = 'confirmed' | 'heuristic' | 'ask_user';

export interface KnowledgeItem {
  id: string;
  category: string;
  title: string;
  content: string;
  confidence: KnowledgeConfidence;
  source?: string;
  /** 该条适用的场景标签，用于 Skill 检索 */
  tags: string[];
}

// ════════════════════════════════════════════════
// 1. 付款条款 / 国家习惯
// ════════════════════════════════════════════════

export const PAYMENT_KNOWLEDGE: KnowledgeItem[] = [
  {
    id: 'payment_us_net30',
    category: '付款条款',
    title: '美国客户常见付款方式',
    content:
      '美国客户主流：T/T 30% deposit + 70% before shipment（中小客户） 或 Net 30/60 days after B/L（大客户/品牌）。' +
      '警惕 Net 60/90：出货后要 2-3 个月才能收款，资金压力大。' +
      'L/C 在美国订单中已很少见，除非客户是新合作或金额超过 10 万美金。',
    confidence: 'heuristic',
    tags: ['us', '美国', 'payment', '付款'],
  },
  {
    id: 'payment_eu_lc',
    category: '付款条款',
    title: '欧洲客户常见付款方式',
    content:
      '欧洲（尤其德法）客户偏爱 L/C at sight 或 D/P at sight。' +
      '德国客户极度守约，L/C 条款严格，任何单据错字（哪怕标点）都可能被拒付，准备单据时要反复校对。' +
      '法国/意大利客户喜欢砍价 + 延迟付款，要预留 15-30 天 buffer。',
    confidence: 'heuristic',
    tags: ['eu', '欧洲', 'payment', '付款'],
  },
  {
    id: 'payment_sea_tt',
    category: '付款条款',
    title: '东南亚客户付款陷阱',
    content:
      '东南亚（印尼/越南/菲律宾）客户爱用 T/T 但常拖延付款。' +
      '建议：定金比例至少 40%，尾款必须见提单 copy 付清后再放单。' +
      '不要信"下周付款"— 东南亚客户的"下周"经常是"下个月"。',
    confidence: 'heuristic',
    tags: ['sea', '东南亚', 'payment', '付款'],
  },
  {
    id: 'payment_trap_openaccount',
    category: '付款条款',
    title: '⚠️ 最危险的陷阱：OA (Open Account)',
    content:
      '"发货后再付款"听起来友好，但实际等于无担保信贷。' +
      '规则：不接受任何首单 OA；老客户 OA 也要买信保（中信保/Atradius）；OA 额度不得超过公司月流水的 30%。',
    confidence: 'confirmed',
    tags: ['payment', '付款', '风险'],
  },

  // 待用户补充的空位
  {
    id: 'payment_qimo_specific',
    category: '付款条款',
    title: '[待用户补充] 绮陌公司红线付款方式',
    content: '请 CEO 告知：哪些客户必须预付多少？哪些客户可以 Net 30？',
    confidence: 'ask_user',
    tags: ['payment', 'qimo'],
  },
];

// ════════════════════════════════════════════════
// 2. 物流时间常数
// ════════════════════════════════════════════════

export const LOGISTICS_KNOWLEDGE: KnowledgeItem[] = [
  {
    id: 'shipping_us_west',
    category: '物流时间',
    title: '中国 → 美西海运',
    content:
      '中国主要港口 → 洛杉矶/长滩：标准 14-18 天（不含订舱 + 拖柜）。' +
      '完整流程：订舱 3-5 天 + 拖柜到港 2 天 + 报关 1-2 天 + 海运 14-18 天 + 美国清关 3-5 天 + 送仓 3-5 天 = **总共 27-37 天**。' +
      '节假日前后（春节/国庆/感恩节/圣诞）+7-14 天。',
    confidence: 'heuristic',
    tags: ['shipping', '物流', 'us', 'fob', 'ddp'],
  },
  {
    id: 'shipping_us_east',
    category: '物流时间',
    title: '中国 → 美东海运',
    content:
      '中国 → 纽约/萨凡纳：走巴拿马运河，海运 28-35 天。' +
      '完整交付周期 **40-50 天**，比美西多约 2 周，DDP 订单必须加足 buffer。',
    confidence: 'heuristic',
    tags: ['shipping', '物流', 'us-east', 'ddp'],
  },
  {
    id: 'shipping_eu',
    category: '物流时间',
    title: '中国 → 欧洲海运',
    content:
      '中国 → 鹿特丹/汉堡：标准 30-40 天。' +
      '完整交付周期 **40-55 天**。苏伊士运河事故或红海绕行期间 +10-20 天。',
    confidence: 'heuristic',
    tags: ['shipping', '物流', 'eu'],
  },
  {
    id: 'shipping_air',
    category: '物流时间',
    title: '空运时效',
    content:
      '中国 → 美国空运：3-5 天（门到门 5-7 天）。成本约为海运的 8-12 倍。' +
      '只在加急或样品场景使用。大货空运每公斤 ¥30-60。',
    confidence: 'heuristic',
    tags: ['shipping', '物流', '空运'],
  },
  {
    id: 'booking_lead_time',
    category: '物流时间',
    title: '订舱提前量',
    content:
      '旺季（5-10 月）需提前 **10-14 天**订舱，否则可能没舱位或被加收紧急费。' +
      '淡季（1-2 月）7 天足够。' +
      '经验法则：验货放行那天就应该让货代开始订舱，而不是等货出厂。',
    confidence: 'heuristic',
    tags: ['shipping', 'booking', '订舱'],
  },

  {
    id: 'shipping_qimo_agents',
    category: '物流时间',
    title: '[待用户补充] 绮陌常用货代和他们的真实时效',
    content: '请 CEO 列出：常用货代名称、他们的真实到港时效、哪些航线哪家最稳？',
    confidence: 'ask_user',
    tags: ['shipping', 'qimo'],
  },
];

// ════════════════════════════════════════════════
// 3. 产前样 / 打样周期
// ════════════════════════════════════════════════

export const SAMPLE_KNOWLEDGE: KnowledgeItem[] = [
  {
    id: 'sample_cycle_standard',
    category: '打样周期',
    title: '标准产前样来回节奏',
    content:
      '一轮完整产前样（从面料到寄出客户）正常需要：' +
      '面料到位 1 天 + 打版 2-3 天 + 车缝 2-3 天 + 质检 1 天 + 寄送 3-5 天 = **9-13 天**。' +
      '客户确认 3-7 天（美国快、欧洲慢）。' +
      '如果修改重做一轮 +7 天。总共算 20-25 天是安全预留。',
    confidence: 'heuristic',
    tags: ['sample', '打样', '产前样'],
  },
  {
    id: 'sample_skip_conditions',
    category: '打样周期',
    title: '什么情况可以跳过产前样',
    content:
      '可以跳过的条件（必须同时满足）：' +
      '1. 翻单（完全一样的款式、颜色、尺码表）' +
      '2. 同一家老工厂（合作 ≥ 5 单，从未出过质量问题）' +
      '3. 客户书面同意（邮件留证）' +
      '4. 订单风险评估没有"高弹面料"/"新面料"/"新颜色"标签。' +
      '不满足任何一条，哪怕节省 2 周时间也不建议跳过。',
    confidence: 'heuristic',
    tags: ['sample', '打样', '产前样', '翻单'],
  },
  {
    id: 'sample_slow_customers',
    category: '打样周期',
    title: '慢确认客户的识别',
    content:
      '有些客户确认样品需要 14-21 天（走客户内部多层审批）。' +
      '识别方法：看这个客户过去 3 单样品从寄出到批复的平均天数。' +
      '对慢客户：产前样寄出必须倒推 ≥ 25 天到大货开裁日，不然必卡。',
    confidence: 'heuristic',
    tags: ['sample', '客户', 'slow'],
  },

  {
    id: 'sample_qimo_customers',
    category: '打样周期',
    title: '[待用户补充] 绮陌主要客户的真实确认速度',
    content: '请 CEO 告知：各老客户（名单）的产前样平均确认天数？哪些是典型慢客户？',
    confidence: 'ask_user',
    tags: ['sample', 'qimo'],
  },
];

// ════════════════════════════════════════════════
// 4. 客户行为模式
// ════════════════════════════════════════════════

export const CUSTOMER_BEHAVIOR_KNOWLEDGE: KnowledgeItem[] = [
  {
    id: 'customer_urgent_signal',
    category: '客户行为',
    title: '"urgent" 邮件的真实解读',
    content:
      '客户邮件里出现 urgent/ASAP 时要分类对待：' +
      '- 美国买手/品牌：真 urgent，48 小时内没回应会投诉' +
      '- 欧洲客户：通常只是加强语气，1 周内回复即可' +
      '- 东南亚贸易商：urgent 后 3-5 天可能自己也没动静，但必须当天先回复一句确认收到' +
      '经验法则：urgent 订单在回复时一定要给一个具体 ETA（"我会在周三前给你答复"），不要只说"will check"。',
    confidence: 'heuristic',
    tags: ['customer', 'email', 'urgent'],
  },
  {
    id: 'customer_silent_signal',
    category: '客户行为',
    title: '客户突然不回邮件的信号',
    content:
      '如果一个活跃客户突然 5+ 天不回邮件，可能原因：' +
      '1. 这个联系人换工作了 — 换邮箱域名重发，或打电话' +
      '2. 客户内部在砍你订单 — 主动发封"有任何问题随时联系"的温和催单邮件' +
      '3. 客户在收你竞品报价 — 这时候不要再催价格，反而要突出你的交付能力' +
      '警告：千万不要连发 3 封催单邮件，会让客户反感。',
    confidence: 'heuristic',
    tags: ['customer', 'email', 'silent', '催单'],
  },
  {
    id: 'customer_change_request',
    category: '客户行为',
    title: '客户中期变更数量/颜色的应对',
    content:
      '如果客户在"采购已下单"后才要改数量/颜色：' +
      '1. 第一时间确认能否改（面料是否已经裁了？是否可以转拆到新订单？）' +
      '2. 绝对不要口头答应，必须邮件确认额外费用（换面料 / 报废工时 / 重新排单）' +
      '3. 写邮件时语气要"帮客户解决问题"而不是"拒绝客户"：" To confirm this change, we need to evaluate..."',
    confidence: 'heuristic',
    tags: ['customer', 'change', '变更'],
  },

  {
    id: 'customer_qimo_profiles',
    category: '客户行为',
    title: '[待用户补充] 绮陌主要客户的性格档案',
    content: '请 CEO 列 Top 10 客户：性格、沟通偏好、付款习惯、哪些话不能说、哪些细节必须注意？',
    confidence: 'ask_user',
    tags: ['customer', 'qimo', 'profile'],
  },
];

// ════════════════════════════════════════════════
// 5. 订单生命周期时间常数
// ════════════════════════════════════════════════

export const LIFECYCLE_KNOWLEDGE: KnowledgeItem[] = [
  {
    id: 'lifecycle_fob_45days',
    category: '生命周期',
    title: '标准 FOB 订单 45 天的真实分解',
    content:
      '45 天 = 订单启动 5 + 产前样 14 + 大货生产 20 + 验货出运 6。' +
      '其中最容易被低估的是"订单启动" — 客户 PO 来回确认 / 面料下单 / 颜色打样，很多订单卡在这里变成 8-10 天，把后面压缩到极限。',
    confidence: 'heuristic',
    tags: ['lifecycle', 'fob', '45'],
  },
  {
    id: 'lifecycle_ddp_extra',
    category: '生命周期',
    title: 'DDP 订单相比 FOB 额外需要的时间',
    content:
      'DDP（到港送仓）比 FOB 多：海运 15-35 天 + 清关 3-5 天 + 送仓 3-5 天 = **多 21-45 天**。' +
      '下单日到客户收货的 commitment date 要倒推 66-90 天给大货开裁时间。',
    confidence: 'heuristic',
    tags: ['lifecycle', 'ddp'],
  },
  {
    id: 'lifecycle_tight_deadline',
    category: '生命周期',
    title: '交期 < 30 天的订单能不能接',
    content:
      '30 天以内的订单接受原则：' +
      '1. 必须是翻单或老款（不用打样）' +
      '2. 必须加 10-15% 加急费' +
      '3. 面料必须是现货或 7 天内到货' +
      '4. 工厂必须有空档（打电话确认，不能只看日历）' +
      '任一不满足 → 委婉拒绝，宁可不接也别赔钱或砸招牌。',
    confidence: 'heuristic',
    tags: ['lifecycle', 'rush', '加急'],
  },
];

// ════════════════════════════════════════════════
// 汇总：导出所有知识条目
// ════════════════════════════════════════════════

export const ALL_KNOWLEDGE: KnowledgeItem[] = [
  ...PAYMENT_KNOWLEDGE,
  ...LOGISTICS_KNOWLEDGE,
  ...SAMPLE_KNOWLEDGE,
  ...CUSTOMER_BEHAVIOR_KNOWLEDGE,
  ...LIFECYCLE_KNOWLEDGE,
];

/**
 * 按标签检索相关知识 — 用于 Skill 构建 system prompt 时注入
 */
export function getKnowledgeByTags(tags: string[], opts?: {
  includeAskUser?: boolean; // 默认 false，Skill prompt 不应该包含未确认知识
  maxItems?: number;
}): KnowledgeItem[] {
  const includeAsk = opts?.includeAskUser ?? false;
  const max = opts?.maxItems ?? 10;
  const tagSet = new Set(tags.map(t => t.toLowerCase()));
  const matched = ALL_KNOWLEDGE.filter(item => {
    if (!includeAsk && item.confidence === 'ask_user') return false;
    return item.tags.some(t => tagSet.has(t.toLowerCase()));
  });
  return matched.slice(0, max);
}

/**
 * 生成一段可以塞进 system prompt 的专业知识摘要
 */
export function formatKnowledgeForPrompt(items: KnowledgeItem[]): string {
  if (items.length === 0) return '';
  return items
    .map(item => `【${item.category}｜${item.title}】\n${item.content}`)
    .join('\n\n');
}

/**
 * 获取所有待用户回答的问题 — 用于 /admin/knowledge-qa 页面
 */
export function getPendingQuestions(): KnowledgeItem[] {
  return ALL_KNOWLEDGE.filter(item => item.confidence === 'ask_user');
}
