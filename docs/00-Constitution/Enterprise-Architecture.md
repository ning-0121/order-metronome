# QIMO OS — Enterprise Architecture V1.0

> **QIMO OS = Enterprise Operating System**（绮陌的企业操作系统,不是订单/采购/生产软件)。
> **Status**: V1.0 蓝图(待锁定)。锁定后所有开发**按图施工**,围绕这张总架构推进,不围绕功能/页面。
> **Date**: 2026-06-29 · 遵守 `Constitution.md` + `Development-Principles.md` + `Definition-of-Done.md`。

---

## 🪐 系统灵魂（第一句话,高于一切)

> **Every piece of data has exactly one owner.**
> **Every business capability has exactly one domain.**
> **Every domain exists to serve one business flow.**
>
> 每一份数据只有一个拥有者。每一种业务能力只有一个所属 Domain。每一个 Domain 都只服务于价值流中的一个环节。

---

## 0. 八层架构栈

```
QIMO OS — Enterprise Operating System
──────────────────────────────────────────
① Business Flow      价值流（企业真正怎么走,十年不变)
② Business Capability 业务能力（十年稳定,SAP/Oracle/MS 都这么分)
③ Domain             业务域（可演进:一个能力将来可拆多个域)
④ Business Objects   业务对象（每个对象只拥有自己的数据)
⑤ Business Events    业务事件（驱动系统的不是页面,是事件)★
⑥ Lifecycle          生命周期（对象随事件推进,不复制)
⑦ Platform Services  平台服务（横切:AI / Analytics / Notification / Automation / Document)
⑧ Presentation       表现层（Web / App / BI / Robot / API —— 都只是出口,不是系统)
```
- **稳定性递减**:① 几乎永不变 → ③ 可演进 → ⑧ 随技术换。
- **★ Business Events 是新增的关键层**:真正驱动企业的不是页面,是**事件**。`OrderCreated` / `MaterialPackageConfirmed` / `ProductionReleased` / `QualityPassed` / `PackingCompleted` / `ShipmentBooked` / `PaymentReceived` —— 所有 Domain 监听事件;未来 AI Agent / Automation / Workflow / Robot / Notification 全部围绕事件工作。详见 [`Event-Catalog.md`](Event-Catalog.md)。
- **AI 不是 Domain,是 Platform Service(横切智能)**:所有 Domain 调用 AI,**AI 不拥有任何数据**(Constitution 06 / DP-5)。
- **Center 是 UI,Domain 才是系统**:以后统一说 Order Domain / Procurement Domain,不说 Order Center / 采购中心。一个 Domain 可有 Web/Mobile/AI/API/Robot/BI 多个入口,**页面名字不得影响架构**。

## 0.1 EA 驱动开发（铁律)
**任何需求,动一行代码前先回答四问;答不出 = 不许写:**
1. 属于哪个 **Business Flow**?
2. 属于哪个 **Domain**?
3. 修改哪个 **Business Object**?
4. 产生什么 **Business Event**?

> 架构闭环:**Enterprise Architecture → Domain → Object → Event → Lifecycle → Implementation。**

## 0.2 本架构的组成文档
| 章 | 文档 | 说明 |
|---|---|---|
| 价值流 / 数据所有权 / Platform / Presentation | 本文件 | 总图 |
| Capability Map | [`Capability-Map.md`](Capability-Map.md) | 能力地图(十年稳定)|
| Domain Map(13 域)| [`../Domains/Domain-Map.md`](../Domains/Domain-Map.md) | 谁负责 |
| **Object Relationship Map** | [`Object-Relationship-Map.md`](Object-Relationship-Map.md) | **数据怎么流(优先级最高)** |
| Business Event Catalog | [`Event-Catalog.md`](Event-Catalog.md) | 事件目录 |
| Domain Template | [`Domain-Template.md`](Domain-Template.md) | 每个 Domain 必备九章节标准 |

---

## 第 1 章 — Business Flow（价值流,十年不变)
```
客户需求 → 订单 → 产品开发 → 原辅料 → 生产计划 → 采购 → 仓库 → 生产 → 质检 → 包装 → 出运 → 收款
```
- 老板/业务/采购/程序员都看得懂。供应商在「采购」处并行输入;质检 IQC/IPQC/FQC/OQC 贯穿全链。

## 第 2 章 — Business Capability Map（业务能力,十年稳定)
| 价值流 | 业务能力（Capability)|
|---|---|
| 客户需求 | Customer Management |
| 订单 | Order Management |
| 产品开发 | Product Development（款式/版型/BOM/样衣/TechPack)|
| 原辅料 | Material Management |
| 生产计划 | Manufacturing Planning |
| 采购 | **Sourcing · Cost Management · Purchase Order**（采购能力将来可拆多个域)|
| (并行) | **Supplier Management** |
| 仓库 | Receiving · Inventory Management |
| 生产 | Production Execution（工艺/MES/报工)|
| 质检 | Quality Control（IQC/IPQC/FQC/OQC)|
| 包装 | **Packing Management**（吊牌/装箱/Carton/Barcode/Prepack)|
| 出运 | Shipment · Logistics |
| 收款 | Financial Management |
> Capability 十年稳定;Domain 是它的当前实现,可演进(如 Sourcing 将来可独立成域)。

## 第 3 章 — Domain Map（13 一级域 + 平台服务)
**13 一级域**:Customer · Order · **Product** · Material · **Manufacturing Planning** · Procurement · **Supplier** · Warehouse · Production · Quality · **Packing** · Shipment · Finance
**Platform Services(横切,非域)**:AI · Analytics · Notification · Automation · Document
**基础支撑**:Employee(用户/角色)· Factory(工厂档案)

| 域 | 价值流 | 状态 |
|---|---|---|
| Customer | 客户需求 | 🟡 |
| Order | 订单 | ✅ |
| **Product** | 产品开发 | ⬜ 最大缺口·未来核心 |
| Material | 原辅料 | ✅ |
| **Manufacturing Planning** | 生产计划 | ✅(原 Manufacturing 改名)|
| Procurement | 采购 | 🟡(核料项✅)|
| **Supplier** | (并行采购) | ⬜ 升一级 |
| Warehouse | 仓库 | ⬜ |
| Production | 生产 | 🟡(与 MP 完全解耦)|
| Quality | 质检 | 🟡 升一级 |
| **Packing** | 包装 | ⬜ 升一级·独立 |
| Shipment | 出运 | 🟡 |
| Finance | 收款 | 🟡 |

> **每个域的 职责/核心对象/生命周期/数据流/关系/三年路线 详见 [`../Domains/Domain-Map.md`](../Domains/Domain-Map.md)。**
> **Packing 独立的理由**:责任主体是包装部门(≠生产≠出运);拥有 吊牌/洗标/Barcode/Polybag/Sticker/Carton/Mix·Assort·Prepack/Carton Mark/装箱率/重量/尺寸/封箱;Amazon/Costco/Ross/TJX/DDS 大量依赖包装规则;未来 Packing Template / Specification / Carton Library / Barcode Rule 都属它。

## 第 4 章 — Data Ownership（数据所有权,灵魂落地)
**每一份数据只有一个拥有者**(Constitution 04)。冲突时以拥有者为准,其余只引用。
| 数据 | 唯一拥有者 |
|---|---|
| 客户/年度目标 | Customer |
| 订单/款色码/交期 | Order |
| 款式/版型/BOM模板/样衣/TechPack | **Product** |
| 开发单耗/物料主数据/每单 BOM | Material |
| 生产任务/生产资料 | Manufacturing Planning |
| 大货单耗/核料/采购量/价格 | Procurement |
| 供应商/评级/价格史/MOQ | Supplier |
| 库存/批次/到料 | Warehouse |
| 工艺/SMV/报工/MES | Production |
| 质检结论/不良 | Quality |
| 装箱/Carton/Barcode | Packing |
| 出运/订舱 | Shipment |
| 成本/发票/收付款 | Finance |

## 第 5 章 — Platform Services（横切,所有域调用,不拥有数据)
| 服务 | 职责 | 红线 |
|---|---|---|
| **AI** | Cross-Layer Intelligence:解析/建议/检查/推荐,横跨所有域 | **永不拥有真相、永不直接写库**(Constitution 06 / DP-5),人工确认才入库 |
| Analytics | 风险/绩效投影(读全域)| 只读投影 |
| Notification | 通知 | 横切 |
| Automation | 物化/定时/规则自动化 | 受 FeatureFlag |
| Document | 单据/附件/模板(Evidence≠Data;Build once)| 附件不参与计算 |

## 第 6 章 — Presentation Layer（表现层,只是出口)
Web · App · BI · Robot · API —— 都是表现层,**不是系统**。底层 Business Objects + Lifecycle 不变,出口可随技术更换。

---

## 后续章节(随业务自然演进补全)
- 第 7 章 Object Relationship(对象关系全图)
- 第 8 章 AI Strategy(横切智能落地,守 DP-5)
- 第 9 章 Capability → Domain 演进矩阵(哪个能力何时拆域)

> **施工纪律**:本架构锁定后,每个域/对象开工前先过 DoD 的 **Architecture Gate**(属哪个域/数据所有权/有无重复真相)+ **Future Gate**(三年/十工厂还成立吗)。开发围绕这张图,不围绕功能或页面。
