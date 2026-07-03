# 包装模板系统(Packaging Template OS)V1.0 设计

> 2026-07-03。状态:设计定稿,待拍板分期实施。
> 遵循 ADR-005(DB 存事实 · 确定性内核算真相 · AI 只辅助)、Constitution 02(单一真相源)、ADR-004(采购五层脊柱不动)。
> **纯加法**:不改 material_master / materials_bom / MRP / 库存账,零 breaking change。

## 〇、一句话定位

**成千上万的洗水唛、吊牌、贴纸、箱唛、印刷辅料,永远不该变成成千上万条物料主数据 —— 它们是「模板 + 变量」。**

物料主数据(Material Master)管**实物库存**;包装模板(Packaging Template)管**可印刷资产**。两者并列,互不进入。

## 一、铁律(不可协商)

1. **模板不是库存**:不算库存、不进 MRP、不进库存流水(inventory_transactions)、不产生任何库存事务。
2. **模板永不代表一个 SKU**:✅「洗水唛模板」「吊牌模板」「箱唛模板」;❌「洗水唛-美国-L码-黑色-Popfit」。禁止 SKU 组合爆炸。
3. **唯一生命周期**:`模板 + 变量 → 渲染件(Rendered Artifact) → 印刷单(Print Job) → 采购`。没有第二条路。
4. **三个独立一等对象**:Material Master ⊥ Packaging Template ⊥ Print Job。
5. **印刷数量由订单算出**(确定性内核函数),模板本身永不存数量。
6. **禁止**:为每语言/每尺码/每客户建库存 SKU;把渲染 PDF 塞进物料主数据;把变量塞进物料主数据;复制模板(改版本,不复制)。

**与 Material Master 的边界判定**(录入口的一条规则):
- 实物按件/米/kg 采购入库、可盘点余额 → **物料**(如:空白纸箱、拉链、胶袋原膜)。
- 内容随订单变化、按单印刷、印完即随货走 → **模板 + 印刷单**(如:洗水唛、吊牌、箱唛、贴纸、警示标)。
- 灰区(如印好的丝带)以「内容是否含订单变量」定:有变量 → 模板;无变量固定品 → 物料。

## 二、对象准入双门禁

**🏛 Architecture Gate**
- 属哪个 Domain?→ 新立「包装资产域(Packaging Asset Domain)」,与物料域平级,同属 SCM OS。
- 数据所有权?→ 模板/版本/变量 = 业务执行部+采购共同维护(建/改模板);印刷单 = 采购(执行);渲染件 = 系统产物(只读)。
- 有无重复真相?→ 无。模板不是物料(不进库存);印刷单数量由订单算(kernel,单一算法);渲染件由 (版本+变量) 决定性生成,可随时重算,存储只是缓存。

**🔮 Future Gate(3 年后/10 工厂还成立吗?)**
- 数百模板 × 百万级渲染变体:内容寻址缓存(变量哈希)天然去重,存储 O(不同变量组合数),不随订单数爆炸。
- 多工厂:印刷单挂 supplier(印刷厂即供应商),工厂/贴标地点是变量,不是新模板。
- 多品牌/多客户:品牌、客户是变量;客户专属版式才立新模板(数百量级,可控)。
- 换渲染引擎:render_engine 字段 + 版本内 layout_json 自描述,引擎可替换,历史渲染件不失效(已固化为文件)。

## 三、架构(ADR-005 两层)

```
┌─ Data Truth Layer(DB,只存事实)────────────────────────────┐
│ packaging_templates / packaging_template_versions            │
│ packaging_variables / print_jobs / rendered_artifacts(缓存) │
└──────────────────────────────────────────────────────────────┘
                 ↑ 读事实            ↓ 写回(action 薄壳)
┌─ Deterministic Kernel Layer(lib/services/packaging-kernel.ts)─┐
│ resolvePrintVariables(order,po,lineItems,template) → 变量值    │
│ computePrintQuantity(order,category,packing) → 印刷数量+损耗   │
│ renderSpec(version,variables) → 确定性排版指令(纯函数)        │
│ variablesHash(variables) → 内容寻址键(canonical JSON hash)    │
└──────────────────────────────────────────────────────────────┘
                 ↓ renderSpec
┌─ Render Service(app/api/packaging/render,消费 kernel 输出)──┐
│ renderSpec + pdf_background → PDF → PNG 预览 → Storage        │
└──────────────────────────────────────────────────────────────┘
```

- **SQL 只存/索引/检索**,不做计算(无 view 算法)。
- **Action = 薄壳**(auth + 拉数据 + 调 kernel + 写回)。
- **UI 纯消费** kernel 输出。
- **AI 只辅助**:解读客户 label spec/艺术稿 → 起草变量映射草稿,人确认才落库;永不算数量、永不生成真相。

## 四、数据库(全部新表,纯加法)

```sql
-- 1) 模板(百量级,可复用资产)
CREATE TABLE packaging_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text UNIQUE NOT NULL,          -- PKT-0001(自动赋码,同 material-autocode 模式)
  name             text NOT NULL,                 -- 「Popfit 洗水唛」
  category         text NOT NULL,                 -- wash_label/hangtag/size_sticker/barcode_label/carton_mark/
                                                  -- polybag_print/warning_label/care_label/brand_card/
                                                  -- instruction_card/shipping_mark/custom
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  description      text,
  preview_image    text,                          -- 最新 active 版本的预览(冗余显示用)
  render_engine    text NOT NULL DEFAULT 'pdf_overlay_v1',
  default_supplier uuid REFERENCES suppliers(id), -- 常用印刷厂(建议,非绑定)
  customer_name    text,                          -- 客户专属模板(可空=通用)
  created_by       uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX uq_pkt_name_cat ON packaging_templates (lower(trim(name)), category)
  WHERE status='active';                          -- 防重复(同物料库教训)

-- 2) 版本(不可变;被印刷单引用后冻结)
CREATE TABLE packaging_template_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id      uuid NOT NULL REFERENCES packaging_templates(id) ON DELETE CASCADE,
  version          int NOT NULL,                  -- 1,2,3…
  pdf_background   text,                          -- 底版 PDF(Storage 路径;客户 AI 稿/刀模)
  layout_json      jsonb NOT NULL DEFAULT '{}',   -- 变量落位:{"fields":[{"var":"size","x":,"y":,"font":,"size":,"align":}]}
  variables_schema jsonb NOT NULL DEFAULT '[]',   -- 该版本的变量定义快照(=packaging_variables 的物化,渲染只认它)
  active           boolean NOT NULL DEFAULT false, -- 一模板同刻仅一个 active(部分唯一索引)
  notes            text,
  created_by       uuid, created_at timestamptz DEFAULT now(),
  UNIQUE(template_id, version)
);
CREATE UNIQUE INDEX uq_ptv_one_active ON packaging_template_versions(template_id) WHERE active;

-- 3) 变量定义(编辑态;发版时物化进 version.variables_schema)
CREATE TABLE packaging_variables (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_version_id uuid NOT NULL REFERENCES packaging_template_versions(id) ON DELETE CASCADE,
  variable_name       text NOT NULL,              -- brand/customer/country/language/size/color/season/
                                                  -- composition/made_in/barcode/qrcode/po_number/order_number/
                                                  -- style_number/vendor/factory/carton_number/lot_number/date…
  type                text NOT NULL DEFAULT 'text' CHECK (type IN ('text','number','date','barcode','qrcode','image','select')),
  required            boolean NOT NULL DEFAULT true,
  default_value       text,
  source_hint         text,                       -- 自动取值线索:'order.style_no'/'line_item.size'/'po.po_number'(kernel 用)
  options             jsonb,                      -- select 型的可选值
  UNIQUE(template_version_id, variable_name)
);

-- 4) 渲染件缓存(内容寻址:同版本+同变量 = 同文件,百万变体不重复渲染/存储)
CREATE TABLE rendered_artifacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_version_id uuid NOT NULL REFERENCES packaging_template_versions(id),
  variables_hash      text NOT NULL,              -- variablesHash(kernel) = sha256(canonical variables JSON)
  variables           jsonb NOT NULL,             -- 事实:用了什么变量值(可追溯/可重渲)
  pdf_path            text NOT NULL,              -- Storage:packaging-artifacts/
  png_preview_path    text,
  created_at          timestamptz DEFAULT now(),
  UNIQUE(template_version_id, variables_hash)
);

-- 5) 印刷单(采购买的是它,不是模板)
CREATE TABLE print_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_no              text UNIQUE NOT NULL,       -- PJ-YYYYMMDD-NNN
  template_version_id uuid NOT NULL REFERENCES packaging_template_versions(id),  -- 钉死版本(可追溯)
  order_id            uuid REFERENCES orders(id), -- 来源订单(可空=备货性印刷,少见)
  artifact_id         uuid REFERENCES rendered_artifacts(id),  -- 渲染结果
  variables           jsonb NOT NULL,             -- 本单实际变量值(事实,即使 artifact 缓存复用也各自留档)
  quantity            int NOT NULL,               -- 由 computePrintQuantity 算出(kernel),人可改,改动留痕
  quantity_explain    jsonb,                      -- kernel 的计算解释(件数×每件用量+损耗%…)
  supplier_id         uuid REFERENCES suppliers(id),
  unit_price          numeric, currency text DEFAULT 'RMB',
  status              text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','rendered','approved','ordered','received','closed','cancelled')),
  needed_by           date,                       -- 要货期(对齐订单排期)
  notes               text,
  created_by          uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE INDEX idx_pj_order ON print_jobs(order_id);
CREATE INDEX idx_pj_status ON print_jobs(status) WHERE status NOT IN ('closed','cancelled');

-- 6) 采购执行层挂接(唯一动到既有表的地方:一列,可空,纯加法)
ALTER TABLE procurement_line_items ADD COLUMN IF NOT EXISTS print_job_id uuid REFERENCES print_jobs(id);
```

RLS 同既有模式:登录可读;写操作 action 层按角色把关(模板=业务执行/采购/管理员;印刷单流转=采购)。

## 五、对象模型与版本化

- **PackagingTemplate**:资产壳,`code` 稳定不变。改版式 = 发新 Version,**永不复制模板**。
- **PackagingTemplateVersion**:**不可变**。编辑期(未 active、未被引用)可改;一旦 `active` 或被任何 print_job 引用 → 冻结,再改必发新版。`variables_schema` 是发版时对 packaging_variables 的物化快照 —— 渲染只认快照,后续编辑变量不影响历史。
- **PackagingVariable**:变量定义(名/类型/必填/默认值/自动取值线索)。变量是**渲染输入**,永远不是物料 SKU。
- **PrintJob**:钉死 `template_version_id`(不是 template_id)—— 半年后回看,印的是哪一版、什么变量、多少数量,全部可追溯。
- 一模板同刻仅一个 active 版本(部分唯一索引硬保证)。

## 六、渲染流(确定性)

```
订单/PO/款色码明细
   │  resolvePrintVariables(kernel):按 source_hint 自动取值(po_number←customer_po,
   │  size←line_item,composition←BOM 面料成分…),缺的人补,人可改
   ▼
变量值 JSON ──variablesHash(kernel)──► 查 rendered_artifacts 缓存
   │ 命中 → 直接复用文件(百万变体的关键:去重)          │ 未命中
   ▼                                                      ▼
print_job.artifact_id                     renderSpec(kernel,纯函数) → Render Service:
                                          pdf_background + 排版指令 → PDF(印刷用)
                                          → PNG(预览) → 存 Storage → 落 rendered_artifacts
```

确定性保证:同 (版本, 变量) 必产同一文件 —— 字体随版本固化、排版指令是纯函数输出、无时间戳入画(日期是变量,不是 now())。**渲染件是缓存不是真相**:真相 = 版本 + 变量,文件可随时重算。

## 七、印刷单流(采购买的是它)

```
draft(变量已填,数量=computePrintQuantity 建议,人可调,调整留痕)
  → rendered(渲染件就绪,预览可看)
  → approved(采购/业务执行确认稿件 —— 印错唛头是重大质量事故,必须人签)
  → ordered(下印刷厂:写 procurement_line_items 一行,print_job_id 挂接,
            供应商=印刷厂(suppliers 表),走既有采购队列/催货/收货 UI)
  → received(印刷品到厂:更新状态即止 —— 不入库存!标签随大货消耗,不盘点)
  → closed / cancelled
```

**数量计算(kernel,单一算法)** `computePrintQuantity`:
- 洗水唛/吊牌/贴纸:Σ(款色码件数) × 每件用量 + 损耗%(默认 3-5%,按类别配置);
- 箱唛/外箱贴:装箱数(件数 ÷ 装箱率,向上取整) + 备用;
- 输出 `quantity_explain`(哪个数怎么来的),UI 只展示,不自算。

**与采购五层脊柱(ADR-004)的关系**:印刷单**不进** materials_bom / material_requirements / procurement_items 归并层(那是物料的路);它从 print_jobs 直接挂入**执行层** procurement_line_items(print_job_id 列),复用下单/催货/到货队列与供应商体系,但**绝不产生库存流水**。

## 八、集成

| 集成点 | 方式 |
|---|---|
| **Order** | 订单详情新 tab「包装印刷」:该单的 print_jobs 列表 + 从模板发起;变量自动取自 orders/customer_po/order_line_items/materials_bom |
| **生产任务单(MO)** | 渲染件 PDF 作为 MO 附件/企微群发工厂(复用 wecom 文件送达),工厂照稿贴挂 |
| **Procurement** | 执行层挂接(上节);采购中心队列直接可见「印刷类」行,含未到货数量 |
| **SCM Kernel** | packaging-kernel.ts 四个纯函数进 `npm run check` 单测;ADR-005 单一计算源表追加两行:印刷数量=computePrintQuantity,渲染指令=renderSpec |
| **Execution Kernel** | 印刷单状态推进走 action 薄壳;approved 前置于 ordered(状态机校验);needed_by 逾期进现有风险/催办体系 |
| **AI(只辅助)** | 上传客户 label spec/艺术稿 → AI 起草「变量名→落位」映射草稿,人审后保存为版本;AI 永不改真相、不算数量 |

## 九、迁移策略(纯加法,零 breaking)

1. **新表 5 张 + procurement_line_items 加 1 可空列 + Storage bucket `packaging-artifacts`**。不动 material_master / materials_bom / MRP / 库存任何一行。
2. **存量清理(可选,后置)**:已错进物料库的「印刷类物料」(如各语言洗水唛)→ 人工识别 → 建模板 → 原物料行归档(不删,历史 BOM 引用保留)。提供一份盘点 SQL 供人审,不自动迁。
3. **回滚**:DROP 5 张新表 + 1 列即回原状,无任何副作用。

## 十、分期

- **PK-P1 模板底座**:templates/versions/variables 三表 + CRUD + 版本化(发版/冻结/active 切换)+ 防重复 + 模板库页面。
- **PK-P2 渲染引擎**:packaging-kernel(4 纯函数入 check)+ Render Service(pdf-lib 底版叠字)+ 渲染件缓存 + 预览。
- **PK-P3 印刷单闭环**:print_jobs 状态机 + 订单「包装印刷」tab + 数量建议 + 采购执行层挂接 + 企微发稿。
- **PK-P4 AI 辅助**:客户稿解析→变量映射草稿;历史印刷价参考。

## 十一、明确不做(Forbidden 重申)

复制模板 ✗ · 每语言/尺码/客户建库存 SKU ✗ · 渲染 PDF 进物料主数据 ✗ · 变量进物料主数据 ✗ · 模板存数量 ✗ · 印刷品记库存余额/参与 MRP ✗ · SQL view 做计算 ✗(ADR-005)
