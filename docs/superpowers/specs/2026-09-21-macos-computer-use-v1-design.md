# macOS Computer Use v1 设计

## 1. 文档状态

本文档汇总并固化 2026-09-21 的需求讨论结论，作为后续 `/spec-driven` 建立项目 `SPEC.md` 的设计输入。本文档记录设计结果及理由，不是当前实现事实，也不授权实现。

## 2. 目标

构建一个 TypeScript macOS computer-use runtime。它在 Tart 一次性 macOS VM 中运行 AUT、Appium、Mac2 Driver 和 WebDriverAgentMac，由 Host 上的 Gateway/Kernel 以可恢复、可审计、默认安全的方式完成：

- 不可变 Golden Image 的获取和一次性 clone 生命周期；
- VM、Guest、Driver 和 AUT 的分层 readiness；
- 基于 Mac2 的元素优先桌面观察与操作；
- 预先声明、独立评估的业务断言；
- write-ahead、内容寻址、可验证的 Evidence；
- 崩溃后的保守收敛和资源清理；
- 供普通 TypeScript 程序、CLI 及未来集成使用的 Public Client API。

核心安全语义是：Provider 接受命令不等于业务效果已确认。只有预先声明的独立断言成立，动作或 Run 才能获得确认。

## 3. 范围

### 3.1 v1 包含

- Apple Silicon macOS Host。
- Tart OCI Golden Image 和一次性 VM clone。
- Host-only 网络及 `tart exec` Guest 控制。
- Guest 内固定版本的 Appium 3、Mac2 Driver、Xcode/WDA Mac 和预装 AUT。
- 单进程、单用户、全局串行运行。
- Mac2 元素操作、窗口内 Observation 和确定性/显式 AI 断言。
- Host 本地 Evidence、Run 查询、导出和恢复。
- 严格 JSON Scenario，作为 CLI Demo 和集成测试入口。
- 原生 macOS Fixture AUT。

### 3.2 v1 不包含

- 并发 Run、队列、warm pool、多 VM scheduler 或多客户端共享。
- 常驻 daemon、HTTP 服务、本地 socket 或远程控制面。
- 动态插件系统。
- Golden Image 构建、补丁、TCC provisioning 或运行时软件安装。
- 任意 `macos:*` 命令透传、AppleScript、任意 Guest shell、系统 UI 自动操作。
- 绝对屏幕坐标、绝对窗口坐标及其 fallback。
- 运行中自动修复权限、自动放宽网络、自动继续崩溃前业务步骤。
- 条件、循环、变量、并行或子场景 DSL。
- 恶意 Guest 的强安全沙箱保证。
- 数字签名或抵御恶意篡改的 Evidence 保证。

## 4. TypeScript 技术基线

- Node.js 24 LTS。
- pnpm，`pnpm-lock.yaml` 是依赖解析权威。
- 单 package、原生 ESM、TypeScript `NodeNext`。
- `tsc` 编译到 `dist/`，不使用 bundler。
- 严格类型检查，至少启用 `strict`、`noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`。
- Zod 是外部和持久化数据的 runtime schema 权威；TypeScript 类型由 Schema 推导。
- Vitest、ESLint 和 Prettier 分别承担测试、静态检查和格式化。
- 构建产物不提交 Git。
- CI 至少运行 typecheck、lint、test 和 build。

### 4.1 架构级别

采用 Level 2：分层单 package。项目只有一个部署/发布单元，但必须隔离 Kernel 业务语义与 Tart、Appium/Mac2、进程和文件系统边界。当前复杂度不需要 workspace 或多个发布 package。

## 5. 模块与依赖方向

```text
src/
  contracts/
  kernel/
  adapters/
    tart/
    guest/
    mac2/
    evidence/
  client/
  cli/

tests/
examples/
fixtures/macos-test-app/
```

依赖方向：

```text
CLI -> Client -> Kernel -> Contracts
                  |
                 Ports
                  ^
               Adapters
```

- `contracts`：中立类型、Zod Schema、稳定错误码和 Port 契约。
- `kernel`：Run、状态机、readiness、Action Transaction、Evidence 协调、恢复和策略。
- `adapters`：Image、VM、Guest、Desktop 和 Evidence Port 的生产实现；Adapter 不互相直接调用。
- `client`：唯一公开编程入口和生产 composition root。
- `cli`：只调用 Client/Application 操作。
- 外部只导出 Public Client API 和必要 Contracts。Kernel、Port 和 Adapter 保持私有。
- Kernel 不根据 Provider 名称分支；Provider 类型不进入 Contracts。

## 6. 部署拓扑

```text
Host
  TypeScript CLI / Public Client API
              |
       Gateway / Kernel
        |            |
   Local Evidence   Tart CLI
                     |
            Host-only control network
                     |
Guest ephemeral VM
  Tart Guest Agent
  Appium Server
  Mac2 Driver / WebDriverAgentMac
  AUT
```

- Gateway 是进程内 Application Service，不是 daemon。
- CLI 与 Public Client API 在同一进程调用 Gateway。
- Appium、Mac2、WDA Mac 和 AUT 全部在一次性 Guest 内。Host 不使用本机 Appium 操作 Guest。
- `tart exec` 只管理 Guest 探针、Appium 进程和受控 Artifact 导出。
- Appium 在 Guest 固定端口 `4723` 提供服务；Host 通过 `tart ip --resolver agent` 获取 Guest 地址。
- Tart 使用 Host-only 网络。禁止 bridged networking 和公网端口转发。默认关闭共享剪贴板。
- Appium endpoint 不进入公共配置、Agent 输出或 Evidence。网络隔离无法建立时拒绝 Run。

## 7. 全局串行模型

v1 完全不支持并发：

- 同一 Host、同一用户最多一个活动 Run。
- 最多一个由本项目管理的 VM clone。
- Run 内一次只允许一个 lifecycle、observe、action 或 assertion 操作。
- Adapter 和 Hook 顺序执行。
- 用户级 `stateRoot` 中的 OS 文件锁提供跨进程互斥；进程内变量不构成锁。
- 竞争直接返回 `GatewayBusy`，不排队。
- Gateway 启动时必须先收敛遗留 Run 和 clone，之后才允许创建新 Run。
- 遗留资源归属不明或 cleanup 失败时拒绝新 Run。

## 8. 核心结果模型

### 8.1 ActionResult

动作结果拆成正交事实与策略，不使用一个含糊状态枚举：

```typescript
type ActionResult = {
  dispatch: "notDispatched" | "dispatched" | "unknown";
  providerOutcome: "succeeded" | "failed" | "unknown";
  verification:
    | "notRequested"
    | "confirmed"
    | "contradicted"
    | "unverifiable";
  retryDisposition: "safe" | "unsafe" | "reconcileRequired";
};
```

Mac2 正常返回但没有独立后置验证时：

```typescript
{
  dispatch: "dispatched",
  providerOutcome: "succeeded",
  verification: "unverifiable",
  retryDisposition: "unsafe",
}
```

`providerOutcome: succeeded` 只表示 Provider 正常处理命令，不表示业务效果发生。`unknown` 用于 timeout、崩溃、连接中断或 receipt 缺失等无法确定事实的情况。

### 8.2 幂等与重试

```typescript
type Idempotency = "idempotent" | "nonIdempotent" | "unknown";
```

- 幂等性描述重复执行后的系统状态语义。
- `retryDisposition` 描述本次结果能否重试。二者不能合并。
- 通用 click 默认 `idempotency: unknown`。
- 已 dispatch 且动作非明确安全时为 `unsafe`。
- dispatch 或执行状态未知时为 `reconcileRequired`。
- 非幂等动作和 Action dispatch 不自动重试。

### 8.3 RunResult

```typescript
type RunResult = {
  verdict: "passed" | "failed" | "inconclusive";
  evidence: "complete" | "incomplete";
  cleanup: "completed" | "failed";
};
```

- 必要最终断言全部成立：`passed`。
- 任一必要断言明确不成立：`failed`。
- 无法完成必要断言、readiness 失败或执行状态未知：`inconclusive`。
- Action 成功不自动产生 `passed`。
- Evidence 和 cleanup 不覆盖业务 verdict。

## 9. Public Client API

第一版称 Public Client API，不声称为独立发布 SDK：

```typescript
const client = createMacOSComputerUseClient(config);

const result = await client.run(options, async (run) => {
  const observation = await run.observe();
  // query, action, assertion
});
```

- `client.run()` 负责获取全局锁、恢复、创建 Run、分配 VM、readiness、执行、Evidence finalize 和 cleanup。
- 回调成功、失败或取消都进入 finalize 和 cleanup。
- Run 已创建后，业务失败、Evidence 不完整或 cleanup 失败仍尽力返回完整 `RunResult`。
- Run 句柄离开回调后失效，后续使用返回稳定的 `RunClosed`。
- 不公开允许调用方绕过 cleanup 的底层环境生命周期接口。
- CLI 和未来 Pi、Jev、MCP、FSQ 集成都通过该 API，不直接进入 Kernel。

公共 API 使用显式结果，而不是把预期业务失败作为异常：

```typescript
type OperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: OperationError };
```

内部不变量违反或编程错误才抛异常。Adapter 异常必须在边界归一化。

## 10. Port 与静态装配

五个核心 Port：

- `ImagePort`：确保不可变 OCI 镜像可用。
- `VmPort`：clone、start、inspect、stop、destroy。
- `GuestPort`：probe、服务生命周期和诊断 Artifact 导出。
- `DesktopPort`：Mac2 session、observe、dispatch、session cleanup。
- `EvidencePort`：append event、commit artifact、commit manifest。

所有异步 Port 接受 `AbortSignal`。取消信号表示请求停止，不证明底层效果已撤销。Adapter 执行单次调用，不隐藏重试或业务流程；Kernel 独占调用顺序、timeout、retry、状态机和结果分类。

生产 composition root 静态装配：

```text
TartImageAdapter
TartVmAdapter
TartExecGuestAdapter
Mac2DesktopAdapter
LocalEvidenceAdapter
SystemClock
SecureIdGenerator
FileGatewayLock
```

默认工厂不允许普通调用方替换单个生产 Adapter。测试使用内部 test composition 注入 Fake Ports。不使用反射、Service Locator 或动态插件扫描。

## 11. Golden Image 与 VM 生命周期

- Golden Image 使用不可变 OCI reference + digest；禁止 `latest` 或可变标签作为身份。
- v1 只支持 Tart Registry/OCI，不支持普通 HTTPS 镜像下载。
- 缺失镜像可在无活动 Run 且持有全局锁时拉取；校验 digest 后才提交缓存。
- digest 不匹配返回 `ImageDigestMismatch`；缓存损坏时隔离，不直接覆盖。
- 每个 Run 从 Golden Image 创建独立 clone，绝不启动或修改 Golden Image 本体。
- clone 名称由 Gateway 生成；cleanup 只删除有可信 Run 归属的受管 clone。
- 共享 Golden Image 缓存不随 Run cleanup 删除。
- Golden Image 的制作、Xcode/Appium/Mac2 安装、Fixture AUT、签名和 TCC provisioning 是独立维护流程，不属于正式 CLI。

### 11.1 受管资源记录

clone 前原子持久化 `clonePlanned`，随后依次记录 `cloneCreated`、`started`、`cleanupStarted` 和 `cleanupCompleted`。名称中的受管前缀不是唯一归属证明。

恢复对账规则：

- 记录存在、clone 不存在：记录资源已缺失并收敛 Run。
- 记录与一个 clone 匹配：执行保守 cleanup。
- 发现无可信归属的受管 clone、多个受管 clone或损坏记录：进入 `RecoveryRequired`。
- 非本项目管理的 Tart VM 完全忽略，绝不删除。

## 12. Readiness 与环境生命周期

生命周期和 readiness 正交：

```typescript
type EnvironmentLifecycle =
  | "allocating"
  | "active"
  | "cleaningUp"
  | "closed"
  | "failed";

type ReadinessStatus = {
  vm: ProbeResult;
  guest: ProbeResult;
  driver: ProbeResult;
  app: ProbeResult;
  overall: "ready" | "notReady" | "failed";
  generation: number;
};
```

- VM：Tart 已启动且可检查。
- Guest：Guest OS、Guest Agent、用户桌面会话和 `tart exec` live probe 成功。
- Driver：Appium 可用，真实 Mac2 session 和基础 Observation 成功。
- AUT：应用已启动，预先声明的窗口/UI readiness 条件成立。
- `overall: ready` 仅在所有必需 probe 成功且未过期时成立。
- `appReady` 前不向调用方暴露可操作 Run。
- 每个 probe 记录 `observedAt`、有效期、耗时和诊断引用。
- 运行中 readiness 失效时停止新动作，但不能推断已 dispatch 动作未执行。
- readiness 失败使 Run `inconclusive`，随后 cleanup。

### 12.1 Generation 与 lease

- `generation` 是环境身份版本；VM、Guest、Mac2 session 或 AUT 重建时递增。
- v1 每个 Run 只有一个独占 lease。
- lease 过期、撤销或不匹配时，在 dispatch 前返回 `LeaseExpired`：`notDispatched + safe`。
- lease 失效后拒绝新动作，但继续 Evidence finalize 和 cleanup。
- lease 由 Client 在结构化作用域内自动维护，不允许多客户端共享或抢占。

## 13. AUT 与窗口边界

- AUT 通过 `bundleId` 启动；不接受 Host 路径或原生 PID。
- AUT 必须预装于 Golden Image；Run 期间不动态安装软件。
- 每个 Run 只支持一个前台 AUT，但 AUT 可以拥有多个窗口。
- 启动参数和环境变量使用显式 allowlist；Secret 使用引用。
- “进程存在”不构成 AppReady，必须满足预声明窗口或 UI 条件。
- Kernel 只在 readiness 阶段激活 AUT 一次；运行中焦点丢失时停止 Scenario，不自动抢回焦点。
- AUT 重启会递增 generation。v1 不允许 Scenario 重启 AUT。
- AUT 自有窗口、Sheet、Popover 和稳定菜单元素可操作；macOS 权限弹窗、系统设置、登录框、菜单栏和其他应用窗口禁止操作。

窗口使用结构化查询：

```typescript
type WindowQuery = {
  title?: TextMatch;
  role?: string;
  isMain?: boolean;
  isModal?: boolean;
};
```

窗口查询必须唯一。`WindowRef` 是 Observation-bound 的 Gateway 临时 ID，不包含 PID 或原生窗口 ID。模态窗口出现后必须重新观察。

## 14. Observation 与双层 Snapshot

一次 Observation 捕获一个 canonical snapshot。Screenshot 和 UI tree 应来自同一稳定捕获窗口，但不宣称绝对同一时刻。Observation 默认限制在 AUT 当前目标窗口。

### 14.1 Compact Snapshot

模型默认收到低 Token 视图：

```text
snapshot=s42 app=Calculator window=w7 coverage=partial
[e0] button "1" enabled
[e1] button "+" enabled
[e2] button "=" enabled
[e3] text "0"
```

Compact Snapshot 至少包含 snapshot/app/window 逻辑 ID、Element 临时 ID、中立 role、主要文本、关键状态、coverage 和截断原因。Compact 未找到不能证明元素不存在。

### 14.2 Structured Snapshot

当 Compact 信息不足、匹配歧义或覆盖不完整时，调用方按需查询或展开同一 canonical snapshot，获得 identifier、name、label、value、role/type、状态、geometry、完整 locator signals、匹配数、分页及截断诊断。

```typescript
observation.compact();
observation.query(query);
observation.expand(elementId);
```

- 两级视图是同一 snapshot 的确定性投影，共享逻辑 Element ID。
- Mac2 page source 只捕获一次。
- Kernel 通过完整内部 Snapshot 验证唯一性，不能只相信 Compact 文本。
- Structured API 优先接受结构化查询，不默认把完整树发送给模型。
- 新 Action 后，相关窗口两级视图及 ElementRef 同时失效。
- 每个窗口只有最新 Observation 可用于动作；Scenario 每一步重新观察并查询。
- 全屏 screenshot 仅用于 readiness/焦点诊断，标记 `potentiallySensitive`，不能用于动作定位。

## 15. 元素查询与引用

普通调用方只使用结构化 Query：

```typescript
type ElementQuery = {
  role?: string;
  identifier?: string;
  name?: TextMatch;
  label?: TextMatch;
  value?: TextMatch;
  state?: {
    enabled?: boolean;
    selected?: boolean;
    focused?: boolean;
  };
};
```

- 字段合取匹配；失败时不能退化为更宽查询。
- 返回 `unique | ambiguous | notFound | incomplete`。只有 `unique` 生成 ElementRef。
- Query 基于未截断内部 Snapshot；未知 state 不等于 `false`。
- 默认 API 不接受 XPath、predicate、Appium locator、PID 或原生 ID。
- role 是项目定义的中立角色，由 Mac2 Adapter 映射到 `XCUIElementType`。
- Query 值必须安全编码，不能字符串拼接生成原生表达式。

ElementRef 绑定 Run、环境、generation、session、window 和最新 snapshot。dispatch 前 Kernel 检查归属、lease、generation、session、readiness、snapshot 新鲜度和唯一性；Adapter 再根据 live state 唯一解析。失效引用在 dispatch 前返回稳定 `StaleElementRef + safe`。

## 16. 严禁绝对坐标

Public Client、Scenario、Kernel 和 Adapter 契约完全禁止绝对屏幕/窗口坐标作为动作输入，也不提供高级 fallback。元素解析失败时直接失败。

允许元素内部归一化位置：

```typescript
type RelativePoint = {
  x: number; // 0..1
  y: number; // 0..1
};

type ElementPoint = {
  element: ElementRef;
  point?: RelativePoint; // default 0.5, 0.5
};
```

- `(0.5, 0.5)` 是元素中心；`(0.2, 0.5)` 是距左缘 20%、垂直居中。
- dispatch 前重新解析元素和最新几何，将比例转换为 Mac2 元素内像素偏移。
- 边缘点可安全内缩，避免落在边界外。
- 原生 Element ID、元素内像素偏移和几何不越过 Adapter 边界，也不进入公共 Receipt。
- 不能使用旧 Snapshot 几何作为 fallback。
- 如果某 Mac2 动作无法在不使用绝对坐标的前提下稳定映射，则该动作变体返回 `UnsupportedAction`。

## 17. Desktop Action 能力

能力面由固定兼容的 Mac2 Driver 契约显式定义，不透传任意 `macos:*` 命令。首个兼容基线使用 Mac2 4.3.1，并在后续 SPEC/兼容矩阵中固定。

### 17.1 指针动作

```typescript
type PointerAction = {
  kind: "click" | "doubleClick" | "rightClick" | "hover";
  target: ElementPoint;
  modifiers?: readonly Modifier[];
};
```

- doubleClick 使用 Mac2 原生单次 dispatch，不拆成两个 click Transaction。
- click/doubleClick/rightClick 默认幂等性 unknown。
- 元素不可见、几何无效或不唯一时在 dispatch 前失败。

### 17.2 Scroll、Swipe 与 Drag

```typescript
type ScrollAction = {
  kind: "scroll";
  target: ElementPoint;
  delta: { x: number; y: number }; // relative to element dimensions
};

type SwipeAction = {
  kind: "swipe";
  target: ElementPoint;
  direction: "up" | "down" | "left" | "right";
  velocity?: "slow" | "default" | "fast";
};

type DragAction = {
  kind: "drag";
  from: ElementPoint;
  to: ElementPoint;
  durationMs?: number;
};
```

- scroll delta 以元素宽高比例表达，由 Adapter 转成 Mac2 delta。
- swipe 使用 Mac2 的起点、方向和受控速度档位，不伪造成 from/to。
- drag 使用元素相对起止点。Adapter 只有在 Mac2/W3C 元素 origin 路径可以保持元素相对语义时才能 dispatch；不得转成绝对屏幕坐标。
- scroll、swipe、drag 默认非幂等；部分完成时 Provider outcome 可为 unknown。

### 17.3 文本

```typescript
type TextAction =
  | { kind: "appendText"; target: ElementRef; value: TextInput }
  | { kind: "replaceText"; target: ElementRef; value: TextInput };
```

- appendText 使用 Mac2 keys，默认非幂等。
- replaceText 使用元素 set-value，语义为最终值替换，通常幂等。
- set-value 不支持时在 dispatch 前失败，不退化为全选、删除、输入的多步模拟。
- TextInput 只允许 literal 或 SecretRef。换行以文本语义处理；组合键使用独立 pressKey。

### 17.4 键盘

```typescript
type PressKeyAction = {
  kind: "pressKey";
  key: SupportedKey;
  modifiers?: readonly ("command" | "control" | "option" | "shift" | "function")[];
};
```

- 使用稳定中立键名，由 Adapter 映射。
- 不接受原生 key payload、任意 key code 或 AppleScript。
- 一个组合键对应一次 Provider dispatch。
- 多键序列拆为多个 Action Transaction。

Touch Bar 专属动作、AppleScript、剪贴板、录屏、deep link 和应用生命周期不属于普通 Desktop Action。Mac2 升级不能自动扩大公开能力面。

## 18. Provider Receipt

Adapter 返回标准化回执：

```typescript
type ProviderReceipt = {
  provider: string;
  operationId: string;
  dispatch: "notDispatched" | "dispatched" | "unknown";
  outcome: "succeeded" | "failed" | "unknown";
  startedAt: string;
  finishedAt?: string;
  diagnosticRef?: ArtifactRef;
};
```

- Receipt 只陈述 Provider 层事实。Adapter 不能宣告 Confirmed。
- operationId 是 Kernel 生成的关联 ID，不暴露原生 Provider ID。
- timeout、取消和连接中断仍尽力生成 Receipt；不能确定时必须使用 unknown。
- 原始 Provider response 只进入受控诊断 Artifact。

## 19. 独立断言

```typescript
type AssertionResult = {
  assertionId: AssertionId;
  status: "passed" | "failed" | "unverifiable";
  observationRef?: ArtifactRef;
  reasonCode: AssertionReasonCode;
};
```

- 断言必须在 Action dispatch 前声明并冻结，不能看见结果后编造成功条件。
- 后置断言必须基于同一 Run、同一 generation、晚于 Action 的新 Observation。
- Provider Receipt 不能作为业务断言证据。
- Assertion 不读取 Action Adapter 私有状态或原生 ID。
- 条件明确成立、明确不成立、无法可靠评估分别为 passed、failed、unverifiable。
- 多个 required assertion 全部通过才使动作 `confirmed`；任一明确失败使其 `contradicted`；证据不足为 `unverifiable`。
- Screenshot/UI Snapshot 可作为输入，但捕获成功本身不构成确认。

v1 确定性断言包括 visible、notVisible、text、value、state 和 elementOrder。AI 视觉断言单独标记 `method: aiVisual`，记录模型和证据；只有调用方预先明确接受时才能独立产生 Confirmed。

`notVisible` 只有在目标窗口完整可访问树被未截断扫描、Query 可完整表达、且目标不存在或明确 visible=false 时才 passed。普通 notFound 或 Compact 缺失不能证明不可见。

## 20. Scenario

Scenario 是严格 JSON、无控制流的 Demo/集成入口，TypeScript API 仍是主要公共接口。

```typescript
type Scenario = {
  schemaVersion: 1;
  name: string;
  actions: readonly ScenarioStep[];
  finalAssertions: readonly AssertionSpec[];
};

type ScenarioStep = {
  stepId: string;
  window?: WindowQuery;
  preconditions?: readonly AssertionSpec[];
  target: ElementQuery;
  action: ActionSpec;
  verification:
    | { policy: "immediate"; assertions: readonly AssertionSpec[] }
    | { policy: "deferred" };
};
```

- JSON 使用与 Public Contracts 共用的 Zod Schema 严格验证，未知字段拒绝。
- Scenario 不包含原生 ID、Host 路径、绝对坐标或任意脚本。
- 每一步重新 Observation 和 Query，不能持久化或手写 ElementRef。
- precondition 基于 before Observation；失败或无法验证时不 dispatch。
- immediate 至少一个 assertion；deferred 必须显式书写。
- 顶层至少一个 final assertion。
- final assertion 可确认整体目标，但不能倒推 deferred Action 自身已 confirmed。
- Step 严格顺序执行；dispatch/outcome unknown、Provider 失败、required assertion failed/unverifiable 或 after evidence 失败时停止后续业务步骤。
- 停止后仍执行 finalize 和 cleanup。
- Scenario 不控制 VM、Appium、AUT 启停，也不启动其他应用。
- v1 不在运行时调用 LLM 解释 Scenario。

Scenario 名称和 stepId 不能直接成为路径或 clone 名称。Kernel 另行生成 ActionId、ObservationId 和 AssertionId。Manifest 记录 Scenario SHA-256；未执行步骤标记 `notRun`。

## 21. Action Transaction

每个动作严格执行：

```text
验证全局锁、lease、generation、readiness
-> 捕获 before Observation 并评估 preconditions
-> 解析并唯一绑定 ElementRef
-> Evidence preflight
-> 提交 required before evidence
-> 持久化并 fsync ActionPlanned
-> Adapter dispatch
-> 持久化 ProviderReceipt
-> 捕获 required after Observation
-> 评估预声明 assertions
-> 生成 ActionResult
-> 提交 Step Record
```

- dispatch 前任一步失败均为 notDispatched。
- ActionPlanned 已提交但可靠 receipt 前崩溃，恢复为 dispatch/outcome unknown、verification unverifiable、reconcileRequired。
- after Observation 失败时保留已知 Provider outcome，verification 为 unverifiable。
- assertion 失败不把 Provider outcome 从 succeeded 改成 failed。
- Action 后相关窗口的所有 ElementRef 失效。

## 22. Evidence 架构

Evidence 是 Kernel 强制事务，不是 best-effort Hook。核心 Evidence 不可关闭。它由 write-ahead timeline、标准化 Receipt、内容寻址 Artifact Store 和最终 Manifest 构成。

### 22.1 事件

```typescript
type EvidenceEvent<T extends EventType> = {
  schemaVersion: 1;
  runId: RunId;
  sequence: number;
  recordedAt: string;
  elapsedMs: number;
  type: T;
  source: "kernel" | "adapter" | "hook";
  provider?: string;
  data: EventDataByType[T];
};
```

- Kernel 是 timeline 单写入者并分配 Run 内唯一单调 sequence。
- sequence 是顺序权威；墙上时间仅用于展示和关联。
- data 按 type 使用严格 Schema，不接受无约束字典。
- 事件 append-only；修正通过新事件表达。
- 未知事件或更高 schemaVersion 保留原始数据，但读取方不得假装理解。
- 至少记录 Run、环境、readiness、Observation、Action planned/receipt、Assertion、Evidence error、cleanup、recovery 和 Run finish。

### 22.2 Evidence 阶段

```typescript
type EvidenceStatus =
  | "preflightPassed"
  | "beforeCaptured"
  | "afterCaptured"
  | "manifestCommitted"
  | "incomplete";
```

Preflight 只证明基础设施当前可用，不能保证 after capture 必然成功。required Artifact 全部提交且 Manifest 原子提交后，Evidence 才 complete。失败时保留已成功 Artifact，并标记 incomplete。EvidenceIncomplete 不覆盖业务 verdict，也不无限阻止 VM cleanup。

### 22.3 Artifact 原子提交

```text
写入 Run 临时文件
-> fsync 文件
-> 计算 SHA-256
-> 原子重命名到内容寻址路径
-> fsync 父目录
-> 追加 ArtifactCommitted 事件
```

- 相同 SHA-256 已存在时验证大小与内容后复用。
- 未被提交事件引用的临时文件是 orphan，恢复时隔离或清理。
- Artifact Descriptor 包含类型、Run 内相对路径、MIME、大小、SHA-256 和敏感级别。
- Manifest 和事件不暴露 Host 绝对路径。

### 22.4 Manifest

Manifest 是 timeline 和 Artifact Store 的确定性投影，不是第二事实源。它至少包含 Run/build/config/environment/result、event count、timeline SHA-256 和 Artifact descriptors。

- 原子提交 Manifest 后 Evidence 才 complete。
- 普通 Run finish 后不再追加普通事件。
- Recovery 追加事件时产生新 Manifest revision并保留旧 revision，不覆盖。
- `runs show` 和 export 重新校验 timeline 与 Artifact hash，不匹配报告 `EvidenceCorrupted`。
- SHA-256 只用于完整性检测，不宣称抵抗恶意篡改。

## 23. 本地目录与持久化

```text
stateRoot/
  gateway.lock
  runs-index.jsonl
  recovery/

evidenceRoot/
  runs/<runId>/
    timeline.jsonl
    manifest.vN.json
    environment.json
    steps/
    artifacts/<sha256>
    diagnostics/

tempRoot/
  <runId>/
```

- state、长期 Evidence 和临时文件分离。
- 默认使用 macOS 用户级 Application Support/Cache 边界，但可显式配置。
- v1 不同时使用多个 Evidence Root。
- Public API 只暴露 RunId、ArtifactRef 等逻辑引用。CLI 通过显式 show/export 解析。
- Run 目录默认 `0700`，文件默认 `0600`。

### 23.1 Schema 版本

- 每类持久化记录独立 `schemaVersion: 1`。
- 写入方只写当前版本；读取方支持当前版本。
- 更高或未知版本保留原文件并拒绝解释；恢复进入 `RecoveryRequired`。
- v1 不自动迁移。未来迁移必须是显式、离线、可审计操作。
- 修改既有字段语义必须提升 schemaVersion。

## 24. 崩溃恢复

Gateway 获取全局锁后执行：

```text
校验 stateRoot
-> 读取未闭合 Run
-> 枚举 Tart 受管 clone
-> 对账归属
-> 收敛 timeline
-> 尽力导出剩余 Guest Artifact
-> 关闭 Mac2/Appium
-> 删除受管 clone
-> 提交恢复结果
-> 接受新 Run
```

- 恢复阶段不接受普通 Run。
- v1 恢复只收敛 Evidence 和 cleanup，不继续业务动作。
- 未闭合动作根据现有 Receipt 分类；无法确定时为 unknown + reconcileRequired。
- 原 Run最终 inconclusive。继续目标需要新 Run，不继承 lease、generation、session 或 ElementRef。新 Run 可记录 previousRunId。
- 归属冲突、多个受管 clone、状态损坏、未知 schema 或 cleanup 失败进入 `RecoveryRequired`。
- 显式 `recover` CLI 与启动恢复使用同一 Kernel 路径。

## 25. Timeout、取消与重试

TimeoutConfig 至少分别定义 Run 总预算、image pull、clone、VM boot、Guest ready、Appium start、Mac2 session、App ready、observe、action、assertion、Evidence finalize 和 cleanup。

- 阶段预算不能突破剩余 Run 总预算。
- cleanup 使用独立保留预算，不因业务预算耗尽而跳过。
- timeout 和 duration 使用注入的单调时钟；墙上时间不决定 timeout。
- readiness 单次 probe timeout 与阶段总 timeout 分开。
- timeout 触发取消请求，不证明底层操作停止。
- dispatch 前取消/timeout 为 notDispatched + safe。
- dispatch 中取消/timeout 根据 Receipt 分类；不能证明时 reconcileRequired。
- cleanup 不继承普通取消信号。强制终止进程不等于撤销已产生的外部效果。
- 仅 retryDisposition safe 的前置、只读或环境操作可由 Kernel 自动重试。Adapter 不隐藏重试。
- retry 共用原阶段预算；maxAttempts 包含首次尝试。Action dispatch v1 不自动重试。

## 26. 错误模型

```typescript
type OperationError = {
  code: ErrorCode;
  phase:
    | "image"
    | "vm"
    | "guest"
    | "driver"
    | "observe"
    | "action"
    | "evidence"
    | "cleanup";
  message: string;
  retryDisposition:
    | "safe"
    | "unsafe"
    | "reconcileRequired"
    | "notApplicable";
  dispatch?: "notDispatched" | "dispatched" | "unknown";
  diagnosticRef?: ArtifactRef;
};
```

- code 稳定且可编程判断。Adapter 将 Provider 错误映射成统一错误。
- Agent/调用方只看到安全 message。stderr、Appium response、堆栈和绝对路径进入受控诊断 Artifact。
- Error 不单独推断业务效果；ActionResult 是动作事实权威。
- `reconcileRequired` 必须先观察或执行声明的协调逻辑，不能直接重试。

## 27. Hook 边界

Hook 仅用于 OpenTelemetry、视频、外部日志、上传或自定义业务状态等非核心扩展：

- Hook 不能提供 required Evidence，不能决定是否 dispatch，也不能修改动作、参数、状态机或业务结果。
- Hook 不直接写 timeline/Manifest，只返回结构化贡献，由 Kernel 校验、持久化和分配 sequence。
- Hook 按配置顺序调用，每个有独立 timeout 和取消信号。
- 失败/超时只产生 `HookFailed`。慢 final Hook 不无限阻止 cleanup。
- Hook Artifact 默认 `potentiallySensitive`。
- 外部上传默认关闭，必须显式启用并配置外部 retention。
- v1 Hook 只能读取清洗后的事件，不能读取原始诊断。

## 28. 敏感信息与安全

### 28.1 Secret

```typescript
type SecretRef = {
  name: string;
  purpose: "textInput" | "appEnvironment";
};
```

- Secret 值只存在内存，在使用时由 Host allowlisted resolver 读取。
- 不进入配置、Scenario、timeline、Receipt、错误或 Evidence；不记录长度。
- textInput 在单次 dispatch 前解析；appEnvironment 默认禁用，只能在 AUT 启动时受控注入。
- Secret 不能用于路径、命令、bundle ID、网络地址、Query 或 locator。
- 未知 SecretRef 在 dispatch 前安全失败，不自动重试。

### 28.2 Artifact 与日志

- UI Snapshot 和结构化日志持久化前清洗已知敏感字段。
- Screenshot、原始 Driver/Guest 日志统一标记 `potentiallySensitive`；不承诺完全脱敏。
- Audit Event 是 append-only 事实；Diagnostic Log 用于调试；Operator Log 是安全摘要。三者不能混用。
- 清洗失败时宁可不保存诊断，也不保存疑似 Secret。debug 模式不能绕过脱敏。

### 28.3 隔离边界

- 一次性 VM 是环境隔离和回收边界，不声明抵抗恶意 Guest 内核或虚拟化逃逸。
- 只运行可信 Golden Image 和 AUT。
- 不挂载 Host 用户目录或可写共享目录；Guest 不获得 Host SSH agent、云凭证或任意文件访问。
- Host 只解析受限、校验后的 Guest 输出。路径穿越、符号链接、特殊文件及超限归档必须拒绝。

### 28.4 TCC

- 自动化权限只存在 Guest，不修改 Host Accessibility、Automation 或 Screen Recording。
- Golden Image provisioning 独立完成；正式 Run 不修改 TCC DB、不点击权限弹窗、不调用工具绕过系统安全。
- readiness 通过真实 Mac2 session/Observation 验证权限。权限不足返回 `GuestPermissionNotGranted`，Run inconclusive 后 cleanup。

## 29. Guest 网络

Guest 默认离线，只保留 Host–Guest 控制通道。AUT 需要网络时，Run 配置必须在启动前声明最小规则：

```typescript
type NetworkRule = {
  cidr: string;
  ports: readonly number[];
  protocol: "tcp" | "udp";
};
```

- v1 只支持 CIDR + port + protocol，不支持域名 allowlist。
- 禁止 `0.0.0.0/0` 等全开放规则。
- DNS 默认关闭，只有显式 53 端口规则才开放。
- 规则在 VM 启动前验证、冻结，Scenario 不能修改。
- 连接失败不能自动放宽。Softnet 或隔离策略不可验证时拒绝 Run。
- Fixture AUT 和默认集成测试完全离线。

## 30. Guest Artifact 导出

- 核心 timeline、Manifest、Screenshot 和 UI Snapshot 由 Host Evidence Adapter 持久化。
- Appium、WDA 和 Guest 日志先写 Guest Run 专属临时目录，finalize 时通过 `tart exec` 受限归档流导回。
- 导出限制相对路径、单文件大小、总大小和文件数；Host 拒绝路径穿越、符号链接和特殊文件并重算 SHA-256。
- 不把 Host Evidence 目录以可写共享目录挂入 Guest。
- 已由 Appium 返回 Host 的 Screenshot/UI Snapshot 不重复导出。
- 导出失败标记 EvidenceIncomplete，但仍 cleanup。Guest 目录随 VM 销毁，不承担 retention。

## 31. 配置

配置由一个严格本地配置文件和显式调用参数组成：

```typescript
type GatewayConfig = {
  image: { reference: string; digest: string };
  aut: { bundleId: string };
  timeouts: TimeoutConfig;
  evidence: { root: string; retentionDays: number | null };
  network: readonly NetworkRule[];
};
```

- Zod `.strict()` 拒绝未知字段。
- 调用参数只能覆盖明确允许的非安全敏感字段。
- 环境变量仅用于 Secret resolver，不作为普通隐式配置。
- 不自动合并多层配置，不支持远程配置或热重载。
- Run 开始后冻结 OCI digest、bundle ID、timeout、Evidence 和 network policy。
- 生效配置生成去敏 Artifact。路径在 Host 规范化且不进入 Agent/Guest。

## 32. ID 与时间

- RunId、ActionId、ObservationId、AssertionId 和 ArtifactId 使用独立 Zod brand，防止误用。
- 公共 ID 由 Kernel SecureIdGenerator 生成，使用 UUIDv7 或等价安全、时间可排序方案。
- ID 不包含用户信息、路径、Provider 名或 Secret。文件/目录只使用验证过的 ID。
- Adapter 不生成公共 ID；测试注入确定性 generator。
- Event recordedAt 使用 UTC ISO 8601；elapsed/timeout/duration 使用单调 Clock。
- sequence 是事件顺序唯一权威。系统时钟回拨不改变顺序。
- 恢复进程使用新的 recovery elapsed 基准，通过 sequence 延续总顺序。

## 33. Retention

- 默认保留 7 天，可配置；`null` 表示不自动清理。
- 活跃 Run 不参与清理。完成时间来自 Kernel 记录，不依赖文件 mtime。
- Evidence incomplete 和 cleanup failed 的 Run 使用相同 retention，避免无限保留敏感数据。
- 清理审计写入 Run 外部管理日志，因为 Run 目录会被删除。
- 删除失败记录后继续其他 Run。
- 不承诺 APFS/SSD 上的物理安全擦除；更高保证依赖加密卷和密钥销毁。
- 外部上传副本由外部存储 retention 管理。

## 34. CLI

```text
macos-computer-use doctor
macos-computer-use doctor --deep
macos-computer-use run <scenario-file>
macos-computer-use recover
macos-computer-use runs list
macos-computer-use runs show <run-id>
macos-computer-use evidence export <run-id> <destination>
```

- 默认 doctor 只读检查 Host、Apple Silicon、Tart、配置、目录、锁和缓存镜像元数据；不创建 VM、不启动 Appium、不触发权限提示。
- `doctor --deep` 明确创建一次性 Diagnostic Run，验证 Guest Agent、Appium、Mac2 session、基础 Observation 和 cleanup；不执行输入动作，不自动修复。
- run 通过 Public Client API，不能旁路 Kernel。
- recover 只收敛 Run/clone，不继续业务动作。
- runs 只读取 Host Evidence；export 先验证完整性，再导出相对路径包。
- 支持 human 和稳定 JSON 输出。
- v1 不提供交互 Agent、录制器、远程控制或任意 Mac2 入口。

CLI exit code 稳定摘要配置/调用错误、busy、recovery required、failed、inconclusive、evidence incomplete 和 cleanup failed。完整结果以 JSON/Manifest 为准；具体数字由后续 SPEC 固定。passed + incomplete 或 cleanup failed 不能返回成功码。

## 35. Fixture AUT

`fixtures/macos-test-app/` 是独立原生 macOS 工程，不属于主 TypeScript package：

- 稳定 Accessibility identifier。
- 按钮、文本框、复选框、可滚动列表和可拖动元素。
- 每个动作产生可确定验证的状态变化。
- 支持确定初始状态和重置。
- 不联网、不读取用户数据、不登录。
- 构建产物不提交；Golden Image 预装固定构建。
- 覆盖 click、double/right click、hover、scroll、swipe、drag、append/replace text、组合键和断言。
- Fixture 只证明 Mac2 契约链路，不代表任意第三方 AUT 兼容。

## 36. 测试与验证

### 36.1 Unit

覆盖状态机合法/非法转换、lease/generation、Snapshot/ElementRef 失效、ActionResult 分类、sequence、Artifact hash/原子提交、dispatch 区间崩溃、Manifest revision、timeout/cancel、cleanup 不覆盖 verdict、Zod 边界和脱敏。

### 36.2 Semantic Contract

所有 Fake 与真实 Adapter 运行中立 Port 契约，验证输入、输出、状态和错误语义。Fake 只证明 Kernel 行为，不能证明真实 Provider 合规。

### 36.3 Provider Conformance

真实 Adapter 验证 Tart/Mac2 映射、版本、timeout、取消、Receipt、诊断、Element-first 动作和不使用绝对坐标。

### 36.4 Destructive Lifecycle

在隔离的专用 macOS 环境验证 pull/clone/start/inspect/stop/destroy、故障 cleanup、Appium/Mac2 readiness、Fixture AUT 完整链路和 Evidence。CI 默认运行 semantic；Provider/destructive tests 在具备 Tart/Appium 环境的专用任务执行。

测试声明能力、环境和 timeout budget；条件不足时明确 skipped，不能伪装通过。真实测试不得修改共享 Golden Image。

### 36.5 验收主链路

从固定 OCI digest 创建 clone，等待 VM/Guest/Driver/AUT ready，捕获 canonical snapshot，使用 Compact Snapshot 定位，不足时查询 Structured Snapshot，执行 element-relative Action，捕获 after Observation，评估冻结断言，提交 Evidence/Manifest，关闭 Mac2/Appium 并删除 VM。

## 37. 版本兼容

兼容矩阵必须明确 Host macOS/Apple Silicon、Tart、Golden Image digest、Guest macOS、Xcode、Appium、Mac2、Node/pnpm 和 Fixture AUT build。Manifest 记录实际探测版本。

- composition root 对不兼容主版本 fail fast。
- 矩阵外环境标记 unsupported，不以“可能可用”作为通过。
- Provider conformance 测试验证矩阵。
- 版本升级需要新的 SPEC delta 和真实 conformance/destructive 验证。
- Golden Image digest 是 Guest 工具链的可重现身份。

## 38. 关键设计理由

- **正交结果而非单一状态**：避免把 Provider 事实、业务验证和重试策略混为一谈。
- **元素优先且无绝对坐标**：稳定性优先；无法元素化表达的能力宁可不支持。
- **双层 Snapshot**：模型先消费 Compact 视图降低 Token/延迟，按需查询同一 canonical snapshot 保持事实一致。
- **进程内 Gateway**：v1 避免 daemon 带来的认证、并发、升级和 socket 生命周期。
- **全局串行**：在语义稳定前避免并发 VM、Action 和 Evidence 的复合故障。
- **强制 Evidence**：write-ahead 和独立断言使崩溃、timeout 与 Provider 成功可被正确分类。
- **Level 2 单 package**：足以隔离业务语义和外部系统，不提前承担 monorepo 成本。
- **Zod 边界**：TypeScript 类型运行时消失，恢复记录和 Adapter 输入必须真实验证。

## 39. SDD 适用性与预期 SPEC

此设计属于完整的新项目行为和架构，后续实现必须显式调用 `/spec-driven`。仓库当前没有根 `SPEC.md`，因此实施前必须先建立并确认初始项目规格。

建议的 SPEC 所有权：

- 根 `SPEC.md`：项目范围、技术基线、模块表、依赖方向、部署拓扑、全局串行和跨模块不变量。
- `src/contracts/SPEC.md`：公共 Schema、ID、结果、错误、Action、Assertion、Scenario 和 Port 契约。
- `src/kernel/SPEC.md`：Run/环境状态、readiness、Action Transaction、retry/cancel、恢复和 orchestration。
- `src/adapters/SPEC.md`：Adapter ownership 和 Provider-neutral 边界导航。
- `src/adapters/tart/SPEC.md`：OCI Image、VM、Host-only 网络和受管资源。
- `src/adapters/guest/SPEC.md`：tart exec、Appium 进程和 Guest Artifact 导出。
- `src/adapters/mac2/SPEC.md`：session、canonical snapshot、双层视图、元素定位、相对动作、Receipt 和版本兼容。
- `src/adapters/evidence/SPEC.md`：timeline、Artifact Store、Manifest、目录、retention 和完整性。
- `src/client/SPEC.md`：Public Client API、composition root 和结构化生命周期。
- `src/cli/SPEC.md`：命令、输出和 exit categories。
- `fixtures/macos-test-app/SPEC.md`：Fixture 行为与 Accessibility contract。

模块是否需要合并应由 `/spec-driven` 在建立初始 SPEC 时依据实际目录和最小所有权原则决定；不得为了匹配此建议而制造空模块。

## 40. 已解决问题

讨论已明确：ActionResult/RunResult 正交模型、Confirmed 的独立断言边界、幂等与 retry、Evidence/cleanup 优先级、崩溃恢复、Hook、Secret、retention、Contract Test 分层、TypeScript 技术栈、Public Client、readiness、lease/generation、Receipt、Golden Image、AUT、Observation、Mac2 能力、元素相对位置、完全禁用绝对坐标、结构化 Query、断言、Guest 部署和网络、全局串行、状态目录、恢复、CLI、Scenario、Zod、持久化版本、ID/Clock、Manifest、Port、Fixture、兼容矩阵、TCC、安全边界以及 Compact/Structured 双层 Snapshot。

本文档没有遗留会导致两种不同 v1 架构实现的开放产品问题。具体超时数值、文件大小上限、兼容矩阵中的精确 Guest image digest 和稳定错误码数字属于后续 SPEC/配置中的可验证参数，不改变本文设计。
