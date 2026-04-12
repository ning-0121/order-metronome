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

export const INSPECTION_STANDARDS = {
  AQL_LEVELS: {
    '1.0': '最严格 — 高端品牌/婴幼儿产品。每100件抽检最多允许1件次品',
    '1.5': '严格 — 中高端品牌。每200件允许约5件次品',
    '2.5': '标准 — 大多数订单默认。每200件允许约10件次品（General Inspection Level II）',
    '4.0': '宽松 — 低价大货/促销品。每200件允许约14件次品',
    '6.5': '最宽松 — 尾货/清仓',
  },
  INSPECTION_TYPES: {
    'Inline/中查': '生产完成30-50%时。重点：尺寸、做工、面料问题。发现问题还能纠正',
    'Final/尾查': '生产完成80-100%时。全面检查：外观、尺寸、功能、包装、标签。决定是否放行',
    'Pre-shipment': '装箱完成后、出货前。抽箱检查：数量、包装完整性、唛头',
    'During Production': '生产全程驻厂检查，适用于新工厂或高风险订单',
  },
  DEFECT_CLASSIFICATION: {
    'Critical/致命缺陷': '影响安全或违反法规。如：断针残留、有害化学物超标、尖锐配件。AQL=0，零容忍',
    'Major/主要缺陷': '影响产品使用或外观严重。如：色差>4级、尺寸超标>2cm、功能失效、破洞。默认AQL=2.5',
    'Minor/次要缺陷': '轻微外观问题，不影响使用。如：线头<3cm、轻微污渍可清洗、缝线略歪。默认AQL=4.0',
  },
  MEASUREMENT_TOLERANCE: {
    '关键部位（胸围/腰围/臀围）': '±1cm（严格客户±0.5cm）',
    '次要部位（袖长/衣长/裤长）': '±1.5cm',
    '领口/袖口': '±0.5cm',
    '对称部位（左右袖长差）': '≤0.5cm',
  },
  COMMON_TESTS: {
    '缩水率测试': '水洗3次后测量变化。针织≤±5%，梭织≤±3%。方法：AATCC 135（美国）/ISO 6330（国际）',
    '色牢度-水洗': '≥4级。方法：AATCC 61/ISO 105-C06',
    '色牢度-摩擦': '干摩≥4级，湿摩≥3级。方法：AATCC 8/ISO 105-X12',
    '色牢度-汗渍': '≥4级。方法：AATCC 15/ISO 105-E04',
    '起球测试': '≥3.5级（马丁代尔法）。方法：ASTM D4970/ISO 12945-2',
    '拉伸强力': '梭织≥180N，针织≥80N。方法：ASTM D5034/ISO 13934',
    '撕裂强力': '梭织≥15N。方法：ASTM D1424/ISO 13937',
    '甲醛含量': '婴幼儿≤20mg/kg，直接接触皮肤≤75mg/kg，非直接≤300mg/kg',
    '偶氮染料': '禁用偶氮（致癌芳香胺）≤30mg/kg',
    'pH值': '婴幼儿4.0-7.5，直接接触4.0-8.5',
  },
};

// ════════════════════════════════════════════════
// 验厂标准
// ════════════════════════════════════════════════

export const FACTORY_AUDIT_STANDARDS = {
  SOCIAL_COMPLIANCE: {
    'BSCI': 'Business Social Compliance Initiative。欧洲零售商认可，审核劳工权益/工时/工资/安全。等级A-E，C以上合格',
    'SEDEX/SMETA': 'Supplier Ethical Data Exchange。英国体系，4 pillars审核（劳工/健康安全/环境/商业道德）',
    'WRAP': 'Worldwide Responsible Accredited Production。美国体系，12条原则。金/银/铜证书',
    'SA8000': 'Social Accountability 8000。最严格的社会责任标准，认证有效期3年',
    'Disney FAMA': '迪士尼工厂授权制造协议。必须通过ITS/SGS/BV验厂。重点：童工/消防/工时',
    'Walmart/沃尔玛': 'ES审核（Ethical Sourcing）。绿/黄/橙/红灯。橙灯限期整改，红灯终止合作',
  },
  QUALITY_SYSTEMS: {
    'ISO 9001': '质量管理体系。证明工厂有标准化生产流程',
    'ISO 14001': '环境管理体系。证明工厂有环保措施',
    'OEKO-TEX STeP': '可持续纺织生产认证。从原材料到成品的环保标准',
    'GRS': 'Global Recycled Standard。再生纤维认证，使用回收材料',
    'OCS': 'Organic Content Standard。有机纤维认证',
    'GOTS': 'Global Organic Textile Standard。最严格的有机纺织品标准，从纤维到成品全链路',
  },
  FACTORY_CAPACITY_CALC: '月产能估算：工人数 × 日产件数 × 26天（每月工作日）。例：50人 × 40件/天 × 26 = 52,000件/月',
};

// ════════════════════════════════════════════════
// 面料品名大全
// ════════════════════════════════════════════════

export const FABRIC_DIRECTORY: Record<string, { en: string; desc: string; typical_gsm: string; common_use: string }> = {
  // 针织
  '单面平纹/汗布': { en: 'Single Jersey', desc: '最基础的针织面料，一面光滑一面有小线圈', typical_gsm: '120-200g', common_use: 'T恤、打底衫' },
  '双面棉毛': { en: 'Interlock', desc: '两面都光滑，比单面厚实稳定，不卷边', typical_gsm: '180-280g', common_use: 'Polo衫、中高端T恤' },
  '罗纹': { en: 'Rib (1×1/2×2)', desc: '有纵向条纹，弹性好', typical_gsm: '200-300g', common_use: '领口、袖口、修身上衣' },
  '毛圈布': { en: 'French Terry', desc: '外面平纹，里面毛圈。不倒毛', typical_gsm: '250-380g', common_use: '卫衣、运动裤' },
  '抓绒/摇粒绒': { en: 'Fleece/Polar Fleece', desc: '起绒面料，保暖轻便', typical_gsm: '180-380g', common_use: '外套、保暖内衣' },
  '卫衣布/磨毛': { en: 'Brushed Fleece', desc: '毛圈布经磨毛处理，里面更柔软', typical_gsm: '280-400g', common_use: '冬季卫衣、运动套装' },
  '网眼布': { en: 'Mesh/Piqué', desc: '有透气孔洞的针织面料', typical_gsm: '120-220g', common_use: 'Polo衫、运动服' },
  '莱卡棉': { en: 'Cotton Spandex Jersey', desc: '棉+氨纶混纺，有弹性', typical_gsm: '180-250g', common_use: '瑜伽裤、紧身衣' },
  '天竺棉': { en: 'Combed Cotton Jersey', desc: '精梳棉，纱线光洁柔软', typical_gsm: '150-200g', common_use: '高品质T恤、内衣' },
  '华夫格': { en: 'Waffle Knit', desc: '方格状凹凸纹理，透气性好', typical_gsm: '180-280g', common_use: '家居服、休闲上衣' },

  // 梭织
  '府绸/细布': { en: 'Poplin', desc: '经纬密度高，紧密轻薄有光泽', typical_gsm: '80-130g', common_use: '衬衫、连衣裙' },
  '斜纹布': { en: 'Twill', desc: '斜纹组织，比平纹厚实耐磨', typical_gsm: '150-300g', common_use: '裤子、工装、夹克' },
  '牛仔布': { en: 'Denim', desc: '靛蓝染色的粗斜纹棉布', typical_gsm: '200-450g（按盎司：4oz-14oz）', common_use: '牛仔裤、牛仔夹克' },
  '帆布': { en: 'Canvas', desc: '厚实紧密的平纹或斜纹面料', typical_gsm: '200-600g', common_use: '包袋、工装裤、帽子' },
  '卡其布': { en: 'Chino/Khaki', desc: '轻量斜纹面料，比牛仔薄', typical_gsm: '180-280g', common_use: '休闲裤、短裤' },
  '灯芯绒': { en: 'Corduroy', desc: '表面有纵向绒条（条数：8条/14条/21条宽）', typical_gsm: '200-350g', common_use: '裤子、夹克、裙子' },
  '涤塔夫': { en: 'Polyester Taffeta', desc: '涤纶平纹面料，轻薄防风', typical_gsm: '40-80g', common_use: '里衬、轻便外套' },
  '尼龙塔斯隆': { en: 'Nylon Taslan', desc: '尼龙空变纱面料，有棉感', typical_gsm: '100-180g', common_use: '户外服、风衣' },
  '记忆布': { en: 'Memory Fabric', desc: '涤纶面料，折叠后能恢复原形', typical_gsm: '100-150g', common_use: '风衣、夹克' },
  '色丁/缎面': { en: 'Satin/Charmeuse', desc: '缎纹组织，一面光滑有光泽', typical_gsm: '80-150g', common_use: '晚装、衬衫、内衣' },
};

// ════════════════════════════════════════════════
// 辅料品牌与规格
// ════════════════════════════════════════════════

export const TRIM_BRANDS = {
  拉链: {
    'YKK': '日本品牌，全球第一。品质最好价格最高。美国大客户（Nike/Adidas/Gap）通常指定YKK',
    'SBS': '中国品牌，国内最大。品质稳定，价格约YKK的60-70%。大部分中等订单选用',
    'YBS': '中国品牌，价格低，适合低价位订单',
    'RIRI': '瑞士品牌，奢侈品级别。用于LV/Gucci等高端品牌',
    '常见规格': '#3（薄面料/裤门襟）、#5（常规夹克/卫衣）、#8（厚外套）、#10（帐篷/箱包）。类型：金属/尼龙/树脂/隐形',
  },
  纽扣: {
    '材质分类': '树脂扣（最常用）、金属扣（牛仔/工装）、贝壳扣（高端衬衫）、椰壳扣（休闲/自然风）、牛角扣（大衣）',
    '尺寸': '衬衫常用10-12mm，外套常用15-20mm，大衣30-40mm。四眼扣/两眼扣/暗扣/啪扣',
    '品�GPO牌': 'Set（意大ger大利高端）、Leaderform（中高端）、国内东莞/温州产（性价比）',
  },
  松紧带: {
    '材质': '涤纶+橡筋（最常见）、全棉+橡筋（贴身穿）、硅胶防滑带（运动服腰头）',
    '宽度': '裤腰常用25-40mm，袖口/裤脚常用10-15mm，内衣常用8-12mm',
  },
  织带: {
    '材质': '涤纶（最常见）、尼龙（光滑有光泽）、棉（自然感）、PP带（廉价替代）',
    '品牌': 'Bekaert（比利时）、国内浙江/广东产',
  },
  衬布: {
    '类型': '有纺衬（稳定性好，用于领子/门襟）、无纺衬（经济型，用于大面积）、针织衬（有弹性，用于弹力面料）',
    '品牌': '南亚衬布（台湾，高端）、常熟衬布（国内主流）',
    '温度': '粘合温度通常130-160°C，低温衬100-120°C（用于易变形面料）',
  },
  线: {
    '品牌': 'Coats（英国，全球最大缝纫线品牌）、Amann（德国）、国内：兄弟/金象',
    '规格': '涤纶线最常用。粗细：20s（粗/牛仔明线）、40s（中等/常规）、60s（细/薄面料）',
    '颜色': '必须和面料严格对色，建议用Pantone色号指定',
  },
};

// ════════════════════════════════════════════════
// 客户国别 — 报价与出运影响
// ════════════════════════════════════════════════

export const COUNTRY_TRADE_PROFILES: Record<string, {
  region: string;
  currency: string;
  tariff_note: string;
  certification: string[];
  label_requirements: string;
  shipping_note: string;
  payment_habit: string;
  special_note: string;
}> = {
  '美国/US': {
    region: '北美',
    currency: 'USD',
    tariff_note: '服装关税5-32%（视面料和款式），可能有Section 301额外关税（当前对中国加征）。HS编码61章（针织）/62章（梭织）',
    certification: ['CPSIA（儿童）', 'Prop 65（加州）', 'ASTM标准', 'FTC RN号'],
    label_requirements: '必须标注：RN号或公司名、纤维含量（英文）、产地（Made in China）、洗涤说明（ASTM D5489）。永久性洗标',
    shipping_note: '西海岸（LA/Long Beach）海运约14-18天，东海岸（NY/Savannah）约25-30天。旺季（8-10月）舱位紧张加价',
    payment_habit: '大客户常用O/A 60-90天或L/C。中小客户T/T 30%+70%',
    special_note: 'FDA可能抽检纺织品。ISF（10+2申报）必须在装船前24小时提交',
  },
  '欧盟/EU': {
    region: '欧洲',
    currency: 'EUR',
    tariff_note: '服装关税约8-12%。中国无GSP优惠（2014年取消）。注意：欧盟各国清关点不同，建议走汉堡/鹿特丹',
    certification: ['REACH', 'OEKO-TEX', 'CE（PPE类）', 'GOTS（有机）'],
    label_requirements: '纤维含量需符合EU 1007/2011（可用当地语言或英文）。洗涤符号GINETEX标准。产地标注推荐但非强制',
    shipping_note: '海运到欧洲主港约25-30天。铁路（中欧班列）约15-18天，价格介于海运和空运之间',
    payment_habit: 'L/C较常见（特别是新客户）。老客户可O/A 30-60天',
    special_note: '碳边境税（CBAM）未来可能影响纺织品。VAT（增值税）各国不同（德国19%/法国20%/意大利22%）',
  },
  '英国/UK': {
    region: '欧洲',
    currency: 'GBP',
    tariff_note: '脱欧后独立关税制度，服装约6.5-12%。有UK-中国的发展中国家优惠（DCTS），部分品类可享低税率',
    certification: ['UKCA（取代CE）', 'REACH UK版'],
    label_requirements: '类似欧盟但需单独合规。产地标注"Made in China"',
    shipping_note: '海运到Felixstowe/Southampton约28-32天',
    payment_habit: 'T/T或L/C均有',
    special_note: '脱欧后英国和欧盟是两个独立市场，不能共用CE/UKCA标志',
  },
  '日本/JP': {
    region: '亚洲',
    currency: 'JPY',
    tariff_note: '服装关税约5-11%（RCEP协定后可逐步减免）。EPA原产地规则较严',
    certification: ['JIS标准', '甲醛限量（最严）'],
    label_requirements: '必须用日文标注纤维含量和洗涤方式。2016年起采用新JIS洗涤符号（与ISO一致）。标签信息必须极其准确',
    shipping_note: '海运约5-7天（最近），空运1-2天。日本客户对交期准时率要求极高',
    payment_habit: 'L/C at sight或T/T。付款信誉好但流程严格',
    special_note: '日本客户品质要求全球最高。尺码偏小（日本L≈国际M）。包装细节要求苛刻',
  },
  '韩国/KR': {
    region: '亚洲',
    currency: 'KRW',
    tariff_note: '服装关税约8-13%。中韩FTA部分品类可减免',
    certification: ['KC认证（儿童）', 'KS标准'],
    label_requirements: '必须韩文标注。纤维含量、洗涤方式、制造商/进口商信息',
    shipping_note: '海运约3-5天，最快的出口市场之一',
    payment_habit: 'T/T较多，韩国客户习惯快速决策快速下单',
    special_note: '韩国市场时尚周期短，款式更新快，常要求小批量多款',
  },
  '澳大利亚/AU': {
    region: '大洋洲',
    currency: 'AUD',
    tariff_note: '中澳FTA（ChAFTA）后大部分服装关税为0%',
    certification: ['ACCC安全标准（儿童）'],
    label_requirements: '纤维含量、产地、洗涤说明（英文）。儿童睡衣有特殊阻燃要求',
    shipping_note: '海运约15-20天（到悉尼/墨尔本）',
    payment_habit: 'T/T 30%+70%为主',
    special_note: '季节相反——北半球冬季是澳洲夏季。排单时注意季节差',
  },
  '中东/ME': {
    region: '中东',
    currency: 'USD/AED',
    tariff_note: 'GCC国家（阿联酋/沙特等）关税约5%。自贸区转口贸易发达',
    certification: ['SASO（沙特）', 'ESMA（阿联酋）'],
    label_requirements: '部分国家要求阿拉伯语标注。注意：某些宗教文化限制（图案/颜色）',
    shipping_note: '海运到迪拜约15-20天。迪拜是重要的转口贸易中心',
    payment_habit: 'L/C较常见（特别是沙特/伊拉克）。阿联酋可T/T',
    special_note: '尺码偏大（中东客户体型偏大）。深色/保守款需求大。斋月期间业务放缓',
  },
  '南美/LATAM': {
    region: '南美',
    currency: 'USD/BRL',
    tariff_note: '巴西关税极高（可达35%+税中税）。智利/秘鲁与中国有FTA',
    certification: ['INMETRO（巴西）'],
    label_requirements: '巴西必须葡萄牙语标注，其他国家西班牙语',
    shipping_note: '海运到巴西Santos约30-35天。南美清关速度慢',
    payment_habit: '巴西常用L/C。其他国家T/T',
    special_note: '巴西市场大但清关复杂，建议找当地进口商合作。汇率波动大，报价注意锁汇',
  },
  '非洲/AF': {
    region: '非洲',
    currency: 'USD',
    tariff_note: '各国差异大。南非关税约15-45%。东非（肯尼亚/坦桑尼亚）相对较低',
    certification: ['SONCAP（尼日利亚）', 'PVOC（肯尼亚）'],
    label_requirements: '通常英文或法文，视殖民历史',
    shipping_note: '海运到西非约25-30天，东非约20-25天。港口效率低，延误常见',
    payment_habit: '建议T/T全款或高比例预付。L/C需确认开证行信誉',
    special_note: '非洲市场价格敏感，重性价比。注意：部分国家禁止进口二手衣服',
  },
};

/** 常见面料成分缩写 */
export const FIBER_ABBREVIATIONS: Record<string, string> = {
  'C': 'Cotton 棉',
  'P/PES': 'Polyester 涤纶',
  'N/PA': 'Nylon/Polyamide 尼龙/锦纶',
  'SP/EL': 'Spandex/Elastane 氨纶/弹性纤维',
  'R/VS': 'Rayon/Viscose 人造丝/粘胶',
  'T/TE': 'Tencel/Lyocell 天丝',
  'L/LI': 'Linen 亚麻',
  'W/WO': 'Wool 羊毛',
  'S/SE': 'Silk 丝绸',
  'A/AC': 'Acrylic 腈纶',
  'MD': 'Modal 莫代尔',
  'CVC': 'Chief Value Cotton 棉为主的涤棉混纺（棉>50%）',
  'TC': 'Tetron Cotton 涤棉混纺（涤>50%）',
  'TR': 'Tetron Rayon 涤粘混纺',
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
`;
}
