/**
 * 外贸服装行业知识库 — 提升 Agent 专业度
 *
 * 内置行业经验，让 AI 建议更专业：
 * 1. 面料特性知识（高弹/浅色/梭织等风险点）
 * 2. 季节性规律（旺季/淡季/提前排产周期）
 * 3. 常见品质问题及预防
 * 4. 外贸流程最佳实践
 * 5. 客户沟通模板
 */

/** 面料风险知识 */
export const FABRIC_RISKS: Record<string, { risk: string; prevention: string }> = {
  '高弹面料': { risk: '克重偏差大、缩水率不稳定', prevention: '大货前必须做缩水率测试，预留2-3%裁剪余量' },
  '浅色面料': { risk: '色牢度低、容易色差、沾污', prevention: '生产线隔离深浅色，包装用深色纸分隔' },
  '梭织面料': { risk: '纬斜、缩水方向不一致', prevention: '裁剪前预缩处理，裁片检查纬斜角度' },
  '印花面料': { risk: '色牢度、手感变硬、图案偏位', prevention: '产前确认网版和对位标准，中查重点检查' },
  '针织面料': { risk: '卷边、尺寸不稳定', prevention: '裁前充分松布，IRF测试确认缩率' },
};

/** 季节性规律 */
export const SEASONAL_PATTERNS = {
  peakMonths: [3, 4, 5, 9, 10, 11], // 旺季月份
  slowMonths: [1, 2, 7, 8, 12],      // 淡季月份
  springFestivalBuffer: 30,            // 春节前需提前排产的天数
  chinaHolidayImpact: {
    springFestival: '工厂停工15-20天，节前赶货+节后复工慢',
    nationalDay: '停工7天，9月底开始受影响',
    laborDay: '停工5天，影响较小',
  },
  seasonalAdvice: (month: number): string => {
    if ([3, 4, 5].includes(month)) return '春季旺季，工厂产能紧张，建议提前30天排单';
    if ([9, 10, 11].includes(month)) return '秋季旺季，注意国庆假期影响，9月底前必须完成紧急单';
    if ([1, 2].includes(month)) return '春节淡季，利用空档开发新客户和安排样品';
    if ([7, 8].includes(month)) return '夏季淡季，适合安排翻单和库存补货';
    return '常规月份，正常排产';
  },
};

/** 品质问题知识库 */
export const QUALITY_ISSUES = [
  { issue: '色差', frequency: 'high', prevention: '每批面料做Lab值比色，不同批次不混用', rootCause: '面料批次差异、染色工艺不稳定' },
  { issue: '缩水超标', frequency: 'high', prevention: '大货前做3次水洗测试，预留缩率', rootCause: '面料预缩不充分、IRF数据未执行' },
  { issue: '起球', frequency: 'medium', prevention: '面料选型时做马丁代尔起球测试≥4级', rootCause: '纤维短、纱线捻度不够' },
  { issue: '尺寸偏差', frequency: 'medium', prevention: '首件+中查+尾查三次量尺寸，对照尺码表', rootCause: '裁剪误差、缝制拉伸、整烫变形' },
  { issue: '线头/污渍', frequency: 'high', prevention: '包装前100%检查，设置专门的修剪+清洁工位', rootCause: '车缝后未剪线头、包装环境不洁' },
  { issue: '配件错误', frequency: 'low', prevention: '包装前核对配件清单，分色分码独立备料', rootCause: '多款混线、标签打错' },
];

/** 外贸最佳实践 */
export const BEST_PRACTICES = {
  orderConfirmation: '收到PO后24小时内回复确认，注明交期、价格、付款方式',
  sampleTimeline: '普通样品7-10天，复杂工艺14天，二次修改5-7天',
  productionLead: '标准大货45天，加急30天（加价10-15%），特殊面料+7天',
  qcFrequency: '中查（完成30-50%时）+ 尾查（完成90%时）+ 出货验货',
  shippingBuffer: '海运ETD前10天必须完成验货，空运前5天',
  paymentFollow: '出货后3天内寄单据，T/T尾款30天内跟进',
};

/**
 * 根据订单特征生成专业建议
 */
export function getIndustryAdvice(context: {
  specialTags?: string[];
  orderType?: string;
  quantity?: number;
  currentMonth?: number;
}): string[] {
  const advice: string[] = [];
  const month = context.currentMonth || new Date().getMonth() + 1;

  // 季节性建议
  advice.push(SEASONAL_PATTERNS.seasonalAdvice(month));

  // 面料风险
  if (context.specialTags) {
    for (const tag of context.specialTags) {
      if (tag.includes('高弹')) advice.push(`⚠ ${FABRIC_RISKS['高弹面料'].risk}。${FABRIC_RISKS['高弹面料'].prevention}`);
      if (tag.includes('浅色')) advice.push(`⚠ ${FABRIC_RISKS['浅色面料'].risk}。${FABRIC_RISKS['浅色面料'].prevention}`);
      if (tag.includes('印花')) advice.push(`⚠ ${FABRIC_RISKS['印花面料'].risk}。${FABRIC_RISKS['印花面料'].prevention}`);
    }
  }

  // 大单建议
  if (context.quantity && context.quantity > 50000) {
    advice.push('大单建议分批生产、分批出货，降低集中出货风险');
  }

  // 试单建议
  if (context.orderType === 'trial' || context.orderType === 'sample') {
    advice.push('试单/打样：重点关注客户评价标准，首单品质直接影响后续翻单');
  }

  return advice;
}

/**
 * 构建 Agent 的行业知识 prompt 片段
 */
export function buildIndustryPrompt(): string {
  return `
你具备以下外贸服装行业专业知识：

【面料风险】
${Object.entries(FABRIC_RISKS).map(([k, v]) => `- ${k}: ${v.risk}。预防：${v.prevention}`).join('\n')}

【季节规律】
- 旺季(3-5月/9-11月)工厂产能紧张，需提前排单
- 春节前30天开始受影响，工厂停工15-20天
- 国庆前后7天停工，9月底需完成紧急单

【品质控制要点】
${QUALITY_ISSUES.slice(0, 4).map(q => `- ${q.issue}: ${q.prevention}`).join('\n')}

【标准周期】
- 样品: 7-10天(普通) / 14天(复杂)
- 大货: 45天(标准) / 30天(加急)
- 海运ETD前10天必须完成验货
`;
}
