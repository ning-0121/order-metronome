# Confirmed Debt · `quantity_unit` 字符串解析脆弱

**状态**:BACKLOG(2026-08-17 CEO 裁定:登记,本轮不扩)
**位置**:`lib/domain/quantity-engine.ts` → `quantityComponentsForUnit()`
**风险等级**:中(不再是逐款算料主链的 blocker,但仍在别处被依赖)

---

## 事实

`quantityComponentsForUnit()` 靠正则从订单级 `quantity_unit` 文本里猜"每商业单位几件":

```ts
if (/^件$|^pcs?$|^piece(?:s)?$/i.test(normalized)) return 1;
if (/^三件套$/.test(normalized)) return 3;
if (/^套$/.test(normalized)) return 2;          // ← 裸「套」硬当 2 件
const match = compact.match(/套[（(]?(\d+)\s*件[)）]?/);   // 「套(4件)」这类才认
```

2026-08-17 实测(`deriveQuantityContext`,physicalQuantity=2400):

| `quantity_unit` | 解析出的件/套 | 是否合理 |
|---|---|---|
| `件` | 1 | ✅ |
| `三件套` | 3 | ✅ 唯一被硬编码的中文数字 |
| `套` | **2** | ⚠️ 猜的 —— 裸「套」并不含"2 件"的信息 |
| `两件套` | **1** | ❌ 解析失败,静默按 1 |
| `四件套` | **1** | ❌ 解析失败 |
| `三件套装` | **1** | ❌ 多一个「装」字就失败 |
| `套装` | 1 | ❌ |
| `null` | 1 | needsReview=true(这个有标记) |

失败是**静默**的:返回 1,不报错、不置 needsReview,下游看不出"没解析出来"。

## 为什么这轮不修

2026-08-17 的 1022967 事故修复后,**逐款算料(BomTab 显示 / 提交采购 MRP)已经不再依赖这个解析** ——
两处都改成显式传该款 `set_multiplier`(优先级压过单位串,见 `deriveQuantityContext` 第 162 行)。

所以主链已经绕开它。继续修会把战线拉回 quantity engine,而当前优先级是采购 P0 Pilot。

## 但它还没死

`quantityComponentsForUnit` 仍被 `deriveQuantityContext` 作为**第二优先级**使用:
凡是**没有**传 `componentsPerCommercialUnit` 也没有可靠 `lineItemMultipliers` 的调用方,
仍然吃这个正则的结果。订单级汇总、展示格式化(`formatQuantityUnit`)等路径都还在这条线上。

## 修的时候该怎么修(不是现在)

1. **别再从自由文本猜数量语义。** `quantity_unit` 是给人看的标签,不是结构化字段。
2. 真相应该来自 `order_line_items.set_multiplier`(款级,已经是结构化事实)。
3. 若确实要保留文本兜底:解析失败必须 `needsReview=true` + `reviewReason`,**不许静默返回 1**。
4. 中文数字要覆盖 一~十 且容忍「套/套装/件套」后缀,并配单测表格。

## 关联

- 事故与主链修复:见 `docs/ADR/`(1022967)与 `tests/set-multiplier-precedence.test.ts`
- 数量语义 canonical:`lib/domain/quantity-engine.ts` 抬头 + `tests/quantity-semantics.test.ts`
