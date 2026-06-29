# QIMO OS — Domain Template（业务域标准模板)

> **纪律**:以后任何 Domain(Order/Product/Material/Supplier/Production…),**没有这九章,不允许开发**。
> 统一模板 → 全团队一致,十年不乱。每个域文档放 `docs/Domains/<Domain>.md`,按本模板写。

---

## 模板九章

### 01 Vision（为什么存在)
这个域解决什么业务问题?不存在会怎样?一句话使命。

### 02 Capability（提供什么能力)
对应 [`Capability-Map.md`](Capability-Map.md) 的哪个/哪些稳定能力。

### 03 Business Objects（业务对象)
核心对象 + 表 + 关键字段。每个对象**只拥有自己的数据**(Constitution 04)。

### 04 Business Events（业务事件)
本域**产生**哪些事件(来源)、**监听**哪些事件(消费)。对齐 [`Event-Catalog.md`](Event-Catalog.md)。

### 05 Lifecycle（生命周期)
核心对象的状态机(draft→…→closed)。**推进不复制**(Constitution 03)。

### 06 Data Ownership（数据所有权)
本域拥有哪些数据、禁止碰哪些(引用上游而非复制)。对齐 [`Object-Relationship-Map.md`](Object-Relationship-Map.md)。

### 07 APIs（提供什么能力接口)
本域对外暴露的 server actions / API(给别的域/UI/AI 调用)。Domain 通过 API 被消费,不被页面绑定。

### 08 UI（有哪些入口)
Web / Mobile / AI / API / Robot / BI —— 列出当前入口。**入口是表现层,不是系统;Center 是 UI,Domain 才是系统。**

### 09 Future Roadmap（三年路线)
第 1/2/3 年演进。先闭环(80%,DP-7),再优化,再 AI。

---

## 配套门禁(DoD)
建/改这个域前必须过:
- 🏛 **Architecture Gate**:属哪个 Domain?数据所有权谁?有无重复真相?
- 🔮 **Future Gate**:三年后 / 5 工厂 / 10 工厂 还成立吗?
- **EA 四问**:哪个 Business Flow / 哪个 Domain / 改哪个 Object / 产生什么 Event?答不出不许写。

> 现有 `docs/Domains/Domain-Map.md` 是 13 域的**摘要**;每个域成熟时,按本模板**展开成独立 `Domains/<Domain>.md`**(如 Order.md / Procurement.md 已有雏形,逐步补齐九章)。
