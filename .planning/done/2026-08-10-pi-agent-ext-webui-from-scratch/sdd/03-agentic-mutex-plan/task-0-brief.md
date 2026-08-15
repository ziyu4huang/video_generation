### Task 0: Scaffold the `pi-agent-ext-webui` package

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/package.json`
- Create: `bun-apps/pi-agent-ext-webui/tsconfig.json`
- Create: `bun-apps/pi-agent-ext-webui/src/index.ts`
- Create: `bun-apps/pi-agent-ext-webui/.gitignore`

**Interfaces:** none (scaffold).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@repo/pi-agent-ext-webui",
  "private": true,
  "version": "0.1.0",
  "description": "Pi extension: a web frontend co-driving one AgentSession with the TUI behind an agentic mutex. Scaffold (mutex module); full Bun.serve extension lands in tickets 02/04.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./src/*": "./src/*"
  },
  "scripts": {
    "build": "bunx tsc",
    "test:unit": "bun test",
    "test": "bun run build && bun run test:unit"
  },
  "license": "MIT",
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "typescript": "^7.0.2"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ESNext", "DOM"],
    "types": ["bun"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `src/index.ts` placeholder**

```typescript
/**
 * pi-agent-ext-webui — a web frontend that co-drives one AgentSession with the
 * TUI behind an agentic mutex (ticket 03). This scaffold hosts the mutex module
 * and its tests only; the Bun.serve extension + pi registration land in tickets
 * 02/04 and call into src/mutex-controller.ts.
 */
export {};
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules
dist
```

- [ ] **Step 5: Install + verify the toolchain runs**

Run:
```bash
( cd bun-apps && bun install )
( cd bun-apps/pi-agent-ext-webui && bun run build )
( cd bun-apps/pi-agent-ext-webui && bun test )
```
Expected: `bun install` registers the new workspace package; `bun run build` (`bunx tsc`) emits `dist/index.js` + `dist/index.d.ts` with no errors; `bun test` reports no tests found (fine — Task 1 adds them). If `tsc` cannot resolve `typescript`, align the `typescript` devDependency version to whatever `bun-apps/pi-agent-ext-wayfind/package.json` uses.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/package.json bun-apps/pi-agent-ext-webui/tsconfig.json bun-apps/pi-agent-ext-webui/src/index.ts bun-apps/pi-agent-ext-webui/.gitignore
git commit -m "feat(webui): scaffold pi-agent-ext-webui package (ticket 03 host)"
```

---

