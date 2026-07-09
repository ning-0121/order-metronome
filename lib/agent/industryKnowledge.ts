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

/**
 * 节点风险矩阵 — 各里程碑 step_key 的历史阻塞风险
 * risk: 'low' | 'medium' | 'high'
 * commonCauses: 最常见的阻塞原因（用于 AI 建议）
 */
export const MILESTONE_RISK_MATRIX: Record<string, {
  risk: 'low' | 'medium' | 'high';
  commonCauses: string[];
  preventionTips: string[];
}> = {
  'bom_confirmed': {
    risk: 'high',
    commonCauses: ['采购清单不完整', '供应商价格未确认', '新款辅料无货'],
    preventionTips: ['产前会当天完成BOM初版', '辅料和面料同步询价', '提前备货常用辅料'],
  },
  'procurement_order_placed': {
    risk: 'high',
    commonCauses: ['面料供应商缺货', '辅料配色周期长', '采购审批流程慢'],
    preventionTips: ['辅料配色用布样提前启动', '面料辅料同步下单', '建立备用供应商'],
  },
  'material_inspection': {
    risk: 'high',
    commonCauses: ['面料色差超标', '数量短缺', '物流延误'],
    preventionTips: ['到货24小时内完成验收', '短缺立即联系供应商补货', '色差问题当天上报'],
  },
  'pre_production_sample_confirm': {
    risk: 'high',
    commonCauses: ['客户内部审批流程慢', '海外时差', '客户要求修改'],
    preventionTips: ['产前样寄出后立即邮件+微信双渠道通知', '提前3天催促确认', '告知客户不确认将阻塞生产'],
  },
  'production_kickoff': {
    risk: 'high',
    commonCauses: ['原辅料未到齐', '产前样未确认', '工厂产能调度'],
    preventionTips: ['原辅料到货后立即安排产前会', '确保产前样确认后24小时内开裁'],
  },
  'mid_qc_check': {
    risk: 'medium',
    commonCauses: ['跟单未及时跟进进度', '工厂配合度低', '品质问题返工'],
    preventionTips: ['生产30%时主动约验', '中查发现问题当天出报告', '问题件<3%允许继续生产'],
  },
  'final_qc_check': {
    risk: 'medium',
    commonCauses: ['工厂未完成包装', '品质问题未解决', '数量不足'],
    preventionTips: ['尾查前确认工厂完成率>90%', '提前1天确认包装进度'],
  },
  'booking_done': {
    risk: 'high',
    commonCauses: ['验货未放行', '舱位紧张', '文件不齐'],
    preventionTips: ['验货放行后立即订舱', '旺季（3-5月/9-11月）提前7天订舱', '提前准备装箱单/发票'],
  },
  'processing_fee_confirmed': {
    risk: 'medium',
    commonCauses: ['报价单未及时提交', '财务审批流程', '价格分歧'],
    preventionTips: ['下单同时发加工费报价给财务', '不超过报价3天完成确认'],
  },
  'payment_received': {
    risk: 'medium',
    commonCauses: ['客户账期内延迟支付', '对账差异', '买手汇率问题'],
    preventionTips: ['出货后3天内发催款邮件', '30天内未到账升级处理', '确认银行信息无误'],
  },
};

/** 外贸最佳实践 */
export const BEST_PRACTICES = {
  orderConfirmation: '收到PO后24小时内回复确认，注明交期、价格、付款方式',
  sampleTimeline: '普通样品7-10天，复杂工艺14天，二次修改5-7天',
  productionLead: '标准大货45天，加急30天（加价10-15%），特殊面料+7天',
  qcFrequency: '中查（完成30-50%时）+ 尾查（完成90%时）+ 出货验货',
  shippingBuffer: '海运ETD前10天必须完成验货，空运前5天',
  paymentFollow: '出货后3天内寄单据，T/T尾款30天内跟进',
  // 辅料采购时间管理（CEO 2026-04-15 确认）
  trimProcurement: '拉链/网纱等需配色的辅料，不要等大货面料到了再染色！应在面料下单同时，用布样/小样提前染色辅料。否则：面料15天+辅料染色10天=只剩不到10天生产时间，严重影响交期',
  parallelProcurement: '采购原则：面料和辅料同步下单。面料用大货订单下单，辅料（拉链/网纱/松紧带等需配色的）用布样小样提前配色。验收时核对色差',
};

// ════════════════════════════════════════════════
// 外贸客户常识 — 业务员必须知道的基础信息
// ════════════════════════════════════════════════

/** 各国法规与客户要求常识 */
export const TRADE_COMPLIANCE = {
  // 美国市场
  US: {
    RN_NUMBER: 'RN号（Registered Number）是美国FTC（联邦贸易委员会）分配给企业的注册号。所有在美国销售的纺织品服装必须标注RN号或公司名称。客户下单时会提供RN号，必须印在洗标上。查询网站：https://rfrn.ftc.gov/',
    CARE_LABEL: '美国要求按 ASTM D5489 标准标注洗涤说明，必须用英文+图标，永久性标签缝在衣服内侧',
    FIBER_CONTENT: '必须标注纤维含量（如 95% Cotton, 5% Spandex），百分比按重量计算，误差不超过3%',
    COUNTRY_OF_ORIGIN: '必须标注"Made in China"或"Made in PRC"，不可省略',
    CPSIA: '儿童产品（12岁以下）必须符合CPSIA法案：铅含量≤100ppm，邻苯二甲酸酯≤0.1%，需要CPC证书',
    PROP65: '加州 Prop 65：某些化学物质含量超标需要警告标签，特别是带涂层/印花的产品',
    TARIFF: '服装HS编码通常在61章（针织）和62章（梭织），税率因面料和款式不同，一般5-32%',
    SECTION301: '中国产服装可能面临Section 301额外关税，需要确认当前税率',
  },
  // 欧洲市场
  EU: {
    CE_MARKING: '部分纺织品需要CE标志（PPE个人防护装备类）',
    REACH: 'REACH法规限制有害化学物质，特别是偶氮染料（致癌芳香胺≤30mg/kg）、甲醛、重金属',
    TEXTILE_REGULATION: '纤维含量标注需符合 EU 1007/2011 法规，可用当地语言或英文',
    CARE_LABEL_EU: '洗涤说明推荐使用 GINETEX 标准图标（国际通用洗涤符号）',
    SIZE_LABEL: '建议标注欧码（36/38/40/42...）或国际码（XS/S/M/L...）',
    OEKO_TEX: '很多欧洲客户要求 OEKO-TEX Standard 100 认证，特别是婴幼儿产品（Class I）',
  },
  // 日本市场
  JP: {
    JIS: '日本工业标准，服装需符合 JIS L 系列标准',
    CARE_LABEL_JP: '日本2016年12月起采用新JIS洗涤符号（与ISO一致），必须用日文标注',
    SIZE: '日本码偏小，同款衣服日本L≈中国M，必须确认日本客户的尺码定义',
    FORMALDEHYDE: '婴幼儿（24个月以下）甲醛≤16ppm，一般成人≤75ppm，日本标准最严',
  },
};

/** 付款方式常识 */
export const PAYMENT_TERMS = {
  TT: 'T/T（电汇）：最常见。通常30%定金+70%出货前或见提单副本付清。注意：大单建议分批付款',
  LC: 'L/C（信用证）：银行担保付款。注意：单据必须与L/C条款100%一致，任何不符点（discrepancy）都可能导致拒付。常见不符：品名不一致、数量偏差、迟装',
  DP: 'D/P（付款交单）：货到后客户凭单据付款取货。风险较高——如果客户拒绝付款，货物可能滞留港口',
  DA: 'D/A（承兑交单）：客户承兑后一段时间付款。风险最高，不建议新客户使用',
  OA: 'O/A（赊销）：先发货后付款（净30/60/90天）。仅适用于长期合作的优质客户',
  ESCROW: 'Alibaba 信保/Paypal：适合小额订单，有平台保护但手续费较高',
};

/** 贸易术语（Incoterms 2020） */
export const INCOTERMS = {
  EXW: 'EXW（工厂交货）：卖方在工厂交货，之后所有运输/保险/清关由买方负责。最小责任',
  FOB: 'FOB（船上交货）：卖方负责到装运港装船为止。买方承担海运+目的港费用。最常用的出口方式',
  CIF: 'CIF（到岸价）：卖方负责运费+保险到目的港。注意：保险只需最低保额（CIF价110%）',
  CFR: 'CFR（成本加运费）：同CIF但不含保险',
  DDP: 'DDP（完税后交货）：卖方承担全部费用到客户门口，含目的国关税。风险最大、报价最高',
  DAP: 'DAP（目的地交货）：卖方负责到目的地但不含进口清关和关税',
};

/** 服装专业术语（中英对照） */
export const GARMENT_TERMS: Record<string, string> = {
  // 面料
  'GSM': 'Grams per Square Meter，面料克重，表示每平方米面料重量',
  '纱支': 'Yarn Count，纱线粗细。支数越高越细越贵（如40s比20s细）',
  '经纬密': 'Thread Count，每英寸经纱和纬纱的根数（如133×72）',
  'Hand Feel': '手感，客户评价面料的第一标准',
  'Pilling': '起球，用马丁代尔测试仪检测，4级以上合格',
  'Color Fastness': '色牢度，洗涤/摩擦/日晒色牢度，4级以上合格',
  'Shrinkage': '缩水率，洗后尺寸变化百分比。针织一般±5%，梭织±3%',
  'Spandex': '氨纶/弹性纤维，添加使面料有弹性（常见含量2-8%）',
  'Interlock': '棉毛布/双面针织，比单面jersey更厚实稳定',
  'French Terry': '毛圈布，卫衣面料（内面毛圈，外面平纹）',
  'Fleece': '摇粒绒/抓绒，保暖面料',
  'Rib': '罗纹布，有弹性，常用于领口袖口',

  // 工艺
  'CMT': 'Cut-Make-Trim，裁剪-缝制-整理，加工费的简称',
  'Grading': '放码，从基础码按规则推算其他尺码的尺寸',
  'Marker': '排料图/排版，裁剪前在面料上排列裁片的方案',
  'Consumption': '用量/单耗，每件成品需要多少面料（单位：KG或米）',
  'Seam Allowance': '缝份，裁片边缘预留给车缝的余量（一般1-1.5cm）',
  'Overlock': '包缝/锁边，防止面料边缘脱散',
  'Flatlock': '平缝，运动服常用，缝线贴平面料表面，不凸起',
  'Bartack': '打枣/加固缝，在受力部位加固（如裤门襟、口袋角）',
  'Heat Transfer': '热转印，图案通过热压转移到面料上',
  'Sublimation': '热升华印花，数码印花的一种，全幅无手感',
  'Embroidery': '绣花，分平绣/立体绣/贴布绣',
  'Appliqué': '贴布绣，将布料裁成图案贴缝在衣服上',

  // 验货
  'AQL': 'Acceptable Quality Level，可接受质量水平。常用AQL 2.5（一般）/1.5（严格）/4.0（宽松）',
  'Inline Inspection': '中期验货，生产完成30-50%时检查',
  'Final Inspection': '尾期验货，生产完成90%以上时全面检查',
  'Pre-shipment': '出货前验货，同Final但在装箱后',
  'Golden Sample': '金样/封样，客户批准的标准样品，大货必须与此一致',
  'TOP Sample': 'Top of Production，产前样，从大货生产线取的前几件',
  'SMS': 'Shipment Sample/船样，从大货中抽取寄给客户的样品',

  // 包装
  'Polybag': '塑料袋包装，每件独立包装',
  'Hang Tag': '吊牌，挂在衣服上的标签（品牌/价格/条码）',
  'Wash Label/Care Label': '洗标/洗涤标签，标注成分和洗涤方式',
  'Main Label': '主标/领标，缝在衣领后中的品牌标',
  'Size Label': '尺码标，标注尺码',
  'UPC/EAN': '条形码，美国用UPC（12位），欧洲用EAN（13位）',
  'Shipping Mark': '唛头/箱唛，印在外箱上的标识信息',
  'Carton': '外箱，标准尺码箱：每箱24-48件（视产品大小）',
  'CBM': 'Cubic Meter，立方米，计算运费的体积单位',

  // 物流
  'B/L': 'Bill of Lading，提单，海运最重要的单据，代表货权',
  'FCL': 'Full Container Load，整柜（20GP/40GP/40HQ）',
  'LCL': 'Less than Container Load，拼柜/拼箱',
  'TEU': 'Twenty-foot Equivalent Unit，20英尺标准集装箱',
  'ETD': 'Estimated Time of Departure，预计开船日',
  'ETA': 'Estimated Time of Arrival，预计到港日',
  'CFS': 'Container Freight Station，集装箱货运站（拼箱交货点）',
  'Customs Broker': '报关行/报关代理',
  'HS Code': '海关编码，决定进口关税税率',
  'CO': 'Certificate of Origin，原产地证，有些国家进口时需要',
  'Form A': '普惠制原产地证，出口到给予中国GSP优惠的国家',
};

/** 集装箱规格 */
export const CONTAINER_SPECS = {
  '20GP': { internal: '5.9m × 2.35m × 2.39m', volume: '33 CBM', maxWeight: '28吨', typical: '约8000-12000件T恤' },
  '40GP': { internal: '12.03m × 2.35m × 2.39m', volume: '67 CBM', maxWeight: '26吨', typical: '约18000-25000件T恤' },
  '40HQ': { internal: '12.03m × 2.35m × 2.69m', volume: '76 CBM', maxWeight: '26吨', typical: '约20000-28000件T恤，比40GP高30cm' },
};

/** 尺码对照表 */
export const SIZE_CHARTS = {
  '国际码对照': 'XXS=00, XS=0-2, S=4-6, M=8-10, L=12-14, XL=16-18, 2XL=20-22, 3XL=24-26',
  '欧码对照': 'XS=34, S=36, M=38, L=40, XL=42, 2XL=44',
  '日码注意': '日本码普遍偏小1-2个码，日本L≈国际M',
  // 美国市场尺码分类体系
  'Missy/标准女装码': 'US 0-18，标准身材比例。最大市场，大部分品牌默认 Missy 码。胸腰差约10英寸',
  'Junior/少女码': 'US 0-13（奇数码1/3/5/7/9/11/13），身材偏瘦偏短。Forever21/H&M 年轻线常用',
  'Plus Size/大码': 'US 14W-28W 或 1X-4X。腰围比 Missy 宽 2-3 英寸。市场增长最快。Torrid/Lane Bryant 专做大码',
  'Petite/小码': '身高5\'4"（163cm）以下，衣长袖长裤长比标准短1-2英寸。Missy 码+P后缀（如 MP/LP）',
  'Tall/高码': '身高5\'8"（173cm）以上，衣长袖长裤长加长。后缀T（如 MT/LT）',
  'Women/女装码': 'US 14W-26W，和 Plus Size 重叠但更正式。百货商场用 Women 而非 Plus',
  '男装码系统': 'S/M/L/XL（上衣），腰围×裤长如 32×30/34×32（裤子），领围×袖长如 15.5×34（衬衫）',
  '童装分段': 'Infant(0-24M), Toddler(2T-5T), Kids(4-6X), Youth(7-16)。注意：T码和月龄码不混用',
  '尺码常见陷阱': '同一品牌不同品类尺码可能不同。下单前必须确认客户的 Size Spec（尺码规格表），不能默认用自己的标准',
};

// ════════════════════════════════════════════════
// 验货标准
// ════════════════════════════════════════════════

// ════════════════════════════════════════════════
// 验厂标准
// ════════════════════════════════════════════════

// ════════════════════════════════════════════════
// 面料品名大全
// ════════════════════════════════════════════════

// ════════════════════════════════════════════════
// 辅料品牌与规格
// ════════════════════════════════════════════════

// ════════════════════════════════════════════════
// 客户国别 — 报价与出运影响
// ════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// Off-Price 客户开发知识（DDS / Ross / Burlington / TJX 等）
// 完整方法论见 docs/knowledge/off-price-playbook.md
// ════════════════════════════════════════════════════════════════

/**
 * Off-Price 客户名称识别规则
 * 用于自动识别客户类型，决定推款策略
 * 匹配方式：大小写不敏感的子串匹配
 */
export const OFF_PRICE_RETAILERS: ReadonlyArray<{
  keyword: string;
  fullName: string;
  parent?: string;
}> = [
  { keyword: 'dds',         fullName: "DD's Discounts",  parent: 'Ross Stores' },
  { keyword: 'ross',        fullName: 'Ross Stores' },
  { keyword: 'burlington',  fullName: 'Burlington' },
  { keyword: 'tjx',         fullName: 'TJX Companies' },
  { keyword: 'tjmaxx',      fullName: 'T.J. Maxx',       parent: 'TJX' },
  { keyword: 't.j.maxx',    fullName: 'T.J. Maxx',       parent: 'TJX' },
  { keyword: 'marshalls',   fullName: 'Marshalls',       parent: 'TJX' },
  { keyword: 'homegoods',   fullName: 'HomeGoods',       parent: 'TJX' },
  { keyword: 'sierra',      fullName: 'Sierra Trading',  parent: 'TJX' },
] as const;

/**
 * Off-Price 月度推款日历
 * key: 月份（1-12）
 * value: 该月业务员应推的品类 + 业务重点
 */
export const OFF_PRICE_MONTHLY_PUSH: Record<number, {
  focus: string;
  products: string[];
  tactics: string;
}> = {
  1:  { focus: '秋冬开发启动',          products: ['fleece set', 'jacket', 'thermal'],         tactics: '推秋冬主打款，提前准备 color card + cost-down 版' },
  2:  { focus: '秋冬集中看样',          products: ['hoodie set', 'jogger set', 'brushed legging'], tactics: '秋冬主攻月，全力出样' },
  3:  { focus: '秋冬确认 + 初步 PO',    products: ['fleece set', 'sherpa jacket', 'rib lounge set'], tactics: '强推套装/外套，跟进报价转 PO' },
  4:  { focus: '秋冬补充开发',          products: ['cost-down 版本', 'carton optimization'],   tactics: '控成本、确认交期、补充款' },
  5:  { focus: 'Back-to-School 初期',  products: ['basic activewear', 'basic legging', 'layering top'], tactics: '推 BTS 基础款' },
  6:  { focus: '秋季 Activewear',      products: ['crossover flare', 'basic legging', 'tennis skirt', 'bra set', 'yoga set', 'seamless set'], tactics: '推 transition 款（夏可卖、秋也能卖）' },
  7:  { focus: 'Holiday 初期',         products: ['fleece blanket hoodie', 'gifting socks'],  tactics: '准备春夏 color card；推 Holiday gifting' },
  8:  { focus: 'Holiday + 冬季补货',   products: ['cozy lounge set', 'sherpa item', 'pajama set', 'plush items'], tactics: '推 holiday 色系（burgundy / forest / cream），快反报价' },
  9:  { focus: '春夏开发启动',          products: ['shorts', 'tank tops', 'lightweight legging'], tactics: '推 spring color + lightweight，提前 fabric booking' },
  10: { focus: '春夏集中开发',          products: ['shorts', 'tank', 'tennis dress', 'biker shorts'], tactics: '跟进所有报价转 PO 进度' },
  11: { focus: '春夏确认',              products: ['swim', 'yoga set', 'lounge'],              tactics: 'trend simplification + retail-friendly version' },
  12: { focus: '补货 + 清仓',           products: ['black legging', 'solid bra', 'fleece basics', 'white tops', 'seamless basics'], tactics: '不推复杂款，主推 quick reorder + basics' },
};

/**
 * 返回匹配到的 Off-Price 客户元数据（用于 UI 显示）
 * 未命中返回 null
 */
export function getOffPriceRetailer(customerName: string | null | undefined): {
  keyword: string;
  fullName: string;
  parent?: string;
} | null {
  if (!customerName) return null;
  const lower = customerName.toLowerCase();
  return OFF_PRICE_RETAILERS.find(r => lower.includes(r.keyword)) || null;
}

/**
 * 获取指定月份的 Off-Price 推款建议
 * @param month 月份 1-12，省略时使用当前月份
 */
export function getOffPriceMonthlyPush(month?: number): {
  month: number;
  focus: string;
  products: string[];
  tactics: string;
} {
  const m = month ?? (new Date().getMonth() + 1);
  const normalized = Math.min(12, Math.max(1, m));
  const entry = OFF_PRICE_MONTHLY_PUSH[normalized];
  return { month: normalized, ...entry };
}

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

【美国市场法规（业务员必知）】
- RN号：${TRADE_COMPLIANCE.US.RN_NUMBER}
- 洗标：${TRADE_COMPLIANCE.US.CARE_LABEL}
- 纤维含量：${TRADE_COMPLIANCE.US.FIBER_CONTENT}
- 产地标注：${TRADE_COMPLIANCE.US.COUNTRY_OF_ORIGIN}
- 儿童产品CPSIA：${TRADE_COMPLIANCE.US.CPSIA}
- 加州Prop65：${TRADE_COMPLIANCE.US.PROP65}

【欧洲市场法规】
- REACH：${TRADE_COMPLIANCE.EU.REACH}
- OEKO-TEX：${TRADE_COMPLIANCE.EU.OEKO_TEX}

【付款方式】
${Object.entries(PAYMENT_TERMS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

【贸易术语 Incoterms】
${Object.entries(INCOTERMS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

【集装箱规格】
${Object.entries(CONTAINER_SPECS).map(([k, v]) => `- ${k}: 内尺${v.internal}, 容积${v.volume}, 载重${v.maxWeight}, 约装${v.typical}`).join('\n')}

【美国尺码分类体系】
- Missy: 标准女装 US 0-18，最大市场
- Junior: 少女码 US 1-13（奇数），偏瘦偏短
- Plus Size: 大码 US 14W-28W / 1X-4X，增长最快
- Petite: 小码，身高<163cm，加P后缀
- Tall: 高码，身高>173cm，加T后缀
- 男装：上衣S/M/L/XL，裤子腰围×裤长（32×30），衬衫领围×袖长（15.5×34）
- 童装：Infant(0-24M), Toddler(2T-5T), Kids(4-6X), Youth(7-16)

【验货标准】
- AQL 2.5 = 标准，每200件允许约10件次品
- 致命缺陷(Critical) AQL=0 零容忍：断针、有害化学物
- 主要缺陷(Major) AQL=2.5：色差>4级、尺寸超标>2cm、破洞
- 次要缺陷(Minor) AQL=4.0：线头<3cm、轻微污渍
- 关键部位尺寸公差 ±1cm，对称部位差≤0.5cm

【验厂认证】
- BSCI: 欧洲零售商认可，C级以上合格
- SEDEX/SMETA: 英国体系，4大支柱审核
- WRAP: 美国体系，金/银/铜证书
- Disney FAMA: 迪士尼必须通过ITS/SGS/BV验厂
- GOTS: 有机纺织品最严标准

【辅料品牌】
- 拉链：YKK（日本第一，Nike/Adidas指定）> SBS（国内最大，性价比）> YBS（低价）> RIRI（奢侈品级）
- 规格：#3(裤门襟) #5(常规夹克) #8(厚外套) #10(箱包)
- 纽扣：树脂（最常用）/金属（牛仔工装）/贝壳（高端衬衫）/椰壳（休闲风）
- 缝纫线：Coats（全球最大）/Amann（德国）/兄弟/金象（国内）

【客户国别影响报价和出运】
- 美国：关税5-32%+301关税，必须RN号+CPSIA（儿童），海运西海岸14-18天/东海岸25-30天
- 欧盟：关税8-12%，REACH+OEKO-TEX，海运25-30天，中欧班列15-18天
- 日本：品质要求最高，尺码偏小，海运5-7天，甲醛标准最严
- 澳洲：ChAFTA后关税0%，季节相反（北半球冬=澳洲夏）
- 中东：尺码偏大，深色保守款为主，迪拜转口贸易中心
- 南美：巴西关税极高（35%+），清关复杂慢，汇率波动大
- 非洲：价格敏感，建议高比例预付，港口效率低

【面料成分缩写】
C=棉 P=涤纶 N=尼龙 SP=氨纶 R=人造丝 T=天丝 L=亚麻 W=羊毛 CVC=涤棉(棉>50%) TC=涤棉(涤>50%)

【服装专业术语（部分）】
- GSM: ${GARMENT_TERMS['GSM']}
- CMT: ${GARMENT_TERMS['CMT']}
- AQL: ${GARMENT_TERMS['AQL']}
- B/L: ${GARMENT_TERMS['B/L']}
- HS Code: ${GARMENT_TERMS['HS Code']}
- UPC/EAN: ${GARMENT_TERMS['UPC/EAN']}

【品质控制要点】
${QUALITY_ISSUES.slice(0, 4).map(q => `- ${q.issue}: ${q.prevention}`).join('\n')}

【标准周期】
- 样品: 7-10天(普通) / 14天(复杂)
- 大货: 45天(标准) / 30天(加急)
- 海运ETD前10天必须完成验货

【⚠ 辅料采购时间陷阱】
- 拉链/网纱等需配色的辅料，不要等大货面料到了再染色！
- 应在面料下单同时，用布样/小样提前染色辅料
- 否则：面料15天+辅料染色10天=只剩不到10天生产时间
- 正确做法：面料和辅料同步下单，辅料用布样配色，大货面料到了直接开工
`;
}
