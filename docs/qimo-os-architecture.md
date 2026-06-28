# QIMO OS — 架构宪法 + 演进方案 (Architecture Constitution & Evolution Plan)

> ⚠️ **2026-06-28 文档重构**:本文 **§0 宪法条款已被 [`00-Constitution/Constitution.md`](00-Constitution/Constitution.md)(V1.0 Frozen, 10 条)取代**。
> 本文档保留为**早期 QIMO OS 总览**(资产盘点 / 差距分析 / Phase 路线仍有效)。新文档体系见 [`00-Constitution/README.md`](00-Constitution/README.md)。

> 状态:**待审批**(Output only, do NOT implement until approved)
> 日期:2026-06-28 · 作者:架构审核员(Claude)
> 基于:对生产代码的四路并行审计(数据层 / 采购仓库物料 / UI导航 / 跨域维度+AI)

---

## 0. 宪法条款(不可违背)

这些是 QIMO OS 演进期间的红线,任何实现都必须遵守:

1. **Evolution, NOT Rewrite** —— 现有功能必须继续工作,不推倒重来。
2. **One Order** —— 一切业务活动归属于同一个 `orders` 记录,**永不创建第二个订单对象**。(现状:已成立,所有子表 FK = `order_id`。)
3. **One Data** —— 客户/订单/物料/供应商/库存/成本/出运,每样只有一份真相源,所有域读同一份。
4. **Business Domains, not Systems** —— 不是独立系统拼装,是共享一个数据库的业务域。
5. **Control Dimensions are cross-cutting** —— 成本/进度/质量/库存/物流/风险不是模块,是每个域都要呈现的横切维度。
6. **复用三大已验证模式**,不另起炉灶:
   - 投影层(`runtime_events` append-only → `runtime_orders` 投影 → `explain_json` + `next_action`)
   - 物化层(夜间 cron → `matter_key` upsert → 时间窗清理,dry_run/execute 两阶段)
   - AI 基础设施(Anthropic Batch + 熔断器 + Feature Flag + `daily_briefings` 六板块)
7. **No duplication** —— 严禁新建与 `procurement_line_items` / `order_cost_baseline` / `factories` 平行的表或工作流。要扩展,不要复制。
8. **Backward compatible + 可回滚** —— 每个域一个 Feature Flag;迁移只增不毁(`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN`);env 关旗即回退。
9. **Order Domain 表达需求,不定义工艺(= Order Domain Constitution Principle 7,2026-06-28)** —— Order Domain 把客户语言翻译成企业可执行的业务语言,**不是 MES / IE / PLM / SOP / 工艺系统**。订单域只产出**三个真相源对象**(`Customer Order → Material Package → Manufacturing Order`),**不再有第四个订单对象**。**Manufacturing Order(生产任务单,即原 "Production Package" 改名)** 只表达需求(产品/数量/颜色/尺码/包装/印绣/QC重点/特殊要求/风险/交期/附件);工艺路线/工序/SMV/IE/吊挂/机器/SOP/MES **一律归 Production Execution Domain**,经 Manufacturing Order 解耦。后续 O2/Production/MES/AI/Template 全部遵守。**详见 `docs/order-domain-v3.0.md §0.1`。**

---

## 1. 现状架构评估 (Current Architecture Assessment)

**一句话:订单节拍器已经是一个以 `orders` 为脊柱、围绕它生长的多域系统,QIMO OS 的骨架已经在那里。**

### 已是事实的"OS 特征"
- **One Order / One Data 已成立**:全库以 `orders` 为中心,几十张子表 1:N / 1:1 挂上去(milestones、procurement_line_items、order_cost_baseline、order_line_items、qc_inspections、shipment_*、issue_slips、runtime_orders…),没有第二个订单对象。
- **订单类型已分流**:`order_purpose ∈ {production, trade, sample, inquiry}`,不同类型走不同里程碑模板(生产单买料自产 / trade 买成品 / 打样)。经销单=trade 已就绪。
- **跨订单工作台已存在**:`/procurement` 是 Helen 的采购中心(待下单/待催货/待验收三层队列 + 红黄绿灯),不是逐单操作。
- **横切维度部分已横切**:进度/风险维度通过 Runtime 引擎完整闭环(置信度 + explain + next_action + UI 卡)。

### 成熟度评分(供应链视角)
| 能力 | 成熟度 | 证据 |
|---|---|---|
| 采购执行链路 | 🟢 高 | `procurement_line_items` 12 态状态机 + 催货 + 验收 + 对账(`lib/domain/procurement.ts`、`app/actions/procurement.ts`) |
| 成本基线/利润 | 🟢 高 | `order_cost_baseline`(1:1)+ `profit_snapshots`(三态)+ 手填表单(刚上线) |
| 采购风险物化 | 🟢 高 | `procurement_matters` 六信号 + 夜间物化(`lib/services/procurement-matters.service.ts`) |
| 到货/验收 | 🟡 中 | `goods_receipts`(pass/concession/reject + AQL)有,但无库位 |
| 发料 | 🟡 中 | `issue_slips`/`issue_slip_lines` 有,但不扣库存 |
| 物料 BOM | 🟡 中 | `materials_bom` + `customer_trim_library`,但无版本/审批、无通用物料主数据 |
| 库存/库位 | 🔴 无 | 无 inventory / 库位 / 批次卷号追踪 |
| MRP/需求聚合 | 🔴 无 | 预算按单算,无跨订单聚合需求 |
| 供应商信用/账期 | 🔴 弱 | `factories` 有评级字段,无信用额度/账期/履约 |
| AI 采购简报 | 🔴 无 | `daily_briefings` 只发业务员,Helen 无专用简报 |

**结论:供应链域的数据脊柱已建好约 60–70%,缺的是"物料实物流转(库存/批次/库位)"、"前端归集成一个域"、"AI 决策给 Helen"。**

---

## 2. 可复用资产 (Reusable Components)

### A. 可直接复用的数据表(改都不用改)
- `procurement_line_items` —— 采购行状态机(draft→pending_order→ordered→confirmed→in_production→shipped→arrived→accepted/concession/rejected→closed),含供应商、PO号、承诺期、催货计数、价格快照、订购vs实收差异(GENERATED)。
- `goods_receipts` —— 到货验收(多批次、AQL、让步/拒收、退货状态、照片)。
- `order_cost_baseline` —— 成本基线(面料单耗/净布价/预算/加工费/FOB/DDP/实际用量)。
- `procurement_matters` + `procurement_logs` —— 采购风险物化 + append-only 审计。
- `price_history` —— 下单自动沉淀中位价基线。
- `materials_bom` / `customer_trim_library` —— 物料清单 / 客户辅料库。
- `issue_slips` / `issue_slip_lines` —— 发料单。
- `shipment_batches` / `shipment_confirmations` / `packing_lists` —— 出运/装箱。

### B. 可复用的**架构模式**(QIMO OS 的"钢筋")
1. **投影层模式**(`lib/runtime/*` + `app/actions/runtime-confidence.ts` + `RuntimeRiskCard.tsx`):
   `事件 append → 纯函数算 → upsert 投影(乐观并发)→ explain_json(headline+reasons+next_blocker+next_action)→ 温和色 UI 卡`。
   → **直接复用做"供应链置信度"**(物料能不能按时到、会不会断料)。
2. **物化层模式**(`lib/services/*-matters.service.ts` + `/api/admin/*-materialize`):
   `夜间 cron → 信号检测 → matter_key upsert → 删本轮未检出(=已解决)→ dry_run 先看再 execute`。
   → **复用做质量/库存/成本的事项物化**,喂各中心 Dashboard。
3. **AI 基础设施**:Anthropic Batch(`lib/agent/`)+ 熔断器 + Feature Flag(`AGENT_FLAGS`)+ `daily_briefings` 六板块框架。
   → **复用做 AI Supply Brain(Helen 采购简报)**。
4. **采购工作队列算法**(`lib/domain/procurement.ts` 红黄绿灯 + 三层队列)。
5. **权限红线**(`CAN_SEE_FINANCIALS`、`assertCanSeeFinancials`、RLS user_can_access_order 模式)。

### C. 可复用的 UI 骨架
- **订单详情 Tab 系统**(`app/orders/[id]/page.tsx`):Tab 用数组定义、按角色 gate,新增"供应链"Tab ≈ 5 行改动 + 1 个 `components/tabs/SupplyChainTab.tsx`(照抄 ProcurementTab)。
- **跨订单中心页**(`/procurement` 的看板结构)可作为各"控制中心"的模板。

---

## 3. 差距分析 (Gap Analysis)

按"物料生命周期"目标(物料包→MRP→采购计划→采购执行→运输→收货→检验→入库→发料→生产→补料→退料→余料→复用→报废)逐项:

| 生命周期节点 | 现状 | 差距 |
|---|---|---|
| 物料包(BOM/用量/颜色/包装) | 🟡 `materials_bom` 有 | 缺**版本控制 + 审批**;缺通用物料主数据 |
| MRP 计算 | 🟡 单订单预算有 | 缺**跨订单聚合需求 + 在途库存扣减** |
| 采购计划 | 🟢 有 | 需求单→采购单转换流程未 schema 化 |
| 采购执行 | 🟢 完整 | — |
| 运输 | 🟢 有 | — |
| 收货/检验 | 🟡 有 | 缺**库位分配** |
| 入库/库存 | 🔴 无 | 缺 `warehouse_inventory`(库位、现存、可用、已分配) |
| 批次/每卷追踪 | 🔴 无 | 缺 `material_batches`(卷号→库位→生产消耗→退料) |
| 发料 | 🟡 有单据 | **不实时扣库存** |
| 生产消耗回填 | 🔴 无 | 缺 production→库存/采购行 的回填 ETL |
| 补料 | 🟢 字段有 | 工作流可复用 line_items.is_supplement |
| 退料 | 🟡 字段有 | 缺完整工作流 |
| 余料 | 🟡 数字在 cost_baseline | 缺**余料库存归档表** |
| 复用 | 🟡 辅料库有 | 缺**余料→新订单复用追溯表** |
| 报废 | 🔴 无 | 缺报废单据表 |
| **供应商信用/账期** | 🔴 弱 | 缺信用额度、账期、付款计划、履约 KPI |
| **AI 采购简报** | 🔴 无 | Helen 无每日可执行决策简报 |
| **横切维度** | 🟡 部分 | 成本未"每动作更新";质量/库存维度无物化 |

---

## 4. 演进路线图 (Evolution Roadmap)

> 原则:每个 Phase 都能独立上线、独立回滚、不破坏现有功能。

### Phase 0 —— 改名 + 外壳(低风险、高可见,可最先做)
- 全局改名 **QIMO OS**(收口到一个 `lib/branding` 常量,替换 Navbar/layout/login/manifest/guide)。
- 顶部导航 → **左侧控制中心菜单**(订单/采购/仓库/销售/工厂/AI/分析/CEO/管理)。
- **不动任何数据/业务逻辑**,纯壳。

### Phase 1 —— 供应链域归集(Supply Chain Domain,不加实物库存)
- 订单详情新增 **"🔗 供应链" Tab**,把现有「原辅料BOM / 采购进度 / 成本控制」归集成一个域视图(读现有表,不建新表)。
- `/procurement` 升级为 **供应链控制中心**(在现有三层队列上叠:供应商预警、价格预警、未来 7 天断料风险)。
- **物料包**:给 `materials_bom` 加版本 + 审批(轻量增列/新小表)。
- **MRP v1**:跨订单聚合需求(只读计算,产出建议采购量,不动库存)。

### Phase 2 —— 仓库 + 物料生命周期(补实物流转)
- 新增 `warehouse_inventory`(库位/现存/可用/已分配)、`material_batches`(批次/卷号追踪)。
- 收货→入库→发料→退料→余料→报废 全链路落库 + 每步可追溯。
- 发料/生产消耗 **实时扣库存**;余料归档 + 复用追溯。
- `/warehouse` 升级为仓库中心(收货通知/库位/盘点/发料/退料)。

### Phase 3 —— 生产集成(物料连生产)
- 外发直送、补料、退料、实际消耗、生产反馈,每个动作更新物料流。
- 实际单耗回填 `order_cost_baseline.actual_*` → 成本闭环。

### Phase 4 —— AI Supply Brain(给 Helen 可执行决策)
- 复用 `daily_briefings` 框架,产出**采购专用简报**:今日采购/今日催货/价格预警/供应商风险/断料风险/余料建议/替代供应商/预计延期及对生产影响。
- 复用投影层做**供应链置信度**(断料风险预测)。
- No chat. 只给 actionable 决策 + 一键动作。

### Phase 5 —— 定位升级
- 成本变为真正横切(每业务动作更新成本)。
- 供应商中心(信用/账期/评级/AI 推荐)、物料知识库(图片/成分/价格史/替代料)。
- 产品正式定位:**QIMO OS — 服装 OEM/ODM 的 AI 企业操作系统**。

---

## 5. 数据库演进 (Database Evolution)

**铁律:只增不毁。所有迁移 `IF NOT EXISTS`、加 FK 到 `orders`/`factories`、开 RLS、日志表 append-only。人工在 Supabase 执行。**

### 复用(不动表结构,可能加少量列)
`procurement_line_items` · `goods_receipts` · `order_cost_baseline` · `procurement_matters` · `price_history` · `materials_bom`(+version/approval)· `issue_slips` · `customer_trim_library`(升级为通用物料库的过渡)。

### 新增(按 Phase)
| Phase | 新表 | 用途 |
|---|---|---|
| 1 | `bom_versions`(或给 materials_bom 加 version/approval 列) | 物料包版本+审批 |
| 2 | `warehouse_inventory` | 库位/现存/可用/已分配 |
| 2 | `material_batches` | 批次/卷号级追踪(收货→库位→消耗→退料) |
| 2 | `material_scraps` | 报废单据 |
| 2 | `leftover_inventory` | 余料库存归档 |
| 2 | `material_reuse_tracking` | 余料→新订单复用追溯 + 成本抵扣 |
| 1–4 | `material_master` | 通用物料主数据(编码/规格/默认供应商/工艺) |
| 1 | `procurement_forecast` | MRP 跨订单需求聚合 |
| 5 | `supplier_credit` / `payment_schedule` | 供应商信用额度/账期/付款计划 |
| 4 | 复用 `daily_briefings`(加 role 维度)或 `procurement_briefings` | Helen 采购简报 |

> 注:优先**升级/扩列**而非新建。例:`material_master` 落地后,`customer_trim_library` 改为引用它,避免双库。

---

## 6. UI 演进 (UI Evolution)

- **品牌常量化**:新建 `lib/branding/constants.ts`(`PRODUCT_NAME='QIMO OS'` 等),Navbar/layout/login/manifest/guide 全部引用,杜绝散落硬编码。
- **左侧控制中心**:`components/Navbar.tsx` 由 `sticky top` 改 `fixed left h-screen w-64` 竖排;`app/layout.tsx` body 改 flex;移动端汉堡折叠。菜单 = 各控制中心,**订单只是其中一个**。
- **订单"供应链"Tab**:`app/orders/[id]/page.tsx` 注册 `supply_chain` + 按 procurement/logistics 角色 gate + 新建 `components/tabs/SupplyChainTab.tsx`(七块:物料包/MRP/采购计划/采购执行/物料流转/成本/进度)。
- **各中心 Dashboard** 统一用"物化事项 + 红黄绿灯 + 一键动作"范式(照 `/procurement`)。

---

## 7. 迁移策略 (Migration Strategy)

1. **加法优先**:不删表、不改语义、不动现有里程碑模板与权限口径。
2. **Feature Flag 分域**:`SUPPLY_CHAIN_DOMAIN` 等旗,off=完全看不见新东西,灰度 admin→全员。
3. **双轨止血规则**:任何"新表替代旧字段"必须先双写/回填,确认后再切读;不可一刀切(参考 2026-06-13 procurement_tracking→procurement_line_items 的平滑迁移先例)。
4. **数据不双份**:新域读现有表;只有实物库存等"现在完全没有"的才建新表。
5. **SQL 人工执行**:Claude 写迁移文件、不执行;每条幂等;附验证 SQL。
6. **回滚**:关 Flag 即回退;新表保留无害。
7. **每次发布走现有纪律**:`npm run build && npm run check` → diff → 等"push" → fetch 确认不落后 → 无 force。

---

## 8. 实施计划 (Implementation Plan)

> 建议从 Phase 0 + Phase 1 起步(可见、低风险、复用现有数据)。每步都是一次完整的"设计→确认→构建→build/check→diff→push→必要时跑迁移"。

**Step 1(Phase 0,半天–1天):**
- 建 `lib/branding/constants.ts`,全局改名 QIMO OS。
- Navbar 改左侧控制中心外壳(纯 UI)。
- 验收:登录后左侧是各中心,订单是其一;全站不再出现"订单节拍器"。

**Step 2(Phase 1a,1–2天):**
- 订单"🔗 供应链"Tab,归集现有 BOM/采购/成本(只读现有表)。
- 验收:一个订单的供应链全貌一页看全,不新增数据。

**Step 3(Phase 1b,2–3天):**
- `/procurement` 升级为供应链控制中心(叠预警);物料包加版本+审批;MRP v1 只读聚合。

**Step 4+(Phase 2,按周):**
- 库存/批次/库位 + 收货入库发料退料余料报废闭环(新表 + 迁移)。

**Step 5+(Phase 3–4):** 生产集成 + AI Supply Brain。

**每个 Step 结束:** 更新本文件的"已完成"标记 + 写一条 migration(若有)+ 更新 Feature Flag 文档。

---

## 附:反模式清单(实现时严禁)
- ❌ 新建 `suppliers` 表(用 `factories`)。
- ❌ 新建第二套采购表/采购页(扩展 `procurement_line_items` + `/procurement`)。
- ❌ 给供应链域复制一份订单/客户/成本数据。
- ❌ 一次性大改导航/品牌却混进业务逻辑改动(Phase 0 必须纯壳)。
- ❌ 直接执行生产 SQL(必须人工在 Supabase 跑)。
- ❌ 关掉现有里程碑/权限/Runtime 引擎以"让路"。
