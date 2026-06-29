# QIMO OS 文档体系（五层 + 七段流程,固定)

> 目的:让文档**不越来越乱**。每份文档有明确位置;每次开发走固定流程。

## 统一开发流程（七段)
```
Constitution（系统是什么,冻结)
  → Development Principles（我们怎么造)
    → ADR（重要架构决策)
      → Domain（各业务域长期设计)
        → Design（阶段实施方案)
          → Coding（编码,守边界)
            → DoD（交付标准,必过)
```

## 目录结构（五层文档 + DoD)
```
/docs
├── 00-Constitution/
│     Constitution.md            ← 系统是什么(架构最高原则,10 条,Frozen)
│     Development-Principles.md   ← 我们怎么造(开发哲学 DP-1~5)
│     Definition-of-Done.md       ← 交付标准(DoD,每次开发必过)
│     README.md                   ← 本文件(体系地图)
├── ADR/                          ← 架构决策记录(经常新增)
├── Domains/                      ← 各业务域长期设计(稳定演进)
└── Designs/                      ← 阶段实施方案(短期、可归档)
```

## 各层职责
| 层 | 内容 | 描述什么 | 变更频率 |
|---|---|---|---|
| **Constitution** | 架构最高原则 | **系统是什么** | 几乎不改(Frozen,≤10 条)|
| **Development Principles** | 开发哲学 | **我们怎么造** | 长期稳定 |
| **Definition of Done** | 交付标准 | **何谓"完成"** | 长期稳定 |
| **ADR** | 重要架构决策(为什么)| 决策依据 | 经常新增 |
| **Domain** | 各业务域长期设计 | 域架构 | 稳定演进 |
| **Design** | 阶段实施方案(O1/P1…)| 怎么落地 | 短期、做完归档 |

**分层铁律**:Constitution 只写"是什么";Development Principles 只写"怎么造";二者严格分层,不混杂。域规则进 ADR/Domain,阶段细节进 Design。

## 修宪纪律
**发现新设计方向时,优先改 ADR / Domain / Design,而不是改 Constitution。** 只有经多阶段验证、确认长期成立的原则才允许升级进 Constitution → Constitution 越来越稳,不越来越长。(同条已写入 `../../CLAUDE.md`)

## 当前索引
- **Constitution**:[Constitution.md](Constitution.md) — V1.0 Frozen(10 条)
- **Development Principles**:[Development-Principles.md](Development-Principles.md) — DP-1 闭环优先 / DP-2 先 80% / DP-3 系统做机械活 / DP-4 面向十年 / DP-5 业务优先于软件
- **Definition of Done**:[Definition-of-Done.md](Definition-of-Done.md) — 设计/编码/数据库门禁/交付 四段 DoD + 硬闸
- **ADR**:[ADR/](../ADR/) — 001 文档体系+宪法冻结 / 002 Material Requirement 脊柱 / 003 Order⊥Production / 004 Procurement 分层与核料
- **Domains**:[Order.md](../Domains/Order.md)、[Procurement.md](../Domains/Procurement.md)、Production/Warehouse/Finance(待补)
- **Designs**:[O1](../Designs/O1.md)/[O1a](../Designs/O1a.md)、[B1](../Designs/B1.md)、[O2](../Designs/O2.md)(已上线)、[P1](../Designs/P1.md)(采购核料项,已上线)

## 未迁移的 legacy 文档
`docs/` 根目录仍有运营/审计/手册类(PRODUCT_MANUAL、runtime-phase1、各类 audit、SOP、system-map 等),不属架构宪法体系,保留原位渐进迁移。`qimo-os-architecture.md` 是早期总览(§0 宪法已被 Constitution 取代)。
