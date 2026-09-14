研究完成。以下為完整技術摘要（所有引文皆逐字取自 GitHub `earendil-works/pi@main` 原始碼，已於本機快取於 `/tmp/pi-src/`）。

---

# pi (earendil-works/pi) 擴充套件體系 — 研究摘要

**Repo 快照**（fetched 2026-09-14 前後，`main`）：`earendil-works/pi`（前身 `badlogic/pi-mono`），描述「AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI」。Monorepo 版本 `0.85.1`。套件布局**沒有** `packages/extensions/`；一等擴充功能分布在三處：

1. `packages/coding-agent/examples/extensions/` — **80+ 個官方範例擴充功能**（這是 pi 官方「first-party extensions」的事實 home，含完整 catalog 表格於 `examples/extensions/README.md`）
2. `packages/coding-agent/src/extensions/` — 內建擴充功能（目前僅 `llama/`，llama.cpp 本地模型支援）
3. repo 自用 dogfood：`.pi/extensions/{import-repro,prompt-url-widget,redraws,tps}.ts`

核心套件：`packages/agent`（`@earendil-works/pi-agent-core`，Agent loop + AgentHarness）、`packages/ai`（provider 統一 API）、`packages/tui`、`packages/coding-agent`（CLI + SDK + 擴充功能 runtime）、`packages/chord`（service RPC）、`packages/server`、`packages/session-backends`、`packages/client`、`packages/protocol`、`packages/telemetry`、`packages/evals`。

擴充功能 API 的權威定義：`packages/coding-agent/src/core/extensions/types.ts`（1797 行）；文件 `packages/coding-agent/docs/extensions.md`（3033 行）、`docs/sdk.md`、`docs/rpc.md`、`docs/json.md`。

---

## 1. 隨附擴充功能清單（examples/extensions/）

依官方 README 分類，每項標註**掛鉤的 API 面**（工具註冊 / 事件 / 指令 / UI / session 控制）：

### Lifecycle & Safety
| 擴充功能 | 作用 | 關鍵機制 |
|---|---|---|
| `permission-gate.ts` | 危險 bash 指令（rm -rf、sudo、chmod 777）前確認 | `pi.on("tool_call")` 回傳 `{block, reason}`；`ctx.hasUI` 為 false 時**預設擋掉**（無 UI 不能確認） |
| `project-trust.ts` | 演示 `project_trust` 事件 | `pi.on("project_trust")` handler 可回 `{trusted}` 決策 |
| `protected-paths.ts` | 封鎖 write/edit 到 `.env`、`.git/`、`node_modules/` | `tool_call` 事件 + `block` |
| `confirm-destructive.ts` | session 清除/切換/fork 前確認 | `session_before_switch` / `session_before_fork` 回 `{cancel: true}`；用 `ctx.sessionManager.getEntries()` 檢查未存工作 |
| `dirty-repo-guard.ts` | git 未乾淨時禁止 session 變更 | before_* session 事件 + git 檢查 |
| `sandbox/` | `@anthropic-ai/sandbox-runtime` OS 級沙箱，per-project `.pi/sandbox.json` | **重註冊 bash 工具**帶 `operations: createSandboxedBashOps()`（pluggable BashOperations），且 `pi.on("user_bash")` 回傳 `{operations}` 連 `!` 指令也沙箱化；`pi.getFlag("no-sandbox")` 自訂 CLI flag |
| `gondolin/` | 把 read/write/edit/bash/grep 全部路由進 Gondolin micro-VM | 逐工具 `pi.registerTool({...localRead, async execute(...) { const tool = createReadTool(GUEST_WORKSPACE, {operations: createGondolinReadOps(vm, localCwd)}); return tool.execute(...) }})` — 工廠重建 + operations 注入 |

### Custom Tools
- `todo.ts` — todo 工具 + `/todos` 指令；**狀態存 tool result details 而非外部檔案**，「branch 時 todo 狀態自動正確」；session 事件時從 leaf 往回掃 details 重建狀態。
- `hello.ts`、`question.ts`（`ctx.ui.custom()` 完全自繪元件）、`questionnaire.ts`。
- `tool-override.ts` — **同名註冊覆蓋內建工具**（audit read、擋 secrets 路徑），不提供 renderCall 時自動沿用內建 renderer。
- `dynamic-tools.ts` — `session_start` 之後/runtime 途中註冊工具；展示 `promptSnippet` + `promptGuidelines`（工具級 system prompt 注入）。
- `kimi-deferred-tools.ts` — 漸進式工具啟用協議。
- `structured-output.ts` — 工具結果回傳 `terminate: true`：**agent 在 tool call 上直接結束 turn，省掉後續 LLM turn**。
- `truncated-tool.ts`（包 ripgrep 截斷）、`built-in-tool-renderer.ts`、`minimal-mode.ts`、`ssh.ts`（`--ssh` 時 read/write/edit/bash 透過 `BashOperations/ReadOperations...` 介面遠端執行）、`tic-tac-toe.ts`（`executionMode: "sequential"` 防共享游點 race）。
- **`subagent/`** — 見 §2（主角）。

### Commands & UI
- `preset.ts`（`--preset` flag + `/preset`：model/thinking/tools/instructions 預設組）、`plan-mode/`（`pi.setActiveTools()` 切換唯讀工具集 + `tool_call` block 白名單 + `pi.appendEntry("plan-mode", {...})` 狀態持久化）、`tools.ts`（互動式開關工具、session 持久化）、`handoff.ts`（見 §2）、`qna.ts`、`status-line.ts`、`custom-footer/header.ts`（`ctx.ui.setFooter/setHeader` 工廠）、`github-issue-autocomplete.ts`（疊加 autocomplete provider）、`widget-placement.ts`（`setWidget` aboveEditor/belowEditor）、`snake.ts`/`space-invaders.ts`/`doom-overlay/`（自訂元件 + 鍵盤 + overlay 合成）、`send-user-message.ts`、`timed-confirm.ts`（AbortSignal 自動關閉對話框）、`rpc-demo.ts`、`modal-editor.ts`（`ctx.ui.setEditorComponent()` 換掉整個輸入編輯器）、`notify.ts`（`agent_settled` 時 OSC 777/99 通知）、`interactive-shell.ts`（`user_bash` hook 跑 vim/htop 全終端）、`inline-bash.ts`（`input` 事件 transform `!{cmd}` 展開）、`input-transform-streaming.ts`（`streamingBehavior` 分流）、`shutdown-command.ts`（`ctx.shutdown()`）、`reload-runtime.ts`（安全 `/reload`）、`summarize.ts`（`ctx.modelRegistry.complete()` 一次性 LLM 呼叫 + transient UI）。

### Git / System Prompt / Compaction / Resources / Messages / Session Metadata
- `git-checkpoint.ts`（每 `turn_start` 做 `git stash create`，`session_before_fork` 時提供還原；`agent_settled` 清 checkpoint）、`auto-commit-on-exit.ts`。
- `pirate.ts`（`systemPromptAppend`）、`claude-rules.ts`、`custom-compaction.ts`、`trigger-compact.ts`（`ctx.getContextUsage()` 門檻觸發 `ctx.compact()`）。
- `dynamic-resources/`（`resources_discover` 事件動態供給 skills/prompts/themes）。
- `message-renderer.ts` / `entry-renderer.ts`（`registerMessageRenderer` / `appendEntry`+`registerEntryRenderer`）、`event-bus.ts`（`pi.events` 跨擴充功能通訊）。
- `session-name.ts`（`pi.setSessionName`）、`bookmark.ts`（`pi.setLabel`）。
- 自訂 provider：`custom-provider-anthropic/`、`custom-provider-gitlab-duo/`（`pi.registerProvider()`）。

---

## 2. Agent 編排相關核心原始碼引文

### 2.1 `subagent/` — 官方子代理派遣擴充功能（最重要）

`packages/coding-agent/examples/extensions/subagent/index.ts`（1038 行）+ `agents.ts` + `README.md`。

**架構：每個子代理 = 一個 `pi` 子程序**，`--mode json -p --no-session`（一次性、JSON 事件流、不留 session 檔）：

```ts
// index.ts (runSingleAgent)
const args: string[] = ["--mode", "json", "-p", "--no-session"];
const inheritsDispatchConfig = !agent.model;
const model = agent.model ?? dispatchDefaults.model;
if (model) args.push("--model", model);
if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
    args.push("--thinking", dispatchDefaults.thinkingLevel);
}
if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
// 系統提示寫進 0o600 暫存檔，用 --append-system-prompt 傳入（避免 argv 長度/洩漏）
if (agent.systemPrompt.trim()) {
    const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
    args.push("--append-system-prompt", tmpPromptPath);
}
args.push(`Task: ${task}`);
```

**三種模式**：single（`{agent, task}`）、parallel（`tasks[]`，`MAX_PARALLEL_TASKS=8`、`MAX_CONCURRENCY=4`，用 worker-pool 式 `mapWithConcurrencyLimit`）、chain（`chain[]` 序列，`{previous}` 佔位符替換前步輸出；一步失敗即停並回 `isError: true`）。

**串流監控 = 解析子程序 stdout 的 JSON-lines 事件**（`message_end` / `tool_result_end`），即時聚合 usage：

```ts
const processLine = (line: string) => {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        currentResult.messages.push(msg);
        if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
                currentResult.usage.input += usage.input || 0;
                // ... cacheRead/cacheWrite/cost 累加
                currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
        }
        emitUpdate();   // -> onUpdate() 把 partial 結果推進父 session 的工具結果 UI
    }
    if (event.type === "tool_result_end" && event.message) { ... }
};
```

**Abort 傳播**（父 session 中斷 → SIGTERM 子程序，5 秒後 SIGKILL）：

```ts
if (signal) {
    const killProc = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
    };
    if (signal.aborted) killProc();
    else signal.addEventListener("abort", killProc, { once: true });
}
```

**工具執行 context 的用法**（`pi.registerTool` 的 `execute(_toolCallId, params, signal, onUpdate, ctx)`）— `dispatchDefaults` 從父 session 繼承 model/thinking：

```ts
const dispatchDefaults: DispatchDefaults = {
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    thinkingLevel: ctx.thinkingLevel,
};
```

**信任邊界（per-agent 安全閘）**：agents 定義於 `~/.pi/agent/agents/*.md`（user）或 `<cwd>/.pi/agents/*.md`（project，repo 可控 = prompt injection 面）。預設只載 user；要求 project agents 時，**未信任專案要過 `ctx.ui.confirm` 閘**：

```ts
if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents
    && ctx.hasUI && !ctx.isProjectTrusted()) {
    // ...收集被點名的 project agents
    const ok = await ctx.ui.confirm("Run project-local agents?",
        `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`);
    if (!ok) return { content: [{ type: "text", text: "Canceled: project-local agents not approved." }], ... };
}
```

**Agent 定義 = frontmatter + body**（`agents.ts`，`parseFrontmatter` 用真 YAML parser；`tools` 同時接受 `"read, bash"` 字串與 `[read, bash]` 陣列；單一壞檔不得炸掉整個目錄的 discovery；user 優先於 project 同名）：

```ts
agents.push({
    name: frontmatter.name, description: frontmatter.description,
    tools: parseToolList(frontmatter.tools),      // -> "--tools read,bash"
    model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
    systemPrompt: body,                            // -> --append-system-prompt
    source, filePath,
});
```

**輸出治理**：parallel 每任務輸出上限 `PER_TASK_OUTPUT_CAP = 50 * 1024` bytes，截斷後註明「full output preserved in tool details」；`details` 欄位（`SubagentDetails`）保存完整 messages/usage 供 UI 展開，`content` 只回最終 assistant 文字。失敗判定 `exitCode !== 0 || stopReason === "error" || stopReason === "aborted"`。自訂 `renderCall`/`renderResult`（含 collapse/expand、usage 行 `3 turns ↑12k ↓8k R40k W2k $0.1234 ctx:89k model`）。

### 2.2 `Agent` core — steer/followUp 佇列（父↔在跑代理的引導語意）

`packages/agent/src/agent.ts`（`@earendil-works/pi-agent-core`）。Agent 有**兩條獨立訊息佇列**，模式各可設 `"one-at-a-time" | ...`（`QueueMode`）：

```ts
/** Queue a message to be injected after the current assistant turn finishes. */
steer(message: AgentMessage): void { this.steeringQueue.enqueue(message); }

/** Queue a message to run only after the agent would otherwise stop. */
followUp(message: AgentMessage): void { this.followUpQueue.enqueue(message); }

clearSteeringQueue(): void; clearFollowUpQueue(): void;
hasPendingMessages(): boolean { return this.steeringQueue.hasItems() || this.followUpQueue.hasItems(); }
```

`prompt()` 在已有 activeRun 時**直接丟錯**：「Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.」

迴圈挂點（Agent 層，先於 coding-agent 的擴充功能事件）：`beforeToolCall` / `afterToolCall`（可 block/改結果）、`shouldStopAfterTurn`、`prepareNextTurn(WithContext)`、`transformContext`（每輪 LLM call 前改寫訊息）、`onPayload`/`onResponse`（provider 級）。工具執行 `toolExecution: ToolExecutionMode`（parallel/sequential）。

SDK 面向（`docs/sdk.md`）：`session.prompt(text, {streamingBehavior: "steer"|"followUp", images, expandPromptTemplates, preflightResult})`、`session.steer()`、`session.followUp()`；擴充功能面：`pi.sendUserMessage(content, {deliverAs: "steer"|"followUp", expandPromptTemplates})`、`pi.sendMessage(custom, {triggerTurn, deliverAs: "steer"|"followUp"|"nextTurn"})`（`send-user-message.ts` 範例即 `/steer` `/followup` 指令）。

### 2.3 `ExtensionContext` / `ExtensionCommandContext` — session 控制面

`packages/coding-agent/src/core/extensions/types.ts`：

```ts
export interface ExtensionContext {
    ui: ExtensionUIContext;              // select/confirm/input/editor/notify/custom + setStatus/setWidget/setFooter/setHeader/...
    mode: ExtensionMode;                 // "tui" | "rpc" | "json" | "print"
    hasUI: boolean;                      // TUI 與 RPC 模式為 true —— 無 UI 時確認閘必須降級為擋掉
    cwd: string;
    sessionManager: ReadonlySessionManager;   // 只讀視角；指令 context 才有切換/分叉權
    modelRegistry: ModelRegistry;        // 可直接 one-shot complete()
    model: Model<any> | undefined;  scopedModels: readonly ScopedModel[];  thinkingLevel?: ThinkingLevel;
    isIdle(): boolean;  isProjectTrusted(): boolean;
    signal: AbortSignal | undefined;  abort(): void;
    hasPendingMessages(): boolean;  shutdown(): void;
    getContextUsage(): ContextUsage | undefined;  compact(options?: CompactOptions): void;
    getSystemPrompt(): string;
}
```

指令 handler 拿到**更高權限**的 `ExtensionCommandContext`（「session control methods only safe in user-initiated commands」）— 這是 pi 的權限分層：事件 handler 不能換 session，指令可以：

```ts
newSession(options?: {
    parentSession?: string;                                  // 記錄父 session 檔（handoff 用）
    setup?: (sessionManager: SessionManager) => Promise<void>;
    withSession?: (ctx: ReplacedSessionContext) => Promise<void>;   // 換完後的新鮮 ctx（舊 ctx 已 stale！）
}): Promise<{ cancelled: boolean }>;
fork(entryId, options?: { position?: "before" | "at"; withSession? }): Promise<{ cancelled: boolean }>;
navigateTree(targetId, options?: { summarize?; customInstructions?; ... }): Promise<{ cancelled: boolean }>;
switchSession(sessionPath, options?: { withSession? }): Promise<{ cancelled: boolean }>;
waitForIdle(): Promise<void>;  reload(): Promise<void>;
```

### 2.4 `handoff.ts` — 上下文轉移到新 session（官方 compaction 替代品）

`/handoff <goal>`：取目前 branch（含最近 compaction summary + `firstKeptEntryId` 之後）→ `ctx.modelRegistry.complete()` 生成轉移 prompt → `ctx.ui.editor()` 讓使用者編輯 → `ctx.newSession({parentSession, withSession})`：

```ts
const newSessionResult = await ctx.newSession({
    parentSession: currentSessionFile,
    withSession: async (replacementCtx) => {
        replacementCtx.ui.setEditorText(editedPrompt);   // 新 session 編輯器預填草稿
        replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
    },
});
```

注意註解明言：「Use the replacement-session context for post-switch UI work; the original ctx is stale after a successful session replacement.」

### 2.5 實驗級：`SessionWorker` / `SessionWorkerManager` / `coordinator` / `mini`（背景多代理基礎設施）

`src/experimental/` — pi 正在把「多 session 多程序編排」做進核心：

- **`coordinator.ts`**：Unix socket 上的 JSON-line 訊息路由器（protocol v3）。訊息型別：`server_registered`（回 `serverConnectionId` + `peers`）、`server_replaced`、`peer_connected/disconnected`、`message {from, payload}`。`CoordinatorConnection` 提供 `send(peerId, payload)` / `broadcast(payload)` / `onEvent(listener)` — **peer-to-peer 不透明路由**：payload 對 coordinator 是 `Type.Unknown()`，端到端語意由參與者定義。
- **`process.ts` — 巢狀 pi 程序的正規產生器**：

```ts
export type InternalProcessRole = "coordinator" | "server" | "session-worker";
export function spawnInternalProcess(role, args, options): ChildProcess {
    // process.execPath + (Bun binary ? args : ["--import", source-resolver.ts, entryUrl, ...args])
    const child = spawn(process.execPath, ..., {
        cwd: process.cwd(), detached: true,
        env: { ...process.env, ...options.env, [INTERNAL_PROCESS_ENV]: role },
        stdio: "ignore", windowsHide: true,
    });
    child.unref();   // 父程序可先退
    return child;
}
// 角色用環境變數 __PI_INTERNAL_SPAWN 傳遞；consumeInternalProcessRole() 讀完即刪，避免後代繼承
```

- **`session-worker.ts` / `session-worker-manager.ts`**：每個 session 一個 worker 子程序（`WORKER_STARTUP_TIMEOUT_MS=15s` 等），worker 內建 `AgentHarness`（durable agent runtime，含 `BACKGROUND_CONTEXT`、`TODO_CONTEXT`、`JsonlSessionRepo`、proper-lockfile session 鎖）。Manager 追蹤 `WorkerRecord {peerId, metadata, pid, token, attachmentIds, expectedStop, ...}`，經 `chord` service-call RPC（`ServiceCall {serviceId, instance, member, args}`）做 `openSession/closeSession/#applyDemand/#attachClient`；控制面走 control socket + token 鑑權（`PI_SESSION_WORKER_CONTROL_ADDRESS/TOKEN/SESSION_KEY/PEER_ID` 環境變數交接）。
- **`mini/`**：三程序拓撲（多個 tui presentation ↔ server（detached，路由+事件扇出+spawn worker）↔ per-session worker），**多個 presentation 可同時 attach 同一 session，看到同一份 live transcript**；server 在最後一個 presentation 離開 10 秒後自我退休；worker 若持有 durable operation，重啟後自動從 recovery state 續跑。
- **`services/`**：`agent-controller`、`sessions`、`transcript`、`slash-commands`、`models` 等 chord 服務化切面 + `plugins/bundled.ts`（per-session plugin facet 載入，manifest 路徑隨 `SessionWorkerMetadata` 走，且有 `SessionPluginSelectionConflictError` 衝突偵測）。

---

## 3. 自建編排層可能漏掉的 pi 模式（差距清單）

1. **`tool_call` 可變 input + block + terminate**（types.ts）：handler 就地改 `event.input` 修補參數（後註冊的 handler 看得到先前的修改、不再 re-validate）；`{block, reason, terminate}` — `terminate` 在整批工具結果都設 true 時提前結束 run。多數自建層只有 block。
2. **`hasUI` 降級語意**：所有確認閘在 `hasUI === false`（`--mode json`/print）時的行為是**政策問題**——pi 官方範例選「block by default」。編排層的子代理往往無 UI，這條規則必須顯式存在。
3. **信任分層**：`project_trust` 事件 → `ctx.isProjectTrusted()`；**repo 內 `.pi/extensions/`、`.pi/agents/`、`.pi/prompts/`、context files 都是 injection 面**，載入前要過信任閘（subagent 對 project agents 的 confirm 即此模式的套用）。`docs/security.md` 另有完整論述。
4. **per-agent 工具/模型政策的三種實作位階**：(a) 子程序旗標 `--tools a,b --model X --thinking high`（subagent）；(b) session 內 `pi.setActiveTools()` 熱切換（plan-mode，附 `toolsBeforePlanMode` 保存/還原 + `appendEntry` 持久化）；(c) 工廠級替換 `createBashTool(cwd, {operations, spawnHook})`（sandbox/ssh/gondolin）——`operations` 介面讓工具執行後端完全可插拔（本地/SSH/VM），`spawnHook` 可改 command/cwd/env。
5. **狀態隨 session 樹走**：todo/plan-mode 把狀態塞進 **tool result `details` 或 `appendEntry` 自訂 entry**，而非外部檔案 → fork/branch 時狀態自動回到該歷史點的正確值。`appendEntry(customType, data)` 不進 LLM context，配 `registerEntryRenderer` 做 TUI 顯示。
6. **`agent_settled` vs `agent_end`**：`agent_end` 後 pi 可能還在 auto-retry/auto-compact/跑 follow-up 佇列；**只有 `agent_settled` 代表「完全落定」**（notify.ts 註解、extensions.md lifecycle 圖）。編排層等「子代理做完」必須用 settled 語意，不是 end。
7. **session 替換後 context 失效**：`newSession/fork/switchSession` 的後續工作必須在 `withSession(ReplacedSessionContext)` 裡做，舊 `ctx` 是 stale 的——官方在 docs 明列為 footgun。
8. **錯誤隔離**：`runner.ts` 對每個 extension 的每個事件 handler try/catch，錯誤收集成 `{extensionPath, event, error, stack}` 繼續跑其餘 handler —— 一個擴充功能壞掉不拖垮事件鏈。`registerProvider` 失敗也只是 emitError。
9. **跨擴充功能匯流排**：`pi.events`（EventBus）＋ `ui_prompt_start/end` 事件讓 UI 阻塞可觀測。
10. **RPC 模式 = 完整遠控協議**（`docs/rpc.md`，1618 行）：stdin JSON 命令（`prompt/steer/follow_up/abort/clear_queue/new_session{parentSession}/get_state/get_tree/clone/get_fork_messages/set_model/set_thinking_level/set_steering_mode/compact/...`）＋ stdout 事件流（含 `queue_update` 全量佇列快照、`extension_error`），**並把擴充功能的 UI 對話框（select/confirm/input/editor）也協議化**（stdout 請求 ↔ stdin 回應）。這是「驅動一個在跑的 pi」的官方答案，比 `--mode json` 單向流強得多。
11. **成本/用量逐代理聚合**：subagent 逐 `message_end` 累加 input/output/cacheRead/cacheWrite/cost/ctx tokens/turns 進 `details`——父代理可見的每子代理帳本。
12. **輸出上限與 details 分層**：給 LLM 的 `content` 截斷（50KB/任務），完整資料留 `details`（UI expand 用）——context 經濟學的官方示範。

---

## 4. pi 如何建模「巢狀 pi 實例」

四個正規途徑（由輕到重）：

1. **子程序 + JSON 事件流**（subagent 模式）：`pi --mode json -p --no-session [--model] [--thinking] [--tools] [--append-system-prompt <file>] "Task: ..."`。stdout 逐行 `JsonAgentSessionEvent`（`docs/json.md`：`message_update` 去掉 cumulative snapshot，`queue_update` 全量佇列，`compaction_start/end`；型別源頭 `packages/agent/src/types.ts` 的 `AgentEvent`）。Abort 用 SIGTERM→SIGKILL 階梯。`getPiInvocation()` 處理「重入自己的可執行檔」：`process.argv[1]` 非 Bun virtual script 時 `[execPath, script, ...args]`，否則 fallback `pi`。
2. **SDK 同程序 session**（`docs/sdk.md`）：`createAgentSession({sessionManager: SessionManager.inMemory(), tools: [...], excludeTools, noTools: "all"|"builtin", customTools, model, thinkingLevel, cwd})` → `session.prompt()/steer()/followUp()/subscribe()`；`SessionManager` 四種來源：`create/open/continueRecent/inMemory(cwd, options, entries?)`（還有 `static forkFrom(...)`、`newSession()`、`getTree()/branch()/branchWithSummary()/createBranchedSession()`——session 是**樹**不是列表）。`createAgentSessionRuntime()` 處理 new/resume/fork/import 的**活動 session 替換**，模式是「替換後把所有訂閱重新綁到 `runtime.session`」（`examples/sdk/13-session-runtime.ts` 的 `bindSession()`）。
3. **`AgentHarness` + chord worker**（實驗）：durable harness（checkpoint/recovery/restore、lane、`session/commit.ts`）跑在 per-session worker 子程序裡，由 `SessionWorkerManager` 生命週期管理、coordinator 做 peer 路由——多程序、多 presentation、detach 存活。
4. **RPC 模式**：`pi --mode rpc`，雙向 stdin/stdout JSONL——適合「父代理長期持有並 steer 一個子 pi」的場景（對應自建 subagent 工具的 `steer`/`wait`/`stop` 面）。

另外 `pi.exec(command, args, options)` 是擴充功能跑 shell 的官方通道（git-checkpoint 用它）；`--append-system-prompt` 接受**檔案路徑**（subagent 的 0o600 暫存檔手法）是傳遞大段子代理系統提示的慣例。

---

**給維護者的最短行動清單**（對照自建 subagent 編排層）：補 `hasUI=false` 的預設拒絕政策；把 block 閘升級為 `{block, reason, terminate}` 語意；子代理帳本逐 message 聚合 usage 進 details；輸出 50KB 截斷 + details 保全；abort 走 SIGTERM→SIGKILL；agent-finished 判準用 settled；project-local agent/prompt 定義要過 trust 閘；狀態放 session entry 而非外部檔案以支援 fork；若要 steer 在跑的子代理，改用 RPC 模式而非 JSON 單向流。

（原始檔快取：`/tmp/pi-src/`，檔名為路徑底線串接，例如 `packages_coding-agent_examples_extensions_subagent_index.ts`。）
