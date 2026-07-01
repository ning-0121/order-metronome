# 14 — External System Contract v1（BridgeSession · /api/os/accept 规范）

> **Date**: 2026-07-01 · **os-external-contract-v1**。QIMO OS 铸 BridgeSession，外部系统（finance / araos）实现 accept 端点消费。
> **本文只是规范**：finance / araos 在**各自 repo** 实现，QIMO 不改它们代码。目标未实现前，QIMO 侧自动降级为普通受控跳转。

---

## 1. BridgeSession 令牌结构
QIMO 铸造：`token = base64url(session JSON) + "." + HMAC-SHA256-hex(canonical)`。

**session（payload）**
```json
{
  "session_id": "uuid",
  "sub": "员工邮箱",
  "roles": ["finance", "..."],
  "capabilities": ["finance.view", "..."],
  "aud": "<本系统 id: finance | araos>",
  "iat": 1751000000,
  "exp": 1751000090,
  "jti": "uuid",
  "nonce": "uuid",
  "scope": ["finance.view"]
}
```

**canonical 串**（铸/验必须完全一致，`\n` 连接、固定顺序）
```
session_id \n sub \n roles.join(',') \n capabilities.join(',') \n aud \n iat \n exp \n jti \n nonce \n scope.join(',')
```

**签名**：`HMAC-SHA256(OS_TOKEN_SECRET_<SYS>, canonical)` hex，恒定时间比较。

---

## 2. 端点：`POST /api/os/accept`（目标系统实现）

**Input**
| 字段 | 说明 |
|---|---|
| `token` | BridgeSession 令牌（`body.signature` 自包含）；等价于分离的 `token=body` + `signature=hmac` |
| `aud` | 本系统 id（校验必须等于 session.aud） |

> 传输：QIMO handoff 以 302 重定向到 `{base}/api/os/accept?token=...`。目标可实现为 GET 引导（读 `?token`）或 POST API；校验步骤一致。

**Validation（MUST 全过）**
1. **HMAC verify**：用约定 secret 重算 canonical 签名，恒定时间比对。
2. **exp check**：`now ≤ exp`（TTL 90s）。
3. **aud match**：`session.aud === 本系统 id`（防跨目标重放）。
4. **jti not reused**：`jti` 未被消费过（内存/轻量存储；参考 `lib/os/jtiStore.ts`）→ 消费后 remember 到 exp。
5. **scope match**：`session.scope` 与本系统承认能力一致（越界 scope 拒绝）。

**Output（成功）**
```json
{
  "session_created": true,
  "identity": { "sub": "员工邮箱" },
  "roles": ["..."],
  "capabilities": ["..."],
  "scope": ["..."]
}
```
随后目标建**本地会话**并重定向到本系统首页。任一校验失败 → 拒绝并跳本系统登录页。

---

## 3. 参考实现（QIMO 提供，目标复刻）
- 验签 + 时效 + aud + jti：`lib/os/bridge.ts::verifyBridgeSession(token, secret, aud, nowSec, { jtiSeen })`。
- jti 重放守卫：`lib/os/jtiStore.ts::isJtiSeen / rememberJti`。
- **⚠️ Serverless 注意**：内存 jti 存储每实例独立、非跨实例强一致；生产强一致需共享存储（Redis/DB）。本契约 v1 用 短时 TTL + aud 绑定 + jti 最佳努力，足以覆盖受控内网跳转。

## 4. 密钥与身份
- 每目标独立 `OS_TOKEN_SECRET_<SYS>`（QIMO 与目标各存一份，绝不外泄）。
- 身份锚 = 员工邮箱（`sub`）；目标以邮箱映射本地用户。企业微信目录映射属 Phase 2。

## 5. 版本
`os-external-contract-v1`。字段/canonical 顺序变更即升 v2；不得静默改签名口径（会使全部目标验签失败）。
