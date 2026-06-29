# QIMO OS — Business Event Catalog（业务事件目录)

> Enterprise Architecture V1.0 第 ⑤ 层。**驱动企业的不是页面,是事件。** 所有 Domain 监听事件;AI Agent / Automation / Workflow / Robot / Notification 全部围绕事件工作。
> **命名**:`名词 + 过去式`(已发生的事实),如 `OrderCreated`。事件**只陈述事实**,不含 UI。

## 事件目录(主链)
| 事件 | 来源域 | 触发 | 监听者 → 动作 | 状态 |
|---|---|---|---|---|
| **OrderCreated** | Order | 订单确认 | Product/Material/MP/Procurement/Finance → 各自初始化 | ✅ |
| **ProductConfirmed** | Product | 款式/BOM 确认 | Material(实例化 BOM)、MP | ⬜ |
| **MaterialPackageConfirmed** | Material | 业务提交采购 | Procurement → 跑 MRP / 生成 Procurement Items / Supplier 推荐 / 风险检测 | ✅(现为函数调用,未事件化)|
| **MaterialRequirementGenerated** | Procurement·系统 | MRP 算完 | Procurement(核料归并)、Analytics | ✅ |
| **ProcurementItemConfirmed** | Procurement | 采购确认核料项 | Purchase Order(可下单)、Finance(应付预估)、Supplier | 🟡 |
| **PurchaseOrderPlaced** | Procurement执行 | 下单 | Supplier(通知)、Warehouse(待收货)、Finance | 🟡 |
| **GoodsReceived** | Warehouse | 到料入库 | Procurement(到料进度)、Inventory(增)、Quality(IQC)| ⬜ |
| **ManufacturingOrderReleased** | MP | 下发工厂 | Production(据此补工艺/排产)| ✅(状态有,未事件化)|
| **ProductionReleased** | Production | 料齐放行开裁 | Quality(IPQC)、Warehouse(领料/扣库)| 🟡 |
| **QualityPassed / QualityFailed** | Quality | FQC/OQC 结论 | Packing(放行/返修)、Supplier(来料评级)、Finance(质量成本)| 🟡 |
| **PackingCompleted** | Packing | 装箱封箱 | Shipment(可订舱)| ⬜ |
| **ShipmentBooked** | Shipment | 订舱 | Finance、Customer(通知)、Analytics | 🟡 |
| **ShipmentDispatched** | Shipment | 出运 ETD | Finance(开票)、Customer | 🟡 |
| **InvoiceIssued** | Finance | 开票 | Customer(应收)| ⬜ |
| **PaymentReceived** | Finance | 收款 | Analytics(回款)、Customer(目标达成)| ⬜ |

## 事件原则
1. **事件是事实,不是命令**:`QualityPassed` 陈述"质检通过了",监听者各自决定做什么。
2. **来源域唯一**:每个事件只有一个产生它的域(Constitution 04 数据所有权延伸)。
3. **监听者解耦**:产生方不知道谁在听;新增监听者不改产生方(未来加 AI/Automation 零侵入)。
4. **AI 监听,不产生真相**:AI 监听事件做建议/检查/推荐,**人工确认后才产生新事件**(DP-5)。

## 演进
- **当前**:多数流转是**函数直接调用**(如 submitBomToProcurement 内联跑 MRP)。已有雏形:`runtime_events`(投影层 append-only)。
- **第 1 步(轻)**:把关键流转**标注为事件**(本目录),代码仍直调,但语义对齐。
- **第 2 步**:落 Event Bus / Outbox,监听者订阅(Automation/AI/Notification 接入)。
- **第 3 步**:全事件驱动,AI Agent / Workflow 围绕事件编排。

> 新增任何写操作,先回答 DoD 第 4 问:**产生什么 Business Event?** 答不出 = 这个操作的业务意义没想清。
