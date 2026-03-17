# SecureStepClaw

英文版文档：[`README.md`](./README.md)

`SecureStepClaw` 是基于 [`docs/`](./docs) 中设计文档实现的一个本地 `step-rollback` 插件原型。它已经包含了回退引擎、存储结构、插件清单以及测试代码，对应项目文档里定义的 Phase 1 和 Phase 2 API 形态。

## 当前状态

这个仓库已经非常接近一个可用的 OpenClaw Native Plugin，但它目前还不是一个可以直接放进 OpenClaw Gateway 就立即生效的完整插件。

目前已经具备的内容：

- 插件清单文件：[`openclaw.plugin.json`](./openclaw.plugin.json)
- 回退引擎和 API 实现：[`dist/plugin.js`](./dist/plugin.js)
- 对外导出入口：[`dist/index.js`](./dist/index.js)
- 本地测试：[`tests/plugin.test.js`](./tests/plugin.test.js)

距离真正接入 OpenClaw 还缺少的部分：

- 一个符合 OpenClaw Native Plugin 规范的运行时适配层，并导出 `register(api)`
- 将 OpenClaw 的 hook 事件接到这个回退引擎上，例如：
  - `before_tool_call`
  - `after_tool_call`
  - `session_start`
  - `session_end`
- 一个真正连接 OpenClaw 运行时的 host bridge，用来完成：
  - rollback 前停止当前 run
  - 从回退点继续执行
  - checkout 时创建新 session

因此，这个仓库目前最准确的定位是：

- 一个已经可测试的 rollback 引擎
- 一个与 `docs/` 中 API 设计保持一致的参考实现
- 一个后续可以包进 OpenClaw SDK 适配层的核心实现

所以它还不应该被描述成“现在就可以直接安装到 OpenClaw 里并投入生产使用”的完整插件。

## 已实现内容

### Phase 1

- 每次 tool 调用前自动创建 checkpoint
- checkpoint 注册与查询
- 工作区 snapshot 恢复
- rollback 状态跟踪
- 支持带可选 prompt 的 continue
- rollback 报告记录

### Phase 2 脚手架

- session 节点列表
- checkout 元数据与 branch record
- 新 session 的运行态初始化

## 仓库结构

- [`docs/`](./docs)：PRD、架构设计、API 设计
- [`openclaw.plugin.json`](./openclaw.plugin.json)：插件 manifest 与配置 schema
- [`package.json`](./package.json)：包信息与测试脚本
- [`dist/index.js`](./dist/index.js)：公共导出入口
- [`dist/plugin.js`](./dist/plugin.js)：核心插件引擎
- [`dist/services/`](./dist/services)：checkpoint、registry、runtime、lock、report 等服务
- [`tests/plugin.test.js`](./tests/plugin.test.js)：Node 测试套件

## 前置条件

在使用或集成这个项目之前，请先确认：

1. 已安装 Node.js 24 或更高版本
2. 已安装并启用 Gateway 模式的 OpenClaw
3. 你可以访问真正运行 OpenClaw Gateway 的那台机器

同时需要注意以下 OpenClaw 运行特点：

- Native Plugin 是在 Gateway 进程内运行的
- 插件配置位于 `plugins.entries.<id>.config`
- 修改插件配置后通常需要重启 Gateway
- 本地开发时，可以通过目录安装或软链接安装插件，例如 `openclaw plugins install -l <path>`

## 本地开发使用流程

这是当前仓库在“还没有 OpenClaw 原生适配层”情况下，今天就能使用的方式。

### 1. 进入项目目录

```bash
cd /Users/bin-mac/CodeX/SecureStepClaw
```

### 2. 运行测试

```bash
npm test
```

预期结果：全部测试通过。

### 3. 在代码中创建 rollback 引擎实例

当前入口是一个 JavaScript API，并不是 OpenClaw 的 `register(api)` 运行时入口。

```js
import crypto from "node:crypto";
import { createStepRollbackPlugin } from "./dist/index.js";

const plugin = createStepRollbackPlugin({
  config: {
    workspaceRoots: ["/absolute/path/to/workspace"],
    checkpointDir: "/absolute/path/to/plugin-data/checkpoints",
    registryDir: "/absolute/path/to/plugin-data/registry",
    runtimeDir: "/absolute/path/to/plugin-data/runtime",
    reportsDir: "/absolute/path/to/plugin-data/reports"
  },
  host: {
    async stopRun({ agentId, sessionId, runId }) {
      return { stopped: true, agentId, sessionId, runId };
    },
    async startContinueRun({ agentId, sessionId, entryId, prompt }) {
      return { runId: `run:${agentId}:${sessionId}:${entryId}:${prompt ?? ""}` };
    },
    async createSession() {
      return { sessionId: crypto.randomUUID() };
    }
  }
});
```

### 4. 把 session 和 tool 生命周期事件喂给插件

```js
await plugin.hooks.sessionStart({
  agentId: "main",
  sessionId: "session-1",
  runId: "run-1"
});

await plugin.hooks.beforeToolCall({
  agentId: "main",
  sessionId: "session-1",
  entryId: "entry-1",
  nodeIndex: 1,
  toolName: "write",
  runId: "run-1"
});

await plugin.hooks.afterToolCall({
  agentId: "main",
  sessionId: "session-1",
  entryId: "entry-1",
  nodeIndex: 1,
  toolName: "write",
  runId: "run-1",
  success: true
});
```

### 5. 调用 rollback API

```js
const list = await plugin.methods["steprollback.checkpoints.list"]({
  agentId: "main",
  sessionId: "session-1"
});

const rollback = await plugin.methods["steprollback.rollback"]({
  agentId: "main",
  sessionId: "session-1",
  checkpointId: list.checkpoints[0].checkpointId
});

const resumed = await plugin.methods["steprollback.continue"]({
  agentId: "main",
  sessionId: "session-1",
  prompt: "Continue from here, but do not rewrite the config file yet."
});
```

## 配置说明

[`openclaw.plugin.json`](./openclaw.plugin.json) 中定义的配置项包括：

- `enabled`
- `workspaceRoots`
- `checkpointDir`
- `registryDir`
- `runtimeDir`
- `reportsDir`
- `maxCheckpointsPerSession`
- `allowContinuePrompt`
- `stopRunBeforeRollback`

示例配置如下：

```json
{
  "enabled": true,
  "workspaceRoots": [
    "/Users/you/.openclaw/workspace"
  ],
  "checkpointDir": "/Users/you/.openclaw/plugins/step-rollback/checkpoints",
  "registryDir": "/Users/you/.openclaw/plugins/step-rollback/registry",
  "runtimeDir": "/Users/you/.openclaw/plugins/step-rollback/runtime",
  "reportsDir": "/Users/you/.openclaw/plugins/step-rollback/reports",
  "maxCheckpointsPerSession": 100,
  "allowContinuePrompt": true,
  "stopRunBeforeRollback": true
}
```

## 如何把它安装到 OpenClaw

这一部分分成两个层次：

1. 当前这个仓库今天能做什么
2. 等补上 OpenClaw 原生适配层之后，真正的安装步骤会是什么样

### 当前阶段：先本地验证引擎

1. 把这个仓库放在运行 OpenClaw Gateway 的同一台机器上。
2. 在项目目录执行 `npm test`。
3. 规划好插件状态目录存放位置。
4. 明确你的 OpenClaw workspace 路径，因为这个插件恢复的就是这个工作区。
5. 如果你希望提前规范 OpenClaw 配置，也可以现在就先准备未来要使用的配置项。

建议的未来 OpenClaw 配置如下：

```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "step-rollback": {
        "enabled": true,
        "config": {
          "enabled": true,
          "workspaceRoots": [
            "/Users/you/.openclaw/workspace"
          ],
          "checkpointDir": "/Users/you/.openclaw/plugins/step-rollback/checkpoints",
          "registryDir": "/Users/you/.openclaw/plugins/step-rollback/registry",
          "runtimeDir": "/Users/you/.openclaw/plugins/step-rollback/runtime",
          "reportsDir": "/Users/you/.openclaw/plugins/step-rollback/reports",
          "maxCheckpointsPerSession": 100,
          "allowContinuePrompt": true,
          "stopRunBeforeRollback": true
        }
      }
    }
  }
}
```

### 补上 OpenClaw 原生适配层之后

当这个仓库真正导出 OpenClaw 规范的 `register(api)` 入口后，安装步骤就可以按下面的方式执行。

#### 方式 A：开发阶段用软链接安装

```bash
openclaw plugins install -l /Users/bin-mac/CodeX/SecureStepClaw
```

适合在开发过程中直接让 OpenClaw 加载当前工作目录，而不是复制一份文件。

#### 方式 B：本地复制安装

```bash
openclaw plugins install /Users/bin-mac/CodeX/SecureStepClaw
```

适合把插件复制到 OpenClaw 管理的插件目录中。

#### 验证插件是否安装成功

```bash
openclaw plugins list
openclaw plugins info step-rollback
openclaw plugins doctor
```

#### 配置插件

在 OpenClaw 配置文件中启用 `step-rollback`，并填写明确的目录路径：

```json
{
  "plugins": {
    "enabled": true,
    "entries": {
      "step-rollback": {
        "enabled": true,
        "config": {
          "enabled": true,
          "workspaceRoots": [
            "/Users/you/.openclaw/workspace"
          ],
          "checkpointDir": "/Users/you/.openclaw/plugins/step-rollback/checkpoints",
          "registryDir": "/Users/you/.openclaw/plugins/step-rollback/registry",
          "runtimeDir": "/Users/you/.openclaw/plugins/step-rollback/runtime",
          "reportsDir": "/Users/you/.openclaw/plugins/step-rollback/reports",
          "maxCheckpointsPerSession": 100,
          "allowContinuePrompt": true,
          "stopRunBeforeRollback": true
        }
      }
    }
  }
}
```

#### 重启 Gateway

如果你以服务方式运行 Gateway：

```bash
openclaw gateway restart
```

如果你在前台手动运行 Gateway：

```bash
openclaw gateway run
```

#### 验证 RPC 接口

等原生适配层补齐并且插件真正接入 Gateway 之后，下面这些命令应该可以工作：

```bash
openclaw gateway call steprollback.status
openclaw gateway call steprollback.checkpoints.list --params '{"agentId":"main","sessionId":"<session-id>"}'
openclaw gateway call steprollback.rollback.status --params '{"agentId":"main","sessionId":"<session-id>"}'
```

#### 在 OpenClaw 中使用 rollback 流程

1. 正常启动一个 OpenClaw 任务。
2. 让 agent 执行工具调用。
3. 查询当前 session 的 checkpoint 列表：

```bash
openclaw gateway call steprollback.checkpoints.list --params '{"agentId":"main","sessionId":"<session-id>"}'
```

4. 选中一个 checkpoint 并执行回退：

```bash
openclaw gateway call steprollback.rollback --params '{"agentId":"main","sessionId":"<session-id>","checkpointId":"<checkpoint-id>"}'
```

5. 确认 session 已进入等待 continue 状态：

```bash
openclaw gateway call steprollback.rollback.status --params '{"agentId":"main","sessionId":"<session-id>"}'
```

6. 从回退点继续执行。

不带 prompt：

```bash
openclaw gateway call steprollback.continue --params '{"agentId":"main","sessionId":"<session-id>"}'
```

带 prompt：

```bash
openclaw gateway call steprollback.continue --params '{"agentId":"main","sessionId":"<session-id>","prompt":"Continue from here, but inspect dependencies first."}'
```

#### 使用 checkout 流程

列出可 checkout 的 checkpoint 节点：

```bash
openclaw gateway call steprollback.session.nodes.list --params '{"agentId":"main","sessionId":"<session-id>"}'
```

基于某个节点创建新 session：

```bash
openclaw gateway call steprollback.session.checkout --params '{"agentId":"main","sourceSessionId":"<session-id>","sourceEntryId":"<entry-id>","continueAfterCheckout":true,"prompt":"Continue on a new branch from here."}'
```

查询 branch record：

```bash
openclaw gateway call steprollback.session.branch.get --params '{"branchId":"<branch-id>"}'
```

## 还需要补什么

要让上面“补上 OpenClaw 原生适配层之后”的说明真正变成可执行安装流程，下一步代码工作主要包括：

1. 在运行时入口导出原生 OpenClaw 插件对象或默认函数
2. 使用 `api.registerGatewayMethod(...)` 注册 `steprollback.*` 方法
3. 使用 `api.on(...)` 连接 OpenClaw 生命周期 hook
4. 把 OpenClaw 的真实运行时能力接到以下 bridge 上：
   - `stopRun`
   - `startContinueRun`
   - `createSession`

只要这个适配层完成，上面的安装与使用步骤就能成为真正可运行的生产流程。

## 验证方式

在仓库根目录运行：

```bash
npm test
```

当前测试覆盖了以下能力：

- checkpoint 创建
- rollback 与 continue
- checkpoint 数量裁剪
- checkout 分支元数据

## OpenClaw 官方参考

下面这些官方文档是本文安装和运行说明的参考依据：

- Plugins: https://docs.openclaw.ai/tools/plugin
- Plugin manifest: https://docs.openclaw.ai/plugins/manifest
- Plugin CLI: https://docs.openclaw.ai/cli/plugins
- Gateway CLI: https://docs.openclaw.ai/cli/gateway
- Agent loop and plugin lifecycle hooks: https://docs.openclaw.ai/agent-loop
