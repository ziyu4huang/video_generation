---
name: playwright-cli
description: Use when automating browser interactions, driving web UIs for testing or scraping, or authoring and debugging Playwright tests via playwright-cli (run through bunx). Core power-tool capability — browser automation is a first-class power-tool domain (alongside the vendored playwright-core and the headless-Chrome webui tool), NOT a misplaced skill; do not propose relocating it (operator decision 2026-08-20).
allowed-tools: Bash(bunx:*)
---

# Browser Automation with playwright-cli

## Quick start

```bash
# open new browser
bunx playwright-cli open
# navigate to a page
bunx playwright-cli goto https://playwright.dev
# interact with the page using refs from the snapshot
bunx playwright-cli click e15
bunx playwright-cli type "page.click"
bunx playwright-cli press Enter
# take a screenshot (rarely used, as snapshot is more common)
bunx playwright-cli screenshot
# close the browser
bunx playwright-cli close
```

## Commands

### Core

```bash
bunx playwright-cli open
# open and navigate right away
bunx playwright-cli open https://example.com/
bunx playwright-cli goto https://playwright.dev
bunx playwright-cli type "search query"
bunx playwright-cli click e3
bunx playwright-cli dblclick e7
# --submit presses Enter after filling the element
bunx playwright-cli fill e5 "user@example.com"  --submit
bunx playwright-cli drag e2 e8
# drop files or data onto an element (from outside the page)
bunx playwright-cli drop e4 --path=./image.png
bunx playwright-cli drop e4 --data="text/plain=hello world"
bunx playwright-cli hover e4
bunx playwright-cli select e9 "option-value"
bunx playwright-cli upload ./document.pdf
bunx playwright-cli check e12
bunx playwright-cli uncheck e12
bunx playwright-cli snapshot
bunx playwright-cli eval "document.title"
bunx playwright-cli eval "el => el.textContent" e5
# get element id, class, or any attribute not visible in the snapshot
bunx playwright-cli eval "el => el.id" e5
bunx playwright-cli eval "el => el.getAttribute('data-testid')" e5
bunx playwright-cli dialog-accept
bunx playwright-cli dialog-accept "confirmation text"
bunx playwright-cli dialog-dismiss
bunx playwright-cli resize 1920 1080
bunx playwright-cli close
```

### Navigation

```bash
bunx playwright-cli go-back
bunx playwright-cli go-forward
bunx playwright-cli reload
```

### Keyboard

```bash
bunx playwright-cli press Enter
bunx playwright-cli press ArrowDown
bunx playwright-cli keydown Shift
bunx playwright-cli keyup Shift
```

### Mouse

```bash
bunx playwright-cli mousemove 150 300
bunx playwright-cli mousedown
bunx playwright-cli mousedown right
bunx playwright-cli mouseup
bunx playwright-cli mouseup right
bunx playwright-cli mousewheel 0 100
```

### Save as

```bash
bunx playwright-cli screenshot
bunx playwright-cli screenshot e5
bunx playwright-cli screenshot --filename=page.png
bunx playwright-cli pdf --filename=page.pdf
```

### Tabs

```bash
bunx playwright-cli tab-list
bunx playwright-cli tab-new
bunx playwright-cli tab-new https://example.com/page
bunx playwright-cli tab-close
bunx playwright-cli tab-close 2
bunx playwright-cli tab-select 0
```

### Storage

```bash
bunx playwright-cli state-save
bunx playwright-cli state-save auth.json
bunx playwright-cli state-load auth.json

# Cookies
bunx playwright-cli cookie-list
bunx playwright-cli cookie-list --domain=example.com
bunx playwright-cli cookie-get session_id
bunx playwright-cli cookie-set session_id abc123
bunx playwright-cli cookie-set session_id abc123 --domain=example.com --httpOnly --secure
bunx playwright-cli cookie-delete session_id
bunx playwright-cli cookie-clear

# LocalStorage
bunx playwright-cli localstorage-list
bunx playwright-cli localstorage-get theme
bunx playwright-cli localstorage-set theme dark
bunx playwright-cli localstorage-delete theme
bunx playwright-cli localstorage-clear

# SessionStorage
bunx playwright-cli sessionstorage-list
bunx playwright-cli sessionstorage-get step
bunx playwright-cli sessionstorage-set step 3
bunx playwright-cli sessionstorage-delete step
bunx playwright-cli sessionstorage-clear
```

### Network

```bash
bunx playwright-cli route "**/*.jpg" --status=404
bunx playwright-cli route "https://api.example.com/**" --body='{"mock": true}'
bunx playwright-cli route-list
bunx playwright-cli unroute "**/*.jpg"
bunx playwright-cli unroute
```

### DevTools

```bash
bunx playwright-cli console
bunx playwright-cli console warning
bunx playwright-cli requests
bunx playwright-cli request 5
bunx playwright-cli run-code "async page => await page.context().grantPermissions(['geolocation'])"
bunx playwright-cli run-code --filename=script.js
bunx playwright-cli tracing-start
bunx playwright-cli tracing-stop
bunx playwright-cli video-start video.webm
bunx playwright-cli video-chapter "Chapter Title" --description="Details" --duration=2000
bunx playwright-cli video-stop

# launch the dashboard with annotation prompt to ask the user for input
bunx playwright-cli show --annotate

# generate a Playwright locator for an element from its ref or selector
bunx playwright-cli generate-locator e5 --raw

# show a persistent highlight overlay for an element, optionally with a custom style
bunx playwright-cli highlight e5
bunx playwright-cli highlight e5 --style="outline: 3px dashed red"
# hide a single element highlight, or all page highlights when no target is given
bunx playwright-cli highlight e5 --hide
bunx playwright-cli highlight --hide
```

## Raw output

The global `--raw` option strips page status, generated code, and snapshot sections from the output, returning only the result value. Use it to pipe command output into other tools. Commands that don't produce output return nothing.

```bash
bunx playwright-cli --raw eval "JSON.stringify(performance.timing)" | jq '.loadEventEnd - .navigationStart'
bunx playwright-cli --raw eval "JSON.stringify([...document.querySelectorAll('a')].map(a => a.href))" > links.json
bunx playwright-cli --raw snapshot > before.yml
bunx playwright-cli click e5
bunx playwright-cli --raw snapshot > after.yml
diff before.yml after.yml
TOKEN=$(bunx playwright-cli --raw cookie-get session_id)
bunx playwright-cli --raw localstorage-get theme
```

For structured output wrapping every reply as JSON, pass --json
```bash
bunx playwright-cli list --json
```

## Open parameters
```bash
# Use specific browser when creating session
bunx playwright-cli open --browser=chrome
bunx playwright-cli open --browser=firefox
bunx playwright-cli open --browser=webkit
bunx playwright-cli open --browser=msedge

# Use persistent profile (by default profile is in-memory)
bunx playwright-cli open --persistent
# Use persistent profile with custom directory
bunx playwright-cli open --profile=/path/to/profile

# Connect to browser via Playwright Extension
bunx playwright-cli attach --extension=chrome

# Connect to a running Chrome or Edge by channel name
bunx playwright-cli attach --cdp=chrome
bunx playwright-cli attach --cdp=msedge

# Connect to a running browser via CDP endpoint
bunx playwright-cli attach --cdp=http://localhost:9222

# Start with config file
bunx playwright-cli open --config=my-config.json

# Close the browser
bunx playwright-cli close
# Detach from an attached browser (leaves the external browser running)
bunx playwright-cli -s=msedge detach
# Delete user data for the default session
bunx playwright-cli delete-data
```

## Snapshots

After each command, bunx playwright-cli provides a snapshot of the current browser state.

```bash
> bunx playwright-cli goto https://example.com
### Page
- Page URL: https://example.com/
- Page Title: Example Domain
### Snapshot
[Snapshot](.playwright-cli/page-2026-02-14T19-22-42-679Z.yml)
```

You can also take a snapshot on demand using `bunx playwright-cli snapshot` command. All the options below can be combined as needed.

```bash
# default - save to a file with timestamp-based name
bunx playwright-cli snapshot

# save to file, use when snapshot is a part of the workflow result
bunx playwright-cli snapshot --filename=after-click.yaml

# snapshot an element instead of the whole page
bunx playwright-cli snapshot "#main"

# limit snapshot depth for efficiency, take a partial snapshot afterwards
bunx playwright-cli snapshot --depth=4
bunx playwright-cli snapshot e34

# include each element's bounding box as [box=x,y,width,height]
bunx playwright-cli snapshot --boxes
```

## Targeting elements

By default, use refs from the snapshot to interact with page elements.

```bash
# get snapshot with refs
bunx playwright-cli snapshot

# interact using a ref
bunx playwright-cli click e15
```

You can also use css selectors or Playwright locators.

```bash
# css selector
bunx playwright-cli click "#main > button.submit"

# role locator
bunx playwright-cli click "getByRole('button', { name: 'Submit' })"

# test id
bunx playwright-cli click "getByTestId('submit-button')"
```

## Browser Sessions

```bash
# create new browser session named "mysession" with persistent profile
bunx playwright-cli -s=mysession open example.com --persistent
# same with manually specified profile directory (use when requested explicitly)
bunx playwright-cli -s=mysession open example.com --profile=/path/to/profile
bunx playwright-cli -s=mysession click e6
bunx playwright-cli -s=mysession close  # stop a named browser
bunx playwright-cli -s=mysession delete-data  # delete user data for persistent session

bunx playwright-cli list
# Close all browsers
bunx playwright-cli close-all
# Forcefully kill all browser processes
bunx playwright-cli kill-all
```

## Prerequisite

The `playwright-cli` engine is provided by this extension's **`@playwright/cli`**
dependency (pinned in `bun.lock`) — there is **no global install and no
`npx`/`npm`**. Run every command through bun's package runner, which resolves
the pinned workspace dep:

```bash
bunx playwright-cli --version
```

Verify the skill resolves the pinned dep on this machine (hermetic — no browser
launch):

```bash
bash skills/playwright-cli/scripts/smoke.sh
```

First-time setup inside a *target project* (the app under test, not this
extension) — initialize the Playwright workspace and install browsers:

```bash
bunx playwright-cli install            # initialize workspace
bunx playwright-cli install-browser    # install browsers
```

> **Naming-collision warning:** the npm package literally named `playwright-cli`
> (v0.262.0) is an **unrelated** tool. Never `npm install -g playwright-cli` or
> `npx playwright-cli`. This extension pins the correct one — `@playwright/cli` —
> and `bunx playwright-cli` resolves it deterministically.

## Example: Form submission

```bash
bunx playwright-cli open https://example.com/form
bunx playwright-cli snapshot

bunx playwright-cli fill e1 "user@example.com"
bunx playwright-cli fill e2 "password123"
bunx playwright-cli click e3
bunx playwright-cli snapshot
bunx playwright-cli close
```

## Example: Multi-tab workflow

```bash
bunx playwright-cli open https://example.com
bunx playwright-cli tab-new https://example.com/other
bunx playwright-cli tab-list
bunx playwright-cli tab-select 0
bunx playwright-cli snapshot
bunx playwright-cli close
```

## Example: Debugging with DevTools

```bash
bunx playwright-cli open https://example.com
bunx playwright-cli click e4
bunx playwright-cli fill e7 "test"
bunx playwright-cli console
bunx playwright-cli requests
bunx playwright-cli close
```

```bash
bunx playwright-cli open https://example.com
bunx playwright-cli tracing-start
bunx playwright-cli click e4
bunx playwright-cli fill e7 "test"
bunx playwright-cli tracing-stop
bunx playwright-cli close
```

## Example: Interactive session

Ask the user to annotate the UI. User can provide contextual tasks or ask contextual questions using annotations:

```bash
bunx playwright-cli open https://example.com
bunx playwright-cli show --annotate
```

## Specific tasks

* **Running and Debugging Playwright tests** [references/playwright-tests.md](references/playwright-tests.md)
* **Request mocking** [references/request-mocking.md](references/request-mocking.md)
* **Running Playwright code** [references/running-code.md](references/running-code.md)
* **Browser session management** [references/session-management.md](references/session-management.md)
* **Spec-driven testing (plan / generate / heal)** [references/spec-driven-testing.md](references/spec-driven-testing.md)
* **Storage state (cookies, localStorage)** [references/storage-state.md](references/storage-state.md)
* **Test generation** [references/test-generation.md](references/test-generation.md)
* **Tracing** [references/tracing.md](references/tracing.md)
* **Video recording** [references/video-recording.md](references/video-recording.md)
* **Inspecting element attributes** [references/element-attributes.md](references/element-attributes.md)
