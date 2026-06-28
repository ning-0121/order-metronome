# QIMO OS — Supply Chain Domain Architecture V2.1

> 状态:**架构升级(待审批)**。不写代码、不写 migration、不动数据库。
> 日期:2026-06-28 · 作者:以 CTO + Supply Chain Architect 角度
> 取代 v2.0 的对象模型层(v2.0 的"采购中心订单优先"方向保留;v2.1 把对象模型升级到五年不返工)。
> 铁律不变:Evolution not Rewrite / One Order / One Data / 复用 Runtime·Matter·Briefing·Batch·现有表 / 不重复造对象 / 向后兼容。

---

## 0. 对你四项升级的诚实评判(不迎合)

| 升级 | 我的判断 | 关键理由 |
|---|---|---|
| **1. Purchase Plan → Material Plan** | ✅ 方向对,但**必须细化**,否则会变"上帝对象" | 真正跨域的脊柱不是 Material Plan 这个**头**,而是它下面的**物料需求行(Material Requirement)**。采购/仓库/生产/出运都挂在**行**上,不是头上。见 §2。 |
| **2. MRP → Explainable MRP** | ✅ 强烈认同,并**再升一级** | 不只存过程,应做成**可重算的投影**(复用 Runtime 的 event→projection→explain 模式)。**并且你漏了"时间维度"** —— 见下方红线。 |
| **3. Version → Snapshot** | ✅ 强烈认同 | 这就是 ERP 的"工程变更管理(ECM)"。但 Snapshot 要做成**头+行(可查询/可审计)**,不是一坨 JSONB。见 §4。 |
| **4. AI Supply Brain** | ✅ 认同 | 它应是**决策层**,在已有投影(MRP explain + Matter + Confidence)之上做排序与推荐,**不是新引擎**。见 §5。 |

### 🔴 我必须指出的空白(你四项都没提,但五年内一定返工):**MRP 只有数量,没有时间**
你的 v2.0/升级里 MRP = `PO×单耗×(1+损耗)−库存−余料 = 采购量`。这只回答"买多少",没回答"**什么时候必须下单**"。
但你自己在 AI Supply Brain 里要的是"**哪些订单建议提前采购 / 哪些建议等待 / 哪些可能断料**" —— 这些**没有时间维度根本算不出来**。
真正的 MRP(SAP/Kinaxis 的本质)是**时间分段(time-phased)**的:
```
需到日(开裁前) − 供应商交期(lead time) = 最晚下单日(order-by date)
```
**因此 Explainable MRP 必须同时产出"采购量 + 最晚下单日",否则 AI Supply Brain 是空中楼阁、且将来补时间维度要重构 requirements 表。** 这是 v2.1 的硬性补强(§3)。

---

## 1. Architecture Upgrade Summary

v2.1 把供应链域从"采购流程"升级为"**以物料需求为脊柱的供应链计划域**":

```
Order
 └─ Material Package Snapshot   (业务提交时冻结的物料包,不可变,带版本/审批)   🆕
      └─ Material Plan          (订单级计划头:1:1 订单,引用某个已批 Snapshot)   🆕
           └─ Material Requirement  (逐物料需求行 = 跨域脊柱;Explainable MRP 投影)  🆕
                ├─ Purchase Execution  → procurement_line_items(复用,加 requirement_id)
                ├─ Receiving/QC        → goods_receipts(复用)
                ├─ Warehouse(Phase2)  → 库存/库位 引用 requirement
                ├─ Production(Phase3) → 领料/消耗 引用 requirement
                └─ Shipment            → 出运与料齐放行 引用 requirement
```

**四个核心升级 + 一个补强:**
1. 脊柱从"采购计划"下沉到 **Material Requirement 行**(跨域引用点)。
2. MRP = **可重算的可解释投影**(复用 Runtime 模式)+ **时间分段**(补强)。
3. 物料包 = **不可变 Snapshot**(头+行 + 修订/审批/回滚/审计)。
4. AI Supply Brain = **每日决策引擎**(复用 Matter + Briefing + Batch)。

全部 Evolution:`materials_bom / procurement_line_items / goods_receipts / order_cost_baseline / runtime / matters / daily_briefings` 一个不删,新增对象挂在它们之上。

---

## 2. Material Plan Domain Design(含我对升级1的细化)

### 为什么不能让 Material Plan 当上帝对象
你说"所有供应链活动围绕 Material Plan 展开"——**方向对,但粒度错**。
- 采购买的是**某个物料**(面料 2403kg)。
- 仓库收的、生产领的、出运缺的,也都是**某个物料**。
所以跨域真正被引用的是**逐物料的需求行**,不是订单级的计划头。如果让所有域都挂在 Material Plan(头)上,将来仓库/生产要按物料对账时必须重构。

### 正确分解:头 + 行
- **`material_plans`(头,1:1 订单)**:计划状态、引用的 Snapshot、物料完成度、MRP 生成时间。是"容器/状态机"。
- **`material_requirements`(行,逐物料)**:**这才是跨域脊柱**。每行 = 一个物料的需求(Explainable MRP 输出)。采购/仓库/生产/出运全部 FK 到它。

### Material Plan 生命周期
`draft(业务在建物料包)` → `submitted(提交即冻 Snapshot + 建 Plan + 跑 MRP)` → `active(采购执行中)` → `revising(业务改物料包,生成新 Snapshot 待批)` → `closed(订单出运/结案)`。

### 与各域关系(都挂在 requirement 行)
| 域 | 引用方式 |
|---|---|
| orders | material_plans.order_id(1:1)|
| 采购 | procurement_line_items.requirement_id(一需求可拆多供应商=多采购行)|
| 仓库(Phase2)| 入库/库存 按 requirement_id 归集到货 |
| 生产(Phase3)| 领料/实际消耗 按 requirement_id 回填,对比需求 |
| 出运 | 料齐判断 = 该订单所有 critical requirement 已满足 |

> 这样"一个需求、多个采购单(拆供应商)""到货回填到需求""生产消耗对比需求"全部天然成立,**未来加仓库/生产零重构**。

---

## 3. Explainable MRP Architecture(可解释 + 可重算 + 时间分段)

### 不是存数字,是存"可重算的投影"
完全复用 Runtime 引擎已验证的模式:
```
纯函数 computeMrp(snapshot_line, order, inventory, leftover, supplier_lead)
   → 产出 requirement(数量 + 时间 + explain_json)
   → 存进 material_requirements(投影)
   → 当 PO数量/库存/Snapshot/交期 变 → 重算(像 runtime_orders 那样)
```

### MRP 计算模型(每个 requirement 行存全过程)
| 字段 | 含义 |
|---|---|
| gross_requirement | PO数量 × 单耗 |
| loss_qty | × 损耗% |
| inventory_deduct | − 现有库存(v1=0)|
| reuse_deduct | − 可复用余料(v1=0)|
| **net_purchase_qty** | = 建议采购量 |
| unit | 物料单位(KG/pcs/m,逐物料)|
| **required_date** | 需到日(开裁前)|
| **supplier_lead_days** | 供应商交期 |
| **order_by_date** | = required_date − lead_days(**最晚下单日**)|
| confirmed_qty | 采购确认量(人决策)|
| explain_json | 见下 |

### explain_json(复用 Runtime explain 结构,供 AI 直接解释)
```json
{
  "headline": "建议采购 主面料 2403kg,最晚 2026-07-02 下单",
  "factors": [
    {"code":"gross","label":"PO 10000 × 单耗 0.265","value":2650,"unit":"kg"},
    {"code":"loss","label":"损耗 2%","value":53},
    {"code":"inventory","label":"扣现有库存","value":-120},
    {"code":"reuse","label":"扣可复用余料","value":-180}
  ],
  "result": {"net_purchase_qty":2403,"order_by_date":"2026-07-02","status":"on_time"},
  "next_action": "采购确认数量并询价"
}
```
**采购永不重算;AI 永远能解释"为什么 2403kg、为什么必须 7/2 前下单"。**

---

## 4. Material Snapshot Architecture(工程变更管理 ECM)

### 核心规则
物料包(`materials_bom`,业务实时编辑)在**每次"提交采购"时冻结成一个不可变 Snapshot**。采购/仓库/生产**全部引用同一个 Snapshot**,不引用实时 BOM。**这就是消灭"Excel 多版本"的根。**

### Snapshot = 头 + 行(可查询/可审计,不是一坨 JSONB)
- **`material_package_snapshots`(头)**:order_id、snapshot_no、version、status(`draft/pending_approval/approved/superseded`)、created_by、approved_by/at、supersedes_snapshot_id。
- **`material_package_snapshot_lines`(行,不可变)**:冻结当时每个物料的 名称/规格/单耗/单位/颜色/建议供应商/损耗/样品状态。

### 生命周期 / Revision / Approval / Rollback / Audit
```
业务编辑 materials_bom(live)
  → 提交采购 → 冻结 Snapshot v1(approved)→ 建 Material Plan(引用 v1)→ 跑 MRP
业务再改 → 提交修订 → Snapshot v2(pending_approval)
  → 审批通过 → 生成新 Plan/requirements;v1 标 superseded
  → ⚠️ 已下单的采购(基于 v1)不自动切换,系统标"物料包已变更,请复核"
回滚 = 指定回到某个 approved 历史 Snapshot
审计 = 每个 Snapshot + 每次审批/变更全程 append-only 留痕
```

### 各域如何引用 Snapshot
Material Plan → 引用 snapshot_id;requirements 由该 snapshot 生成;采购/仓库/生产看到的物料定义 = snapshot_lines(冻结值),**不受业务后续编辑影响**,除非走"修订→审批"。

---

## 5. AI Supply Brain Architecture(每日决策引擎,非聊天)

### 定位:决策层,不是新引擎
AI Supply Brain **不重新计算**,而是在已有可解释投影之上**排序 + 推荐 + 一键动作**:
```
输入(全是现成投影):
  material_requirements(explain:量+时间)· procurement_matters(风险物化)
  · runtime_orders(交付置信度)· price_history(价格)· goods_receipts(质量)
        ↓ 每日物化(复用 Matter Engine:matter_key upsert + 时间窗清理 + dry_run/execute)
        ↓ 排序 + Anthropic Batch 生成推荐理由(复用现有 Batch + 熔断 + Feature Flag)
        ↓ 投递(复用 daily_briefings 六板块框架)
输出 = Helen 每天首屏的"决策卡"(每张 = 决策 + 解释 + 一键动作):
```
| 决策卡 | 数据来源 |
|---|---|
| 今天建议采购哪些订单 | requirement.order_by_date 临近 |
| 哪些订单可能断料 | net_purchase_qty>0 且 order_by_date 已过/临近 |
| 哪些建议提前采购 / 等待 | order_by_date vs 产能/资金(时间分段)|
| 供应商价格异常 | unit_price vs price_history 中位 |
| 供应商延期 / 值得切换 | procurement_matters + 供应商履约 |
| 哪些余料可复用 | leftover_inventory(Phase2)|
| 哪些风险立即处理 | runtime confidence + critical requirement |

**复用清单(不重新发明)**:Runtime Projection · Matter Engine · Daily Briefings · Anthropic Batch · Feature Flags。AI Supply Brain = 这些的**组合 + 决策排序层**。

---

## 6. Domain Object Relationship

```
                 ┌──────────────────────────── orders (One Order)
                 │
   materials_bom (live, 业务编辑) ──冻结──▶ material_package_snapshots(+lines) 🆕 [不可变]
                                                │ approved
                                                ▼
                                        material_plans 🆕 (1:1 order, 引用 snapshot)
                                                │
                                                ▼
                                   material_requirements 🆕 ◀── Explainable MRP 投影(量+时间+explain)
                                    │（跨域脊柱:逐物料需求行)
        ┌───────────────┬──────────┼─────────────┬────────────────┐
        ▼               ▼          ▼             ▼                ▼
 procurement_line_items goods_   warehouse_*   production_*     shipment/料齐放行
 (复用,+requirement_id) receipts (Phase2)      (Phase3)
        │
        ▼
 supplier_quotes 🆕 (询价多报价选优)

 跨切维度(都读上面的投影,不另算):成本 order_cost_baseline / 风险 runtime / 物化 matters
 AI Supply Brain:消费以上全部投影 → 每日决策卡
```

---

## 7. Database Evolution(设计层,不写 migration)

| 对象 | 新建/复用 | 角色 |
|---|---|---|
| `material_package_snapshots` + `_lines` | 🆕 | 物料包冻结快照(ECM)|
| `material_plans` | 🆕 | 订单级计划头(1:1)|
| `material_requirements` | 🆕 | **跨域脊柱**:Explainable MRP 投影(量+时间+explain_json)|
| `supplier_quotes` | 🆕 | 询价多报价选优 |
| `procurement_line_items` | 复用 + `requirement_id` | 采购执行(一需求可多采购行=拆供应商)|
| `materials_bom` | 复用(Step A 已加 submit/sample)+ `version` | 业务实时物料包(live)|
| `goods_receipts` | 复用 | 收货/验货 |
| `order_cost_baseline` | 复用 | 损耗率/成本输入 |
| `warehouse_inventory` / `leftover_inventory` | 🆕 Phase2 | MRP 扣库存/余料(v1=0)|
| runtime_* / *_matters / daily_briefings | 复用 | AI Supply Brain 的输入与投递 |

原则:requirement 与 purchase 分离(**"要什么"≠"怎么买"**),这是避免未来仓库/生产返工的关键,不是重复造对象。

---

## 8. UI Evolution

- **供应链中心首屏 = 订单卡**(v2.0 已定):订单·客户·交期·采购进度·物料完成度·物料风险·**最早 order-by 风险**。
- **Material Plan 页(每订单)**:Snapshot 版本徽标 → MRP 结果(量+最晚下单日+explain 可展开)→ 需求行 → 采购执行(询价/选供应商/下单)→ 收货/验货 → 成本 → 风险。
- **Snapshot/修订 UI**:提交=冻结;改物料=生成新版待批;版本对比 + 回滚 + 审计时间线。
- **AI Supply Brain 看板**:Helen 首屏决策卡(决策+解释+一键动作),复用 RuntimeRiskCard 的温和色 + explain 展示。
- 旧"待下单/催货/验收"三队列 → 降为"今日跨订单动作"次级视图(并行过渡)。

---

## 9. Implementation Roadmap(对象模型为五年设计,落地切片上线)

> 关键工程哲学:**对象模型一次设计对(贵在事后改),实现分片上线(不背未用的复杂度)。**

| 切片 | 内容 | 依赖 |
|---|---|---|
| **B0** | 建 `material_package_snapshots(+lines)` + `material_plans` + `material_requirements`(对象模型地基)| — |
| **B1** | 提交采购 → 冻结 Snapshot + 建 Plan + 跑 **Explainable MRP(量+时间)** 生成 requirements | B0 |
| **B2** | 采购中心订单卡首屏 + Material Plan 页(展示 MRP/需求,采购确认)| B1 |
| **B3** | `procurement_line_items.requirement_id` 接上(采购执行挂需求)+ 旧队列降次级 | B2 |
| **C** | `supplier_quotes` 询价多报价选优 | B3 |
| **D** | 收货/验货 → 业务复核 → 料齐**软提醒**放行生产 | C |
| **Phase2** | 仓库库存/余料表 → MRP 扣减自动生效 | D |
| **Phase3** | 生产领料/消耗回填需求 | Phase2 |
| **Brain** | AI Supply Brain 每日决策(可在 B1 后渐进接入,先上"今日建议采购/断料风险")| B1+ |

每切片:设计→你确认→build/check→diff→你批→push;migration 你手动执行。

---

## 10. Architecture Review(CTO + Supply Chain Architect 自评)

### 对标成熟系统
- **SAP**:requirement vs purchase requisition vs PO 分离 → 我们 requirement(需求)/ procurement_line_items(采购执行)分离,对齐。BOM 变更走 change master → 我们 Snapshot ECM,对齐。
- **Kinaxis/Blue Yonder**:time-phased MRP + explainable → 我们 requirement 带 order_by_date + explain_json,对齐(深度较浅,见下)。
- **Oracle/Infor**:plan 版本 + 审批 → Snapshot 版本+审批,对齐。

### 自评分:**8.5 / 10**
- 强(9-10):对象分解(snapshot/plan/requirement 三层)、可解释投影复用 Runtime、ECM 快照、AI 决策层复用现有引擎、向后兼容。
- 扣分项(为什么不是满分):
  1. **时间分段是"单点 lead time"级**,不是 Kinaxis 那种约束求解(产能/资金约束)。够用,但深度浅。
  2. **无跨订单净需求(netting/pooling)**:每订单独立算,常用料(包装/松紧)不能合并采购。garment OEM 有真实省钱空间。
  3. **无物料主数据(Material Master)**:单耗/默认供应商每单重录;`customer_trim_library` 只是半个。

### 未来五年可能需要升级的点(现在故意不做,但对象模型已为它们留位)
1. **Material Master**:物料主数据(编码/默认单耗/默认供应商/价格史),订单 BOM 从主数据带出 → 少重录 + 跨订单分析。(requirement 已可挂 material_code)
2. **跨订单净需求 + Pegging**:把多订单同物料合并采购,再 peg 回各订单。(requirement 行已是合并的天然单元)
3. **时间分段升级为约束求解**:接产能/资金/MOQ 约束,做"提前/等待"的最优解。(order_by_date 已是入口)
4. **多 UoM/换算**:物料单位换算矩阵(采购单位 vs 用量单位)。
5. **供应商协同门户**:供应商直接回报价/交期(supplier_quotes 已是入口)。
6. **财务深度集成**:应付/账期/信用占用随采购实时联动(order_financials 已在)。

### 一句话总结
**v2.1 把脊柱从"采购计划"下沉到"物料需求行",把 MRP 升级为"可解释+时间分段的投影",把物料包升级为"不可变快照",AI 做"决策层"。这四件事让 QIMO OS 的供应链域在加入仓库/生产/物流时零返工 —— 这正是五年不推倒的关键。** 唯一我坚持加进你方案的是 **MRP 的时间维度**,否则 AI Supply Brain 无法成立。
