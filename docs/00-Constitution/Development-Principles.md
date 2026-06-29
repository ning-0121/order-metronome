# QIMO OS Development Principles（开发原则）

> **Status**: Active　**Date**: 2026-06-29　**Priority**: High（仅次于 Constitution）
>
> **本文件描述「我们怎么造」,Constitution 描述「系统是什么」。两者严格分层,不允许混杂。**
> QIMO OS 不是订单/采购/生产软件,是绮陌未来十年的企业操作系统。**所有开发服从企业真实业务,不是软件功能。**

## 🧭 工作姿态(最重要的思维变化)
**不说"Claude 写代码",说"Claude 建设 Domain"。**
- ❌ 不是"今天做采购" → ✅ "今天**建设 Procurement Domain**"。
- ❌ 不是"今天做库存" → ✅ "今天**建设 Warehouse Domain**"。
- 每次开发**先想**:对象 / 生命周期 / 数据流 / 数据所有权 / 扩展性 —— **而不是直接写页面**。

---

## 开发哲学（DP-1 ~ DP-8,长期稳定)

### DP-1 — Business First（业务优先于软件)
真实业务与软件设计冲突时,**改软件,不改业务**。软件服务企业,不是企业服务软件。
> P 域重做的根因:之前站"程序员视角"(逐 BOM 行)设计采购,与采购经理真实工作(按物料核料)冲突 → 改软件。

### DP-2 — Complete Business Loop First（先完成业务闭环)
第一目标永远是**业务闭环完整,不是功能闭环、不是功能丰富**。
> 闭环能完整跑通,就进入下一 Domain。AI/审批/统计/自动化属于后续阶段。

### DP-3 — One Business Object At A Time（一次只建一个业务对象)
围绕 **Business Object** 开发,不围绕页面。页面可改,对象不能乱。一次只建设/完善一个对象,想清它的对象/生命周期/数据流再动手。(操作化 Constitution 01)

### DP-4 — System Calculates, Human Decides（系统计算,人决策 —— ERP 灵魂)
**系统**:计算 / 汇总 / 推荐 / AI / 检查。**人**:决策 / 确认 / 审批。
任何影响经营的数据必须经人工确认。这是整个 ERP 的灵魂。

### DP-5 — AI Never Owns Business Truth（AI 永不拥有企业真相 —— 未来最重要一条)
AI **只能建议**,**不能成为企业数据来源**。AI 永不直接修改企业数据,必须经人工确认才入库。(承接 Constitution 06)

### DP-6 — Build For Ten Years（面向十年)
任何对象、任何字段、任何表,先回答:**「未来 10 家工厂 / 1000 名员工 / 100 亿销售额,这个设计是否仍然成立?」** 否定 → 重新设计。
> 落地:锚稳定身份不锚易失 id、引用不复制、留扩展位(P1′ 采购项锚物料身份 → 跨订单核料是自然扩展)。

### DP-7 — Phase Before Perfection（分阶段,不追求一次完美)
Phase 1 = 闭环;Phase 2 = 优化体验;Phase 3 = AI 自动化。**第一阶段只做完整闭环(~80%),禁止追求复杂功能/完美**。最后 20% 用真实使用反馈来补。

### DP-8 — Automate Repetition（所有重复劳动交给系统)
数量/颜色/尺码汇总、核料归并、采购建议、MOQ 取整、损耗/安全库存计算、供应商推荐 —— **全部系统做,不让人做 Excel**。人只负责判断。**这是采购系统最核心的原则。**

---

## 承接的架构 / 域原则（引用,不重复)
| 原则 | 归属 |
|---|---|
| 围绕业务对象、对象只引用不复制真相 | Constitution 01 + 02 |
| 每个对象只拥有自己的数据(字段归属)| Constitution 04 |
| 系统算/人决策、AI 是助手 | Constitution 06（DP-4/DP-5 操作化)|
| 开发单耗(业务)≠ 大货单耗(采购),系统据大货单耗算量 | ADR-004 §8 |
| 采购按物料(身份+颜色+规格+单位)归并,禁 Excel 手工加总 | ADR-004 §2/§10 |

## 统一开发流程（七段)
```
Constitution → Development Principles → ADR → Domain → Design → Coding → DoD
```
**分层铁律**:Constitution 只写"是什么";本文件只写"怎么造";域规则进 ADR/Domain;阶段细节进 Design。不互相混入。
