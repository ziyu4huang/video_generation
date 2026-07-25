## Task 4: Register the tool + full build/test gate

**Files:**
- Modify: `bun-apps/pi-agent-ext-power-tool/src/index.ts` (2 lines)

**Interfaces:**
- Consumes: `makeInspectHooksTool` (Task 3). The factory already calls `ensureGetSystemPromptOptions()` at line 1212 (installs the getHooks polyfill).

- [ ] **Step 1: Add the import + registration**

In `src/index.ts`:

- In the import group near the other local imports (after the `import { ensureGetSystemPromptOptions } from "./sdk-patch.js";` line, ~line 39), add:

```ts
import { makeInspectHooksTool } from "./tools/inspect-hooks.js";
```

- In the factory, next to the other `pi.registerTool(...)` calls (after line 1219 `pi.registerTool(makeInspectExtensionsTool(getAllTools));`), add:

```ts
  pi.registerTool(makeInspectHooksTool());
```

- [ ] **Step 2: Run the FULL test suite**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test )
```
Expected: PASS — all pre-existing tests + the new inspect-hooks/sdk-patch tests green. (Previously 119 tests; now +N for the new files.)

- [ ] **Step 3: Type-check / build**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun run build 2>/dev/null && echo BUILD_OK || (bunx tsc --noEmit && echo TYPECHECK_OK) )
```
Expected: `BUILD_OK` (or `TYPECHECK_OK`) with no errors. If `bun run build` does not exist, the `tsc --noEmit` fallback must pass.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/index.ts
git commit -m "feat(power-tool): register inspect_hooks tool in the factory"
```

---

