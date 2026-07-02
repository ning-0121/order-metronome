# ADR-005 — 确定性内核:单域单算法,SQL 不做计算

**Status**: Accepted (2026-07-02)

## Context
系统演进到 SCM OS 后,出现"同一事实多处计算"的风险(例:净需求既在 `material_requirements.net_purchase_qty` 由 MRP 算,又在 `procurement_items.suggested_purchase_qty` 另算;可用量若既有函数又建 SQL view 则双算)。这违反 Constitution 02(单一真相源)。有人提议把计算迁进 SQL view 作为"Kernel View Layer"。

## Decision
确立 **DDOS(Deterministic Data OS)两层**:

1. **Data Truth Layer(DB)** —— 只存事实,**不做业务计算**。`material_master` / `inventory_transactions` / `inventory_reservation` / `material_requirements` / `orders` / `customer_po` / `material_supplier` 等。SQL 只用于**存储 / 索引 / 检索**。

2. **Deterministic Kernel Layer(`lib/services/*`,唯一计算区)** —— 所有业务计算是**纯确定性函数**:无 DB 写、无副作用、可单测(入 `npm run check`)、可复现。

**铁律**:
- **单域单算法**:每种业务事实只有**一个**计算函数。第二处(另一个函数 / SQL view / UI / action 内联)重算同一事实 = 违规。
- **函数即视图**:"Kernel View" = 纯函数,**不是 SQL view**。SQL view 不可测、RLS 别扭、且会与既有函数形成双真相 —— 故**禁止用 SQL view 做计算引擎**(仅可做对外/报表的只读投影,且引用同一函数口径,不作并行算法)。
- **Action = 薄壳**:只做 auth + 编排(拉单一源数据 → 调 kernel 函数),不含业务计算。
- **UI = 纯消费**:只渲染 kernel 输出,绝不自算。
- **AI = 只读解释层**:explain / compare / warn / simulate,**永不算真相、不做决策、不覆盖 kernel**。

### 已确立的单一计算源(kernel 函数)
| 事实 | 唯一函数 | 位置 |
|---|---|---|
| 库存可用量 | `availableToPromise` / `computeAvailability` | `lib/services/inventory.ts`(SC-P2) |
| 净需求/缺口 | `shortageTruth` | `lib/services/procurement-kernel.ts`(本轮) |
| 供应商排序 | `sourcingTruth` | 同上 |
| 执行步骤 | `executionTruth` | 同上 |
| MRP 需求 | `computeMaterialRequirement` | `lib/services/mrp.ts`(ADR-002) |
| 单位换算 | `convertUnit` | `lib/services/material-catalog.ts`(SC-P1) |
| 归并键 | `consolidationKey` | `lib/services/procurement-consolidation.ts` |

## Consequences
- ✅ 每个数字可溯源到唯一 kernel 函数;每个决策可从原始事实解释。
- ✅ 纯函数全部单测入 check,回归安全。
- ✅ 不迁 SQL view = 零重写既有真相源(Evolution not Rewrite)。
- ⚠️ 遗留双算需收敛:`procurement_items.suggested_purchase_qty` 与 MRP net 的口径分工要显式(净需求源 = `shortageTruth`;suggested 引用之,不并行算)。
- 关联:Constitution 02 · ADR-002 · ADR-004。
