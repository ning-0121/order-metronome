# QIMO OS — Domain Map（13 一级域详情)

> 本文件是 [`../00-Constitution/Enterprise-Architecture.md`](../00-Constitution/Enterprise-Architecture.md) **第 3 章** 的展开:每个一级域的 职责/核心对象/生命周期/数据流/关系/三年路线。
> **Status**: V1.0(随总架构锁定)。**图例**:✅ 已建 · 🟡 部分 · ⬜ 规划。

## 价值流 → 13 一级域
```
客户需求 → Customer        🟡
订单     → Order           ✅
产品开发  → Product         ⬜  ← 最大缺口·未来核心
原辅料   → Material         ✅
生产计划  → Manufacturing Planning(MP)  ✅
采购     → Procurement      🟡（核料项✅)
（并行)  → Supplier         ⬜  ← 升一级
仓库     → Warehouse        ⬜
生产     → Production        🟡  ← 与 MP 完全解耦
质检     → Quality          🟡  ← 升一级
包装     → Packing          ⬜  ← 升一级·独立成域
出运     → Shipment         🟡
收款     → Finance          🟡
```
> Platform Services(横切,非域):AI / Analytics / Notification / Automation / Document。基础支撑:Employee / Factory。详见总架构第 5 章。
> **Constitution 锚点**:Order/Product/Material/MP 对象都"表达需求";Production"实现需求",经 MP 解耦(07/08)。Product/Material Master/Supplier 跨订单可复用,被 Order 引用、不被拥有。

---

## 一级域定义(13)

### Customer Domain 🟡
- **职责**:客户档案、客户标准辅料库、年度目标、沟通/PO。
- **核心对象**:Customer(`customers`)、Customer Trim Library、Sales Target。
- **生命周期**:潜在→合作→年度目标→复盘。
- **关系**:Order 源头;喂 Product(客户款)、Material(客户标准库)。
- **3 年**:客户中心、客户画像、AI 客户洞察。

### Order Domain ✅
- **职责**:表达客户需求(PO→企业内部订单),不定义产品工艺。
- **核心对象**:Customer Order = `orders` + `order_line_items`(款×色×码)。
- **生命周期**:草稿→确认→执行(18 关卡)→完成→复盘。
- **关系**:上游总源,一切挂 order_id(Constitution 01);引用 Product。
- **3 年**:Order Builder、AI 预填、贸易单/外发单。

### Product Domain ⬜ —— 最大缺口·未来核心
- **职责**:拥有"款"的一切,产品定义的真相源。
- **核心对象**:Product(款式/版型/尺码/颜色)、Product BOM(款物料模板)、Tech Pack、样衣 Sample、款图。
- **生命周期**:开发→打样→确认→量产款→归档(可复用)。
- **关系**:Order 引用 Product;Material Package(每单 BOM)**从 Product BOM 实例化**;MP 引用 Product。**跨订单可复用**。
- **3 年**:款库、AI Designer/Pattern/BOM 围绕 Product;**解决 P1′ 缺口**(BOM 挂 product/order_line_item,采购核料来源精确到款)。
- **现状**:款/色/码散在 order_line_items,BOM 在 materials_bom,样衣/TechPack 在附件 → Product Domain **收拢**。

### Material Domain ✅
- **职责**:用什么料;可复用主数据 + 每单 BOM(**开发单耗**)。
- **核心对象**:Material Master(`material_master`)+ Material Package(`materials_bom`)。
- **关系**:实例化自 Product BOM;喂 Procurement。
- **3 年**:BOM 挂产品维度、物料知识库、多 UoM。

### Manufacturing Planning Domain（MP)✅ —— 原 Manufacturing 改名
- **职责**:生产任务/工厂准备/生产说明/生产资料(只表达需求,**无工艺/MES**)。
- **核心对象**:Manufacturing Order(`manufacturing_orders`,生产任务单)。
- **生命周期**:draft→reviewing→confirmed→executing(下发工厂)→closed。
- **关系**:引用 Order/Product/Material → 生成生产任务单;**发布给 Production**。
- **3 年**:客户确认版、AI 草稿(守闸门)。

### Procurement Domain 🟡
- **职责**:需求提出后怎么买;系统归并+计算,采购确认(ADR-004)。
- **核心对象**:Material Requirement(系统 MRP)→ **Procurement Item(采购核料项)** → Purchase Order(执行)。
- **生命周期**(采购项):draft→reviewing→confirmed→ordered→partially_received→completed→closed。
- **关系**:读 Material/Requirement(只读引用);用 Supplier;下游 Warehouse/Finance。
- **3 年**:P2 PO拆单 / P3 到料对账 / P5 跨订单核料+替代链+外协。

### Supplier Domain ⬜ —— 升一级
- **职责**:供应商主数据、评级、价格史、MOQ、报价、交期、质量。
- **核心对象**:Supplier(lead/MOQ/联系人/价格史/评级)。
- **关系**:喂 Procurement;接 Quality(来料质量评级)。
- **3 年**:供应商门户、报价比价、绩效评级、合格供应商库。

### Warehouse Domain ⬜
- **职责**:实物物料生命周期;收货/入库/库存/库位/批次/发料。
- **核心对象**:Receiving、Inventory、Issue(发料)。
- **关系**:接 Procurement(到料);喂 Production(领料);反哺 MRP 库存扣减。
- **3 年**:库存可视、批次追溯、余料复用、安全库存预警。

### Production Domain 🟡 —— 与 MP 完全解耦
- **职责**:真正生产;工艺/工序/SMV/IE/吊挂/MES/报工(Constitution 08)。
- **核心对象**:Production Order、工艺路线、Production Reports、报工。
- **生命周期**:接 MP→工艺/排产→开裁(料齐放行)→车缝→后整→完工。
- **关系**:消费 MP + Warehouse;产出给 Quality;**工艺永不回订单域**。
- **3 年**:工艺结构化、APS、MES/吊挂、产能节拍。

### Quality Domain 🟡 —— 升一级·进主链
- **职责**:质量贯穿全链。IQC(来料)→IPQC(中期)→FQC(尾期)→OQC(出货前)。
- **核心对象**:Inspection(IQC/IPQC/FQC/OQC)、验货报告、不良/退货。
- **关系**:影响 Production(放行)、Procurement/Supplier(来料评级)、Customer(退货)、Finance(质量成本)。
- **3 年**:AI 缺陷识别、质量追溯、供应商质量联动。

### Packing Domain ⬜ —— 升一级·独立成域
- **职责**:包装部门(≠生产≠出运)。吊牌/洗标/Barcode/Polybag/Sticker/Carton/Mix·Assort·Prepack/Carton Mark/装箱率/重量/尺寸/封箱。
- **核心对象**:Packing Spec(包装规范)、Packing Template、Carton(装箱)、Barcode Rule、Carton Library。
- **生命周期**:接生产完工/返修→按客户包装规则装箱→封箱→交出运。
- **关系**:接 Production/Quality;喂 Shipment;受 Customer 包装规则约束(Amazon/Costco/Ross/TJX/DDS)。
- **3 年**:Packing Template/Specification、Carton Library、Barcode Rule、按客户包装规则自动校验。

### Shipment Domain 🟡
- **职责**:订舱、报关、出运、交付。
- **核心对象**:Shipment、Booking。
- **关系**:接 Packing/Quality(OQC)→ 触发 Finance 开票。
- **3 年**:结构化出运对象、物流追踪、多式联运。

### Finance Domain 🟡
- **职责**:成本/利润/发票/收付款/对账。
- **核心对象**:Cost Baseline(`order_cost_baseline`)、Financials、Invoice、Payment。
- **关系**:消费全链成本;价格按 `CAN_SEE_FINANCIALS` 门控。
- **3 年**:应付(采购)/应收(客户)、发票、现金流。

---

## 跨域脊柱(SSOT)
- One Order(一切挂 order_id);跨订单可复用对象 Product/Material Master/Supplier(被引用不被拥有);Material Requirement = 采购/仓库/生产脊柱(ADR-002);引用不复制 + 字段归属(Constitution 02/04)。

## 三年路线(总)
- **当前(~90%)**:Order/Material/MP ✅ + Procurement 核料项 ✅ → 收尾 P 域。
- **第 1 年**:打通 Procurement→Warehouse→Production→Quality→**Packing**→Shipment→Finance(每域先 80%,DP-7);Supplier Master;**Product Domain 起步**。
- **第 2 年**:Product 款库 + 跨订单核料、库存批次、工艺结构化、应收应付、Quality/Packing 联动。
- **第 3 年**:AI(Designer/Pattern/BOM 围绕 Product;Supply Brain,守 DP-5)、APS、多工厂。
