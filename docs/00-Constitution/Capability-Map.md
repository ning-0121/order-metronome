# QIMO OS — Business Capability Map（业务能力地图)

> Enterprise Architecture V1.0 第 ② 层。**Capability 十年稳定;Domain 是它的当前实现,可演进**(一个能力将来可拆多个域,如 SAP/Oracle)。
> 价值流回答"企业怎么走";能力回答"需要哪些本事";域回答"现在谁来实现"。

## 价值流 → 能力 → 当前域
| 价值流 | 业务能力(Capability,稳定)| 当前实现 Domain |
|---|---|---|
| 客户需求 | Customer Management(客户/标准库/年度目标)| Customer |
| 订单 | Order Management(接单/确认/明细/进度)| Order |
| 产品开发 | Product Development(款式/版型/BOM/样衣/TechPack)| Product |
| 原辅料 | Material Management(主数据/Package/单耗)| Material |
| 生产计划 | Manufacturing Planning(生产任务/工厂准备/资料)| Manufacturing Planning |
| 采购 | **Sourcing**(寻源/核料)· **Cost Management**(价/损耗/MOQ)· **Purchase Order**(下单)| Procurement |
| 供应商 | Supplier Management(主数据/评级/价格史/报价)| Supplier |
| 仓库 | Receiving(收货)· Inventory Management(库存/库位/批次/发料)| Warehouse |
| 生产 | Production Execution(工艺/排产/MES/报工)| Production |
| 质检 | Quality Control(IQC/IPQC/FQC/OQC)| Quality |
| 包装 | Packing Management(吊牌/装箱/Carton/Barcode/Prepack)| Packing |
| 出运 | Shipment(订舱/报关/出运)· Logistics(追踪)| Shipment |
| 收款 | Financial Management(成本/利润/应收应付/发票)| Finance |

## 横切能力(Platform,不属单一价值流)
| 能力 | 说明 |
|---|---|
| Intelligence(AI)| 解析/建议/检查/推荐,横跨所有域;**不拥有数据**(DP-5)|
| Analytics | 风险/绩效投影 |
| Notification | 通知 |
| Automation | 物化/定时/规则/事件编排 |
| Document | 单据/附件/模板 |
| Identity & Access | 用户/角色/权限(Employee)|

## 能力 → 域 的演进(为什么分两层)
- 现在:**采购**的 Sourcing / Cost / PO 三能力都在 **Procurement Domain** 里。
- 将来量大了:可拆成 **Sourcing Domain / Cost Domain / Purchase Order Domain** —— **能力名不变,域可拆**,上层价值流和能力图**不动**。
- 这就是十年不推倒的关键:把"稳定的能力"和"可演进的实现"分开。

> 新建/拆分域时:先确认它实现**哪个稳定能力**,再过 DoD 的 Architecture Gate + Future Gate。
