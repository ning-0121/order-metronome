# Business Chain Contract V1.0 — Quote ⊕ Customer PO ⊕ Order（商业链唯一契约）

> **Date**: 2026-06-30 · **这是 Contract，不是 Blueprint/Philosophy/Review。** 商业链唯一标准，**所有未来开发必须遵守**。
> **整合**：`Quote-Blueprint-V1.0` + `Customer-PO-Blueprint-V1.3(Freeze)` + `Order-Blueprint-V1.0` + `Business-Object-Integration-Review-V1.0`（含其 6 项闭合规则）。
> **契约词义**：**MUST=必须** · **MUST NOT/NEVER=禁止** · **MAY=允许** · **REFERENCE=只存 id 引用不复制** · **INHERIT=自动继承** · **RE-CONFIRM=须人工重新确认**。
> **不新增对象/中心/概念/模块；不推翻任何 Blueprint。**

---

## 一、Business Chain Contract（三对象数据契约）

| 三个事实（永不混淆） | 拥有者 |
|---|---|
| **报价 Offer**（我方愿以什么价提供） | Quote |
| **客户主张 Order-Intent**（客户要买什么） | Customer PO |
| **公司承诺 Commitment**（我方确认做什么） | Order |

**关系契约（两段，类型不同）：**
1. **Quote → Customer PO = REFERENCE**。Customer PO MUST 引用 `quote_id` 作比对基线；Customer PO MUST NOT 继承 Quote 的值（PO 的真相是客户主张）。**Quote Line ↔ PO Line = M:N 映射**（PO Compare 时建立，MUST 记录映射）。
2. **Customer PO → Order = INHERITANCE**。Order MUST 100% 继承 Confirmed Customer PO；**PO Line → Order Line = 1:1**。
3. Order MUST 是全公司运营脊柱：一切下游 MUST 挂 `order_id`；Order MUST NOT 拥有下游真相（大货单耗/工艺/实际成本/物料各有 Owner）。

---

## 二、Field Ownership Contract（字段归属）

| 字段 | Owner（唯一可改） | Reference | Inherit | Re-confirm | NEVER modify |
|---|---|---|---|---|---|
| **Customer** | Customer(customers) | Quote/PO/Order 引用 customer_id | — | — | 成交历史 |
| **Product/款** | **Product(款库)** | Quote/PO/Order 引用 product_variant_id | — | PO 对版 | 已晋升款定义 |
| **Color/Size** | Product(定义) | — | PO 捕获客户主张→Order 继承 | PO Compare | — |
| **Quantity** | 各对象各拥自己事实：Quote=quoted·PO=ordered·Order=confirmed | — | PO confirmed→Order | PO(🔴) | confirmed 后受 Lock |
| **Price** | 同上(quoted/PO/confirmed) | — | PO confirmed→Order | PO(🔴) | confirmed 后受 Lock |
| **Cost** | Quote(估算)；实际→Finance(下游) | — | — | — | — |
| **Margin** | Quote | — | — | — | — |
| **Lead Time/Delivery Date** | Quote(假设)/PO(客户)/Order(承诺) | — | PO→Order | PO(🔴) | shipped 后锁 |
| **Incoterm/Payment/Currency** | Quote(提案)/PO(客户)/Order(确认) | — | PO→Order | PO(🔴) | 确认后受 Lock |
| **Packing/Shipping Mark/Remark** | Customer PO(客户要求) | — | PO→Order | PO(🟡) | — |
| **Factory/Priority/各中心 Owner** | **Order(内部字段)** | 引用 factory_id | — | — | — |
| **Status** | **各对象各拥自己**(Quote.status / PO.status / Order.lifecycle_status) | — | MUST NOT 共享 | — | — |
| **Version** | Quote/PO 各自；Order 用 **Amendment** | — | — | — | 历史版冻结 |

---

## 三、Inheritance Contract（PO → Order 继承）

| 类别 | 字段 | 规则 |
|---|---|---|
| **MUST 100% 自动继承** | 款/色/码/确认量/确认价/币种/交期/包装/唛头/付款/Incoterm/客户要求 | 来自 **Confirmed** Customer PO，**禁止手打** |
| **MAY 修改**（仅内部） | order_no/Factory/Priority/各中心 Owner | Order 自填，不属客户数据 |
| **MUST RE-CONFIRM**（继承前） | 🔴 Critical：量/价/币种/交期/付款/Incoterm | 须在 PO Compare 阶段 resolve+审批，确认值才继承 |
| **NEVER modify**（冻结） | PO Number/Quote Number/原始文件/提取快照/行映射/源引用(origin_quote_id, source_po) | 永久只读 |
| **Lock by 进度** | 已采购→料驱动字段锁；已生产→大部分锁；已出货→全锁 | 见 Customer PO V1.3 §7 Lock Matrix |

---

## 四、Reference Contract（只引用，禁复制）

下列 MUST 以 **id 引用**，MUST NOT 复制对象数据：
| 引用 | 指向 | 状态 |
|---|---|---|
| `customer_id` | customers | ✅(Quote 须接线) |
| `quote_id` / `origin_quote_id` | quoter_quotes | ✅(须接线) |
| `product_id` / `product_variant_id` | products/variants | ✅ |
| `source_po` / `source_po_version` | Customer PO | ✅ |
| `factory_id` | factories | ✅ |
| `inquiry_id` | Inquiry | 🟡(Inquiry 待固化) |
| `supplier_id` | Supplier 主数据 | 🔴(主数据未建,见缺口) |

> 规则：引用对象的数据 MUST 实时取 Owner，MUST NOT 在本对象再存一份可编辑副本。

---

## 五、Version Contract

| 对象 | MUST 产生 Version | MUST NOT 产生 Version | 用 Amendment |
|---|---|---|---|
| **Quote** | Sent 后再报价（价/量/条款变） | 同一草稿内编辑 | — |
| **Customer PO** | 客户改版（PO V1→V2） | 同版内核对修正 | — |
| **Order** | **永不 Version** | — | **MUST 用 Amendment**（Confirm 后变更，受 Lock + 审批） |

> 规则：**成交前对象(Quote/PO)改版用 Version；承诺对象(Order)变更用 Amendment。** 历史 Version MUST 冻结只读。

---

## 六、Approval Contract（差异/变更驱动）

| 对象 | MUST 审批 | 差异驱动 | NEVER 审批 |
|---|---|---|---|
| **Quote** | 毛利<底线 / 特价 / 非标条款 → CAN_APPROVE_PRICE+finance；**审批时 MUST 设价格地板** | 是 | 标准毛利标准条款 |
| **Customer PO** | 🔴 差异：价→finance·期→production·量→采购+finance·要求→merchandiser | 是 | 无 🔴 差异 / 客户价 **≥ Quote 地板**（自动过） |
| **Order** | 变更(改单/延期)涉价/期/量 → CAN_APPROVE_DELAY/PRICE | 是 | 正常 18 关卡执行 |

> 规则：**无差异/无变更 = MUST NOT 触发审批**（护工作量）；价格地板协同消除 Quote/PO 重复审批。

---

## 七、AI Contract（跨三对象统一）

| AI **MAY**（允许） | AI **NEVER**（禁止） |
|---|---|
| Parse(OCR) · Generate(草稿) · Suggest · Analyze · Predict · Compare | Confirm(确认) · Approve(审批) · Create Order(建单) · Change Price/Qty/Profit/Status · Send to Customer · Resolve Difference · Release Milestone |

> 规则：AI 输出 MUST 是 草稿/建议/派生；AI MUST NOT 跨越任何人工确认闸门（Constitution 06）。三对象的 Agent（Quote/PO/Order）MUST 共享底层分析（毛利/交付/物料），MUST NOT 各实现一套（防漂移）。

---

## 八、Traceability Contract

任何 **Order Line.字段** MUST 可经存储 id 逐级回溯，MUST NOT 出现孤儿：
```
Order Line.field
 → source_po_line → source_po + version
 → Resolution(确认值/谁/何时/为何)
 → Approval(谁批/何时)
 → (经行映射) → Quote Line → Quote
 → Attachment / Evidence
 → 客户原始 PO PDF(冻结) + Timeline
```
> 规则：每一跳 MUST 是 id 引用；终点（原始 PDF + 提取快照）MUST 冻结。

---

## 九、One Truth Contract（验证无双真相）

| 检查 | 结论 | 为什么 |
|---|---|---|
| 重复真相? | **无** | 量/价/期 = 3 个**不同事实**(quoted/ordered/confirmed)，各一 Owner |
| 重复维护? | **无** | Order 继承=**新事实(承诺)**，PO 冻结不再维护；非"复制维护" |
| 重复录入? | **设计无**（接线后归零） | 客户/款=引用；客户值=PO OCR 一次；承诺=Order 继承 |
| 边界不清? | **闭合后无** | 客户(必接 id)、款(Product 拥有) 已由 Integration Review 定 |

> **为什么没有双真相**：① 每个事实 exactly 一个 Owner ② "同名字段不同阶段"是不同事实非副本 ③ 引用非复制 ④ 下游真相(成本/工艺)各有 Owner 挂 order_id。**前提：customer_id 接线 + Product 拥有款（契约第二/四节已固化）。**

---

## 十、Developer Contract（100 人 / 10 年 / 只看这一份，防做错）

**最易理解错的 8 点 + 防错规则（MUST 记住）：**
| # | 易错 | 契约规则 |
|---|---|---|
| 1 | 以为 Order 继承 Quote | **Order 继承 Customer PO；PO 只引用 Quote** |
| 2 | 以为 Quote Line→Order Line 1:1 | **Quote↔PO 是 M:N 映射；只 PO→Order 1:1** |
| 3 | 以为 qty/price 重复了 | **3 个不同事实(quoted/ordered/confirmed)，非重复** |
| 4 | 以为 AI 能从 Confirmed PO 自动建单 | **MUST 人工 Convert** |
| 5 | 以为 Order 拥有成本/工艺/物料 | **Order 是锚；下游各有 Owner** |
| 6 | 想直接改 PO 修数据 | **原始快照冻结；改走 Resolution，不覆盖证据** |
| 7 | 以为 Order 像 Quote/PO 出 Version | **Order 用 Amendment，不 Version** |
| 8 | 以为 PO Compare 结果是存储真相 | **PO Compare/Profit/健康分 = Derived-Never-Stored** |

> 规则：开发遇任何"该继承还是引用/该改还是重确认/谁拥有"的疑问，MUST 回本契约二/三/四节，不得自行决定。

---

## 十一、Final Lock

**Quote + Customer PO + Order 正式成为 QIMO OS 商业链唯一标准。**

- 本契约 = 商业链最终、唯一、强制遵守的 Contract（高于 Blueprint/Review；冲突时以本契约为准）。
- **以后不得再讨论商业链产品设计**，进入开发阶段，开发 MUST 遵守本契约。
- **唯一解锁条件**：出现**新的真实业务**（需经"对象准入双门禁 + 两问门禁"）才允许修订本契约；否则**只允许开发，不允许重新设计**。

**进入开发的"最后一公里"= 4 项接线（实现，非设计）：**
1. `customer_id` / `origin_quote_id` / `quote_id` 连接。
2. Confirmed PO → Order 100% 继承（按第三节继承字段清单）。
3. Quote↔PO 行 M:N 映射机制。
4. 价格地板协同（Quote 设地板，PO 据此自动过/触发审批）。

---

## 残余依赖（不阻断封板，落地须知）
- **Supplier 主数据未建** → `supplier_id` 引用暂空（属执行链，非商业链三对象问题）。
- **Inquiry 未固化** → `inquiry_id` 引用暂软。
- 多币种/多交期 Header 汇总口径、PO 拆/合单字段表 → 落地清单项（规则已在 PO V1.3）。

> **本文 = 商业链最终 Contract（封板）。** 不写代码 / DB / migration / UI。商业链设计到此终止。
</content>
