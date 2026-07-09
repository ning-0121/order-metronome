# QIMO Object Lifecycle Operating System V1.2（最终产品蓝图）

> **Date**: 2026-06-30 · CPO/ERP 架构师/AI-OS 架构师/外贸服装 COO 视角。**产品设计阶段收官文档。**
> **唯一事实源（不推翻、只统一）**：`Constitution.md` · `Enterprise-Architecture(-V1.1).md` · `Designs/Five-Centers-Blueprint.md` · `integration/12-Functional-Completeness-Audit` · `Product-Philosophy-V1.1.md`。
> **第一原则**：企业运行的最小单位不是部门，是 **Business Object**。一个对象一个真相、一个 Owner；部门只引用不复制；AI 只是 Object Guardian；关键状态变化必经人工。
> **🚦 总门禁（凌驾全文，未来 5 年每次开发都先过）**：**除非同时满足下面两问，否则禁止新增任何 Business Object / 模块 / 中心 / 流程 / 概念，也不修改现有设计——**
> **① 是否减少员工每天工作量？　② 是否让数据链更完整、更准确、更少重复录入？** 两问不能同时为"是" → 不动。（本文每个"变化"已逐条过此门禁，见 §11。）
> 状态：✅ 企业级在用 · 🟡 部分/未接通 · 🔴 缺失。**不加功能、不碰代码/DB/架构。**

---

## 1. Enterprise Business Object Map（最终对象图 + 删/并/派生判断）

> 克制原则：**能合并的合并，能降级为"事件/派生"的就不立为独立对象**——防对象膨胀。

```
根  Customer ──► Inquiry ──► Sample ──► Quote ─approved─► [Customer PO 证据]
                                                              │ PO Compare(派生)
脊                                                            ▼
   ╔══════════════════════════ ORDER（核心脊柱，聚合根）══════════════════════════╗
   ║ Order = {Order Line + 18 关卡里程碑 + 生产执行单MO}  一切挂 order_id           ║
   ╚════════════╦═══════════════════════╦══════════════════════════╦══════════════╝
                ▼                       ▼                          ▼
     Material Requirement        Delivery(派生健康)          Profit(派生)
     (Purchase=其事件→Arrival)   {生产/QC/Packing/Shipment}   (forecast/live/final)
果                                                            ──► Payment(finance 拥有,引用)
引用层(跨订单复用,被引用不被拥有): Customer · Product/款 · Material Master · Supplier🔴 · Factory
```

| 对象 | 判定 | 理由 |
|---|---|---|
| **Customer** | ✅ 核心 SoT（根/资产） | customers |
| **Inquiry** | ✅ 核心 SoT（轻） | 现 parseInquiryFile 临时态 🟡，须固化 |
| **Sample** | 🟡 **保持现状，不新增对象** | 现订单内样=里程碑级✅ + 售前样=araos samples；**过不了两问**(里程碑已覆盖)→不升为独立重对象，待打样量大再议 |
| **Quote / Approved Quote** | ✅ 核心 SoT | quoter_quotes ✅ |
| **Order**（含 Order Line + 里程碑 + MO） | ✅✅ **核心脊柱 SoT** | orders/order_line_items/milestones/manufacturing_orders ✅ |
| **Material Requirement** | ✅ 核心 SoT（Purchase 是其事件） | material_requirements/materials_bom/procurement_line_items ✅ |
| **Shipment** | ✅ 核心 SoT（轻，Delivery 子阶段） | shipment_confirmations 🟡 |
| **Payment** | ✅ SoT（**finance 系统拥有**，QIMO 引用） | 不在 QIMO 重做账 |
| Customer PO | 🟢 **Evidence（非真相）** | Constitution 05；提取后确认进 Order |
| PO Compare | 🟢 **派生（diff，never stored）** | 🔴 未建 |
| Delivery | 🟢 **派生（Order 履约健康）** | =交付置信度，over milestones ✅ |
| Profit | 🟢 **派生（投影）** | profit_snapshots ✅ |
| **Supplier** | ⚠️ **核心引用对象，但缺失** | 现纯文本 🔴 ——**唯一真正缺的对象** |
| Product/款 · Material Master · Factory | ✅ 引用对象 | 跨订单复用 |
| **应删/并** | Contact→并入 Customer · Order Line→Order 聚合内 · Purchase/Production/Inspection/Packing→**降级为生命周期事件/阶段，不立独立对象** | 防膨胀 |

> **判断结论（过总门禁后）**：核心 SoT 对象 **7 个**（Customer/Inquiry/Quote/Order/Material Requirement/Shipment/Payment）+ 引用对象 5 个 + 派生 4 个 + 证据 1 个。**唯一过两问、必须补的新对象 = Supplier 主数据**（采购停止重打名+得历史比价 ✅减工作量；供应商成引用对象 ✅消重复）。**Sample 保持现状不新增**；**Purchase/Production/Inspection/Packing 一律不立为对象**（是 Order/Material 的生命周期阶段，立了不减工作量也不强数据链）。**其余全是"重命名/重组"（中心→对象镜头、部门AI→Object Agent），零新建、零成本。**

---

## 2. Object Lifecycle Matrix（生命周期：进入/退出/状态迁移）

| 对象 | 生命周期（状态机） | 进入条件 | 退出条件 | 现状 |
|---|---|---|---|---|
| **Customer** | Lead→Potential→Quoted→Active→Dormant→Lost | 线索录入 | 转 Active(下单) / Lost | 🟡 customer_rhythm.followup_status 是种子 |
| **Inquiry** | Received→Parsed(AI草稿)→Confirmed→Quoted→Closed | 客户询盘 | 转 Quote / 关闭 | 🟡 解析在、不落库 |
| **Sample** | Requested→Made→Sent→Confirmed/Rejected | 客户/报价需样 | 确认/否 | 🟡 里程碑级 |
| **Quote** | Draft→Reviewing→Sent→Negotiating→Approved→(Converted/Expired/Lost) | 询盘成熟 | Converted(转单)/失效 | ✅ quoter.status 映射 |
| **Order**（脊柱） | Created→Confirmed→MaterialReady→Production→Inspection→Packing→Shipped→Delivered→Paid→Closed | Approved Quote+PO 确认 | Closed/终止 | ✅✅ lifecycle_status+18 关卡 |
| **Material Requirement** | Required→Sourced→Ordered→InTransit→Arrived→Consumed→(Leftover) | 订单 BOM 提交 | 消耗完/尾货 | ✅ 状态机在 procurement_line_items |
| **Shipment** | Booked→Customs→Shipped→Delivered | 尾期合格 | 交付 | 🟡 里程碑级 |
| **Payment**（finance） | Invoiced→PartiallyPaid→Paid | 出运 | 全额回款 | 🟡 在 finance 系统 |
| **Profit**（派生） | Forecast→Live→Final | 报价/成交 | 结案 | ✅ profit_snapshots |

> 每个核心对象都有**完整生命周期 + 进入/退出条件**；断裂点见 §10。

---

## 3. Object Ownership Matrix（Owner/改/看/引用/不可改字段）

| 对象 | 唯一 Owner（可改） | 只读/引用 | 任何人不可改的字段 |
|---|---|---|---|
| Customer | 业务(sales)/admin | 全员引用 customer_id | 一旦成交：历史成交记录 |
| Inquiry | 业务 | — | 来源文件(Evidence) |
| Sample | 业务/跟单 | 生产 | 客户确认结论 |
| Quote/Approved | 业务/admin(价 CAN_SEE_FINANCIALS) | 订单/财务引用 quote_id | **Approved 快照**(冻结) |
| **Order** | 订单(sales/merchandiser)/admin | **全员引用 order_id** | 成交价/款色码(确认后)、order_no |
| Material Requirement | 采购/merchandiser/admin | 财务看额 | 大货单耗(采购确认后) |
| Shipment | 物流(logistics)/admin | 全员 | 提单/订舱号 |
| Payment | **finance 系统** | QIMO 只读引用 | 全部(QIMO 不可改) |
| Profit(派生) | 系统算/财务看 | 老板 | 不可手改(派生) |
| Supplier(缺) | 采购/admin(将来) | 全员引用 supplier_id | 历史价/评分 |

---

## 4. Object Truth Matrix（SoT/派生/AI生成/人工确认）

| 对象 | SoT 字段 | 派生字段 | AI 可生成（草稿） | **必须人工确认** |
|---|---|---|---|---|
| Inquiry | 客户/款/量/目标价 | — | OCR 抽取全部 | 解析草稿→人确认 |
| Quote | 成本构成/价/margin | 单耗(RAG建议) | 报价草稿 | **销售确认报价** |
| Customer PO | （Evidence，无SoT） | PO Compare diff | OCR 提取 | 业务核 PO |
| **Order** | 款色码/量/交期/成交价/条款 | 交付健康/风险 | MO 草稿/异常提醒 | **业务确认订单 + PO 差异** |
| Material Req | 需求量/采购量/到料量 | MRP 重算量 | 汇总/供应商建议 | **采购确认下单** |
| Delivery(派生) | （各节点 status 是SoT） | 置信度健康分 | 延期预测/谁该做 | 节点完成由责任人确认 |
| Profit(派生) | （成本/收入来自各SoT） | margin/forecast/live/final | 毛利异常告警 | — (只读) |
| Payment | （finance SoT） | — | — | finance 确认 |

> **铁律**：SoT 靠人工确认；派生 Derived-Never-Stored；AI 只在"建议→人工确认"那一步出现，**永不跨闸门**。

---

## 5. Object Agent Matrix（AI = Object Guardian，非部门员工）

| Agent | 维护对象 | 持续监控 | 何时提醒 | **何时禁止/停止** | 何时生成建议 | 现状 |
|---|---|---|---|---|---|---|
| **Order Agent** | Order | 交付健康/关键节点 | 节点逾期、交付风险升 | **禁**自动改交期/放行 | 风险卡(为什么/谁做下一步) | ✅✅ 置信度引擎 |
| **Quote Agent** | Quote | 单耗/成本/margin | 毛利偏低 | **禁**自动确认报价 | 报价草稿 | ✅ quoter RAG |
| **Material Agent** | Material Req | 缺口/到料/尾货 | 缺料、催料逾期 | **禁**自动下单 | 汇总/合并采购 | 🟡 本轮汇总视图 |
| **Profit Agent** | Profit | 毛利/现金 | 负/低毛利 | **禁**自动审批/付款 | 价审参考 | ✅ 部分(alerts) |
| **Customer Agent** | Customer | 跟进/流失/投诉 | 跟进逾期、投诉信号 | **禁**自动承诺客户 | 跟进建议 | 🟡 rhythm/matters |
| **Supplier Agent** | Supplier | 交付/价/质 | 涨价、延迟 | **禁**自动选供应商 | 比价/推荐 | 🔴 无对象 |
| **Delivery Agent** | Shipment | 准时/单据 | 出运延迟 | **禁**自动订舱 | 出运提醒 | 🟡 里程碑级 |

> **统一律**：每个 Agent **只为一个对象服务、全部门共用**；**永不是审批人/确认者**（Constitution 06）。**Agent 停止工作 = 对象进入终态（Closed/Lost/Paid）**。

---

## 6. Object KPI Matrix（对象健康，由其 Agent 持续算）

| 对象 | 健康 = ? | AI 如何持续算 | 何时报警 |
|---|---|---|---|
| Customer | 在成长还是流失 | 复购率/跟进逾期/投诉 | 60 天无单 / 投诉 |
| Quote | 转化得动、赚得到 | 成交率/响应时长/毛利 | 毛利<阈值 / 超期未跟 |
| **Order** | **能否准时·齐套·盈利交付** | **交付置信度分** | 置信度跌破红线 |
| Material | 会不会缺料/尾货 | 到位率/缺口/尾货 | 缺口>0 临近开裁 |
| Supplier | 靠不靠谱 | 交付率/价格/质量 | 连续延迟/涨价 |
| Delivery | 会不会延期/不合格 | 准时率/一次合格率 | 节点逾期 |
| Profit | 这单/这月赚不赚 | 毛利/现金/回款 | 负毛利 / 回款逾期 |

> 对象 + 健康分 + Agent = 同一件事三面。**置信度引擎已证明范式可行**（Order Health 每天在算），复制给 Material/Supplier/Profit 即可。

---

## 7. Five Centers → Business Object Manager（中心 = 对象管理者）

| 中心 | 管理对象（生命周期） | 负责确认/审批 |
|---|---|---|
| **业务开发** | Customer · Inquiry · Sample · Quote | **报价确认**、客户晋升 |
| **订单执行(Hub)** | **Order**（含 Line/里程碑/MO）+ Customer PO 证据 + PO Compare | **PO 差异确认、订单确认、下发生产** |
| **采购** | Material Requirement（+ Supplier 引用） | **采购下单确认、到料确认** |
| **生产** | Delivery（生产/QC/Packing/Shipment 阶段） | **节点放行、出运确认** |
| **财务(Profit)** | Profit（+ 价审/成本） | **价格审批、成本确认** |

> 中心不是系统，是"**某些对象的生命周期管理者 + 关键状态的人工确认者**"。

---

## 8. Business Object Data Chain（每个箭头：流动/确认/AI）

| 箭头 | 数据如何流动 | 谁确认 | AI 做什么 | 现状 |
|---|---|---|---|---|
| Customer→Inquiry | 客户发询盘 | 业务 | 解析询盘→草稿 | 🟡 |
| Inquiry→Sample | 需打样 | 业务/跟单 | 提取样衣需求 | 🟡 |
| Sample→Quote | 样确认→报价 | 销售 | 单耗/成本/报价草稿 | ✅ |
| Quote→Customer PO | 客户下单 | 客户 | — | 🔴(无PO对象) |
| Customer PO→PO Compare | PO 上传比对 | — | OCR+逐字段 diff | 🔴 未建 |
| PO Compare→**Order** | 差异 resolve→建单 | **业务确认** | 差异分析 | 🔴(现手工建单) |
| **Order→Material Req** | BOM 实例化→MRP | 采购 | 汇总/合并 | ✅ |
| Material Req→Purchase | 核料→下单 | **采购确认** | 供应商/比价建议 | 🟡(无供应商) |
| Purchase→Arrival | 催料→收料 | 仓/采 | 催料/缺口预警 | 🟡 |
| Arrival→Production | 料齐→开裁 | 生产 | 料齐放行提示 | ✅里程碑 |
| Production→Inspection | 完工→验货 | 质检 | 验货报告/缺陷 | 🟡 |
| Inspection→Packing→Shipment | 合格→装箱→出运 | 物流 | 出运提醒 | 🟡 |
| Shipment→Payment | 出运→开票收款 | finance | 应收风险 | 🟡(finance) |
| Payment→Profit | 回款→结案利润 | 系统/财务 | 利润异常 | ✅派生 |

---

## 9. Permission Matrix（每对象：拥有/引用/禁改）

| 对象 | 拥有中心(可改) | 引用中心(只读) | 禁改中心 |
|---|---|---|---|
| Customer | 业务开发 | 全员 | 采购/生产/财务 |
| Quote | 业务开发 | 订单/财务 | 采购/生产 |
| **Order** | **订单(Hub)** | 全员 | 业务/采购/生产/财务(只引用) |
| Material Req | 采购 | 财务/生产 | 业务/订单 |
| Delivery | 生产 | 订单/财务 | 业务/采购 |
| Profit | 财务 | 老板/订单 | 业务/采购/生产 |
| Supplier | 采购 | 全员 | 其他 |

> 越界红线：采购页不改客户 · 订单页不改供应商 · 财务页不改生产 · 生产页不改报价。⚠️ 现实违例：旧 `procurement.ts` 允许 finance 写采购（待收紧）。

---

## 10. Consistency Audit（一致性逐项体检 — 诚实）

| 检查 | 结论 |
|---|---|
| 违反 Constitution? | 模型本身合规。**现实违例**：① 旧 procurement.ts 让 finance 写采购(越权) ② 报价两套状态(quoter.status vs orders.quote_status) |
| 重复录入? | 🟡 quote→order 重打款/色/价（origin_quote_id 未接）；报价 customer_name 字符串未连 customers |
| 重复对象? | ✅ 无（已并 Contact/Line，未立 Purchase/Production 为对象） |
| 双真相? | 🟡 Profit(QIMO live/final vs finance)；进度(lifecycle_status vs milestones 两处) |
| 对象无人负责? | 🔴 Inquiry(临时态无 Owner)；Supplier(无对象) |
| 对象无 AI? | 🔴 Supplier(无 Agent)；Sample(无 Agent) |
| AI 越权? | ✅ 无（auto-convert 已删；全闸门）|
| 生命周期断裂? | 🔴 Quote→Order(origin_quote_id)；Customer PO→Order(无 PO 对象)；Material Req→Arrival(部分) |
| 对象无法追溯? | 🟡 下游靠 order_id 可追✅；**上游(quote→order、customer→quote)断**🔴 |

---

## 11. Two-Question Gate（两问门禁 — 本蓝图每个"变化"逐条复核）

> 每一项要么**同时**过两问→建，要么**否决→保持现状**。这张表本身就是未来开发的"准入清单"。

| 蓝图提出的"变化" | ① 减每天工作量? | ② 数据链更完整/准确/少重录? | 裁决 |
|---|---|---|---|
| 对象语言重组（中心=对象镜头 · 部门AI=Object Agent · 命名 Material/Delivery/Profit） | 零新建(认知工具) | 零改(认知工具) | **保留**：纯重命名/重组，零成本、零风险，仅指导后续 |
| quote→order 接线 `origin_quote_id` | ✅ 不再重打款/色/价 | ✅ Order 完整、上游可追 | **过→建(P0)** |
| 采购汇总接 UI（本轮 API 已发） | ✅ 采购每天合单不靠人脑 | ✅ Material 健康可见 | **过→建(P0)** |
| 同布同色合并采购 / 返单复制采购历史 | ✅ 每天合单/翻单省手工 | ✅ 复用历史、少重录 | **过→建(P0)** |
| **新增 Supplier 主数据**（唯一新对象） | ✅ 停止重打供应商名、得历史/比价 | ✅ 供应商成引用对象、消文本重复 | **过→建(P1)** |
| 固化 Inquiry（已有 AI 解析） | ✅ 解析落库即不再重录进报价 | ✅ 客户→询盘→报价可追 | **过→轻量建(P1)** |
| Customer PO + PO Compare | ✅ 每单核 PO 省大量手工核对 | ✅ Order 受控入口、消手工建单重录 | **过→建(P1)** |
| 收紧旧 `procurement.ts`（finance 可写采购） | ✅ 防误操作 | ✅ 守 Owner 单一 | **过→治理项(非新功能)** |
| ❌ Sample 升为独立重对象 | ❌ 里程碑+araos 已覆盖 | 🟡 边际 | **否决→保持现状** |
| ❌ Production/Purchase/Inspection/Packing 立为独立对象 | ❌ | ❌ | **否决→保持为生命周期阶段** |
| ❌ Profit 在 QIMO 重做账(AR/AP/凭证) | ❌ | ❌ 制造双真相 | **否决→记账留 finance 系统** |

> **结论**：本蓝图**唯一新增对象 = Supplier**（过两问）；**唯一新增轻对象 = Inquiry 固化**（过两问）；其余全部是**重命名/重组（零新建）**或**已识别的高价值缺口（P0/P1，均过两问）**。**没有一项是"为创新而创新"。**

---

## 最终判断：能否作为未来 5 年唯一产品蓝图？

**能——作为"判断该建什么"的唯一蓝图，可以。** 它把已有所有文档收敛成一套**对象语言**：8 个核心 SoT 对象 + 各自生命周期/Owner/真相/Agent/KPI，部门是对象的管理者，AI 是对象的守护者，Order 是脊柱。**不增一个功能，但让每个未来功能都能回答"它服务哪个对象的健康/生命周期"。**

**但有 4 个真正影响未来产品方向的问题（只提方向，不提功能）：**

1. **单一 Order 脊柱，能不能容纳"贸易单 + 委托加工/外发单"双模式？** 公司若扩 OEM/外发，Order 对象要能泛化承载"我方生产"与"外采成品"两种履约——这是 Order 生命周期是否要分型的方向问题（memory 里已有"经销单=trade、委托加工才新开外发单"的伏笔）。
2. **Supplier 这个唯一缺失对象，什么时机从"文本"升为"主数据 + 历史/评分"？** 触发点是供应商数量与比价频率——这决定 Material/Supplier Agent 何时能真正工作。
3. **Profit 永远是 QIMO 的派生投影，还是随财务系统关系演进 QIMO 要拥有更多钱的真相？** 这是 QIMO 与独立财务系统的**单一真相边界**长期怎么走。
4. **"AI 只做守护者、人工确认一切关键转移"是永久原则，还是随规模会松动？** 当订单 10 倍后，是否会有"自动补货/自动续采"的压力——Constitution 06 的耐久性，是未来必须守住的方向锚。

> 这 4 问不需要现在答；它们是**未来每次重大决策时要回看的方向锚**。

---

## 收官

**产品设计阶段到此正式结束。** 本文是接下来 3~5 年的对象语言尺子。落地阶段的每个功能，按 `Five-Centers-Blueprint` ⑬ 的"每天会用"P0→P1 顺序推进，且每件都回答一句：**它让哪个对象的健康可见、或哪个对象的生命周期/入口更完整。**
- P0：采购汇总接 UI(Material 可见) · quote→order 接线(Order 完整) · 同布同色合并(Material) · 返单复制采购(Material)
- P1：Supplier 主数据(补唯一缺失对象) · 送货跟踪 · Customer PO/PO Compare(Order 受控入口) · Inquiry 固化（Sample 保持现状，不新增对象）
> **不写代码 / 不碰 DB / 不动架构。** 设计封板。
</content>
