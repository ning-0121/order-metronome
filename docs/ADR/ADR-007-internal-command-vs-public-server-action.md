# ADR-007 — 内部特权编排走 internal command,不走公开 Server Action

**Status**: Accepted (2026-08-15) · 现状记录 + 后续 capability 的约束(P0 已落地部分不回头重构)

## Context

采购 P0 遇到一个结构性冲突:

- `consolidateOrderProcurementItems` 的角色闸是 `procurement / procurement_manager / admin`;
- 但 P0 要求**跟单提交 BOM 后系统自动归并** —— 跟单不是采购角色,直接调用必被拒。

第一反应是加 `opts.systemActor: true`。**那是提权漏洞**:该函数是 `'use server'` 导出,
浏览器可以直接调用并伪造任意 JSON 参数 —— 布尔标志等于任何登录用户都能跳过采购角色闸。

P0 的解法是 `SYSTEM_ACTOR`(`Symbol`,见 `lib/procurement/systemActor.ts`):
Symbol 不可序列化,Server Action 的参数通道传不进来,只有同进程服务端代码拿得到。
测试覆盖 8 种伪造形态 + JSON 往返,确认客户端无法构造。

这个解法**安全但不是终局**。真正的问题是:一个公开的 `'use server'` action 同时承担了
「外部调用」和「内部特权调用」两种语义 —— 安全性靠一个参数类型的巧妙,而不是靠结构。

## Decision

**目标结构**(新 capability 一律按此建):

```
public Server Action        ← 唯一对外入口,只做 authorization
      ↓
internal application command  ← 非导出 / 非 'use server';特权编排住这里
      ↓
Repository Contract → Adapter
```

**规矩**

1. 新 capability 的特权编排一律写成 **internal command**(非 `'use server'` 模块),
   由 Server Action 鉴权后调用。**不要继续复制 Symbol 模式。**
2. `'use server'` 文件里的导出 = 公开 API。凡是"只应由系统调用"的路径,不许出现在那里。
3. 已落地的 `SYSTEM_ACTOR`(consolidate 一处)**本轮不重构** —— 已证明客户端不可伪造,
   P0 通过。它是**过渡态**,不是范例。
4. `lib/procurement/advanceCommand.ts` 是目标结构的样板:它刻意**不是** `'use server'`,
   正因为它内部持有 `SYSTEM_ACTOR`;一旦导出成 Server Action,提权入口就对浏览器敞开了。

**判定新代码是否违规的一句话**:
> 如果一个 `'use server'` 导出函数,在某个参数下会绕过它自己的权限检查 —— 这就是违规。

## Consequences

- ✅ 权限边界从"参数类型的巧妙"变成"模块可达性" —— 结构性保证,不依赖 reviewer 的警觉。
- ✅ 公开 action 的职责收窄成鉴权 + 转发,更容易审计。
- ⚠️ 存量:`consolidateOrderProcurementItems` 的 `systemActor` 参数是唯一一处过渡态,
  P1 拆 consolidate core 时一并收掉(那时本来就要把 326 行算法抽成非 action 模块)。
- ⚠️ 本 ADR 目前没有静态闸。可加的检测是"'use server' 导出函数体内出现 `isSystemActor(`"
  —— 等第二处出现再建闸,现在只有一处,建闸不如直接收掉。

关联:[ADR-006](./ADR-006-data-access-layering-ratchet.md)(数据访问分层)、
`docs/Designs/P0P1-Procurement-Architecture-Cut.md` §3。
