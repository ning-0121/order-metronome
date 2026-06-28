# QIMO OS 文档体系(四层,固定)

> 目的:让文档**不越来越乱**。固定四层,每份文档都有明确的位置。

```
/docs
├── 00-Constitution/
│     Constitution.md          ← 最高原则(10 条,几乎不改,Frozen)
│     README.md                ← 本文件(文档体系地图)
├── ADR/                       ← 架构决策记录(经常新增,可升级进 Constitution)
│     ADR-001.md ...
├── Domains/                   ← 各业务域的长期设计(稳定演进)
│     Order.md  Procurement.md  Production.md  Warehouse.md  Finance.md
└── Designs/                   ← 每个阶段的实施方案(短期、可归档)
      O1.md  O2.md  B1.md ...
```

## 各层职责
| 层 | 内容 | 变更频率 | 谁能改 |
|---|---|---|---|
| **Constitution** | 最高原则,全员遵守 | 几乎不改(Frozen) | 仅经 ADR 验证后升级 |
| **ADR** | 重要架构决策(为什么这么定) | 经常新增 | 任何重大决策 |
| **Domain** | 各业务域长期架构设计 | 稳定演进 | 域设计变更 |
| **Design** | 阶段实施方案(O1/O2…) | 短期、做完归档 | 每阶段开工前 |

## 开发纪律(最重要)
**当发现新的设计方向时,优先修改 Domain Design 或 ADR,而不是频繁修改 Constitution。**
**只有经过多个阶段验证、确认能长期成立的原则,才允许升级进入 Constitution。**
→ Constitution 越来越稳,变化快的内容沉淀到 ADR / Domain。(同条已写入 `../../CLAUDE.md`)

## 当前索引
- **Constitution**:[Constitution.md](Constitution.md) — V1.0 Frozen(10 条)
- **ADR**:[ADR/](../ADR/) — ADR-001(本次文档重构 + Constitution V1.0 冻结)、ADR-002(Material Requirement 为跨域脊柱)、ADR-003(Order ⊥ Production 解耦)
- **Domains**:[Order.md](../Domains/Order.md)(订单域 V3.0,Manufacturing Order)、[Procurement.md](../Domains/Procurement.md)(供应链域 V2.1)、Production/Warehouse/Finance(待补)
- **Designs**:[O1.md](../Designs/O1.md)/[O1a.md](../Designs/O1a.md)(物料主数据+录入,已上线)、[B1.md](../Designs/B1.md)(MRP,已上线)、O2.md(Manufacturing Order,进行中)、[Procurement-Flow.md](../Designs/Procurement-Flow.md)

## 未迁移的 legacy 文档
`docs/` 根目录仍有运营/审计/手册类文档(PRODUCT_MANUAL、runtime-phase1、各类 audit、SOP、product-boundary、system-map 等),不属于 QIMO OS 架构宪法体系,**保留原位,渐进迁移**。`qimo-os-architecture.md` 是早期总览(§0 宪法部分已被本 Constitution 取代,其余资产盘点/路线仍有效)。
