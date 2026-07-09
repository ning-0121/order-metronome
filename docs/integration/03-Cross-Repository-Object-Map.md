# QIMO OS — Cross Repository Object Map（跨仓库对象/域/数据库地图）

> **Status**: 🟡 集成方案（不写代码 / 不写 migration / 不改库 / 不提交 / 不 push）。**Evolution NOT Rewrite · One Owner · One Source of Truth**。
> **本文 = 第五步（Enterprise Domain Mapping）+ 第七步（Cross Repository Database Map）**。
> 三个独立 Supabase：QIMO `scrtebex…` · finance `qpoboel…` · ARAOS `hpdcqjf…`。

---

## 5. Enterprise Domain Mapping（企业域 → 仓库来源 / 代码位置 / 数据库 / 迁移策略）

> 原则：一个域有唯一 owner 系统；跨系统消费靠**引用企业 ID + 契约**，不复制真相。

| # | 企业域 | Owner 系统 | 现有代码位置 | 现有数据库（表） | 迁移策略 |
|---|---|---|---|---|---|
| 1 | **Commercial / Customer-Development**（线索/公司/Deal/外联） | **ARAOS** | `araos/actions/{companies,contacts,deals,outreach}` + `agents/*` | ARAOS：companies/contacts/deals/customer_events/outreach_logs/conversations | Keep+升级为一级域；赢单晋升交 QIMO |
| 2 | **Customer（确认客户）** | **QIMO** | `app/actions/*`（customers）+ `customer_rhythm`/`customer_matters` | QIMO：customers/customer_rhythm/customer_matters | Keep；ARAOS 晋升写入、finance 引用 id |
| 3 | **Inquiry（询盘/RFQ）** | **QIMO** | `app/actions/quoter.ts::parseInquiryFile`（OCR，未落库） | QIMO：（待固化，EA V1.1） | 固化 Inquiry 对象；ARAOS 消费 |
| 4 | **Quote（正式报价：成本/单耗/margin）** | **QIMO** | `app/actions/quoter.ts` + `lib/quoter/*` | QIMO：quoter_quotes(+5 训练表) | 收口为企业正式 Quote 真相（EA V1.1） |
| 4b | **售前 Quote 策略（议价/margin 阶梯）** | **ARAOS** | `araos/actions/quote.ts` + `lib/quote` | ARAOS：quote_strategies/pricing_config | Keep 为决策支持；成交引用 QIMO Quote |
| 5 | **Order（客户订单）** | **QIMO** | `app/actions/orders.ts` + 18 关卡 | QIMO：orders/order_line_items/milestones | Keep=企业订单 SoT |
| 6 | **Product**（款/Variant/Definition/BOM） | **QIMO** | `app/actions/{bom,product}` | QIMO：products/product_variants/product_definitions/product_bom_templates | Keep；finance/ARAOS Reference |
| 7 | **Material**（主数据/Package/单耗） | **QIMO** | `app/actions/bom.ts` + `material-master` | QIMO：material_master/materials_bom | Keep |
| 8 | **Manufacturing Planning**（生产任务单） | **QIMO** | `app/actions/manufacturing-order.ts` | QIMO：manufacturing_orders | Keep |
| 9 | **Procurement**（核料/MRP/采购） | **QIMO** | `app/actions/procurement*` + `lib/runtime` MRP | QIMO：material_requirements/procurement_items/procurement_line_items | Keep |
| 10 | **Supplier** | **QIMO（寻源身份）+ finance（付款属性）** | QIMO 采购 + finance `suppliers` | QIMO（待建 Supplier 域）/ finance：suppliers/supplier_payments | Split-by-aspect，共享 supplier id |
| 11 | **Warehouse / Production / Quality / Packing / Shipment** | **QIMO** | QIMO（部分在建） | QIMO：（在建/规划） | Keep（EA V1.0 路线） |
| 12 | **Finance**（预算/成本实际/AR/AP/发票/收付款/总账/结算利润/FX/税/工资） | **finance-system** | `finance/src/app/api/*` + `src/lib/{accounting,engines}` | finance：budget_orders/cost_items/order_settlements/actual_invoices/receivable_*/payable_*/journal_*/exchange_rates/tax_refunds/payroll_* | Keep=企业钱真相；引用 QIMO id；实际回流 QIMO forecast 缓存 |
| 13 | **Analytics**（企业级看板） | **QIMO（聚合）** | QIMO Runtime/risk + 各系统只读 | QIMO：runtime_events/runtime_orders + 跨系统只读契约 | 只读投影，不拥有真相 |
| 14 | **Notification / Automation** | 各系统 + 企业事件总线 | finance cron/wecom；ARAOS queue/workers；QIMO runtime | — | 横切，围绕事件 |
| 15 | **AI（Intelligence）** | 横切，各系统自有 | finance `lib/agents`；ARAOS `agents/*`；QIMO `lib/quoter` RAG + parseInquiry | — | **永不跨系统直接写真相**（DP-5） |
| 16 | **Employee / Identity** | 各系统 Supabase Auth（暂） | 三处 profiles | 三处 | 暂各自；远期统一 Identity（非本期） |
| 17 | **Factory** | **QIMO（制造真相）** | QIMO | QIMO；ARAOS factory_* 复制 | ARAOS 归档、Reference QIMO |

> **域归属一句话**：**ARAOS 拥有"成交前"的商业域；QIMO 拥有"成交到出运"的订单/生产域；finance 拥有"钱"的域。** 三段无缝衔接 = 一个 Enterprise OS。

---

## 7. Cross Repository Database Map（每张关键表：Owner / SoT / Consumers / 处置）

> 处置：**Keep**=保留为真相 · **Reference**=改存他系统企业 id 不再克隆 · **Cache**=可留镜像但键改 id · **Split**=按阶段/方面拆 · **Archive**=降级/不再当真相。
> 仅列**跨系统相关**的关键表（各系统纯内部表如 GL queue/agent_queue 不在此，保持原样）。

### 7.1 客户 / 商业（Customer / Commercial）
| 表 | 所在库 | Owner | SoT | Consumers | 处置 |
|---|---|---|---|---|---|
| ARAOS `companies` | hpdcqjf | ARAOS | ✅ 潜客阶段 | ARAOS pipeline；赢单→QIMO | **Keep**（潜客主体） |
| ARAOS `contacts` | hpdcqjf | ARAOS | ✅ | ARAOS；QIMO Reference | **Keep** |
| ARAOS `deals`/`customer_events` | hpdcqjf | ARAOS | ✅ | ARAOS | **Keep** |
| QIMO `customers` | scrtebex | **QIMO** | ✅ **企业确认客户** | QIMO/finance/ARAOS | **Keep**；加被引用的企业 Customer ID |
| QIMO `customer_rhythm` | scrtebex | QIMO | ✅ 成交后节奏 | QIMO | **Keep**（Split：售前节奏在 ARAOS） |
| QIMO `customer_matters` | scrtebex | QIMO | ✅ 投诉/风险 | QIMO | **Keep** |
| finance `customers` | qpoboel | finance（现自建） | ❌ 应引用 | finance 账务 | **Reference**：改存 `qimo_customer_id`，停 `get_or_create_customer` |
| ARAOS `customer_scores`/`*_reports` | hpdcqjf | ARAOS | 派生 | ARAOS | **Keep**（派生） |

### 7.2 报价 / 成本 / 利润（Quote / Cost / Profit）
| 表 | 所在库 | Owner | SoT | Consumers | 处置 |
|---|---|---|---|---|---|
| ARAOS `quote_strategies`/`pricing_config` | hpdcqjf | ARAOS | ✅ 售前策略 | ARAOS 议价 | **Keep**（决策支持，非成交真相） |
| ARAOS `quotes`(legacy) | hpdcqjf | ARAOS | — | — | **Archive** |
| QIMO `quoter_quotes`(+训练) | scrtebex | **QIMO** | ✅ **正式报价** | QIMO/finance forecast | **Keep**；接 ARAOS 上游 + 喂 finance |
| QIMO `order_cost_baseline` | scrtebex | QIMO | ✅ **估算成本** | QIMO/finance | **Split**：估算@QIMO |
| QIMO `profit_snapshots` | scrtebex | QIMO | ✅ forecast；live/final 应读 finance | QIMO 看板 | **Split**：forecast 自有；live/final **Cache** finance 回流 |
| finance `budget_orders` | qpoboel | finance | ✅ 财务预算 | finance | **Keep**，但 `qimo_order_id` 引用（停 notes ILIKE） |
| finance `cost_items`/`budget_sub_documents`/`actual_invoices` | qpoboel | **finance** | ✅ **实际成本/AP** | finance | **Keep** |
| finance `order_settlements`/`profit_order_styles` | qpoboel | **finance** | ✅ **结算利润** | finance→QIMO 回流 | **Keep**；新增回流契约 |
| finance `_cost_breakdown`(in budget_orders.items) | qpoboel | finance（现重存） | ❌ 来自 QIMO quote | finance 计算 | **Reference**：标记来源 quote id，不当独立真相 |

### 7.3 订单 / 生产（Order / Production）
| 表 | 所在库 | Owner | SoT | Consumers | 处置 |
|---|---|---|---|---|---|
| QIMO `orders`/`order_line_items` | scrtebex | **QIMO** | ✅ **企业订单** | 全员 | **Keep**；暴露企业 Order ID |
| QIMO `manufacturing_orders` | scrtebex | QIMO | ✅ | QIMO 生产 | **Keep** |
| QIMO `materials_bom`/`material_requirements`/`procurement_items` | scrtebex | QIMO | ✅ | QIMO 采购 | **Keep** |
| finance `synced_orders` | qpoboel | finance（镜像） | ❌ cache | finance | **Cache**：键改 `qimo_order_id` |
| finance `pending_approvals` | qpoboel | finance | 流程态 | finance↔QIMO callback | **Keep**（用企业 id） |
| ARAOS `orders` | hpdcqjf | ARAOS（薄） | ❌ | handoff | **Archive→指针**：存 `qimo_order_id` |
| ARAOS `samples` | hpdcqjf | ARAOS（售前） | 🟡 | handoff→QIMO 生产 | **Reference**（pushed_to_metronome→qimo ref） |

### 7.4 供应商 / 工厂 / 汇率（Supplier / Factory / FX）
| 表 | 所在库 | Owner | SoT | Consumers | 处置 |
|---|---|---|---|---|---|
| finance `suppliers`/`supplier_payments` | qpoboel | finance（付款属性） | ✅ 付款侧 | finance AP | **Split**：付款@finance |
| QIMO 采购供应商 | scrtebex | QIMO（寻源身份） | ✅ 寻源侧 | QIMO 采购 | **Split**：身份@QIMO Supplier 域；共享 supplier id |
| ARAOS `factory_*` | hpdcqjf | ARAOS（复制） | ❌ | ARAOS 推荐 | **Archive**：Reference QIMO 制造真相 |
| finance `exchange_rates` | qpoboel | **finance** | ✅ **FX master** | finance/QIMO | **Keep**；QIMO 报价 pin 快照 |

### 7.5 收付款 / 总账 / 告警（Payment / GL / Alerts）
| 表 | 所在库 | Owner | SoT | Consumers | 处置 |
|---|---|---|---|---|---|
| finance `receivable_payments`(+allocations) | qpoboel | **finance** | ✅ **AR 回款** | finance；回流 QIMO 客户目标 | **Keep**；新增回款→QIMO 回流 |
| finance `payable_records` | qpoboel | **finance** | ✅ **AP** | finance | **Keep** |
| finance `journal_*`/`accounts`/`gl_balances` | qpoboel | **finance** | ✅ **总账** | finance | **Keep**（企业唯一 GL） |
| finance `tax_refunds`/`payroll_*`/`bank_*` | qpoboel | **finance** | ✅ | finance | **Keep** |
| QIMO `system_alerts` | scrtebex | QIMO | ✅ 订单风险 | QIMO | **Keep**；企业看板聚合 |
| finance `alerts`/`financial_risk_events` | qpoboel | finance | ✅ 财务风险 | finance | **Keep**；企业看板聚合 |

---

## 8. 身份脊柱（Identity Spine）—— 集成的物理地基

> 所有"Reference / Cache / 回流"处置，都依赖一件事：**三系统能用同一个企业 ID 互指。** 这是第七步所有处置的前提，单列于此。

| 企业身份 | 权威 Owner | 现状（脆弱） | 目标（脊柱） |
|---|---|---|---|
| **Enterprise Customer ID** | QIMO `customers.id` | finance 按 name 自建、ARAOS companies 独立 UUID | ARAOS 赢单晋升→QIMO 生成/关联 customers.id；finance 引用同一 id |
| **Enterprise Order ID** | QIMO `orders.id` | finance 按 order_no/notes ILIKE 猜、ARAOS orders 独立 | QIMO 发企业 Order ID；finance synced_orders / ARAOS orders 存 id 指针 |
| **Enterprise Quote ID** | QIMO `quoter_quotes.id` | 三处各算 | QIMO 正式 Quote ID；ARAOS 策略/ finance forecast 引用 |
| **Supplier ID** | QIMO Supplier 域（待建） | finance suppliers 独立、ARAOS factory 复制 | 共享 supplier id，finance 付款属性引用 |

> **没有身份脊柱，所有集成都退化成"猜名字"。** Phase 0 的唯一目标就是把这张表落地（详见 `04-…` Phase 0）。
</content>
