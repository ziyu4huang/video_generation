# Browser Session Management

Run multiple isolated browser sessions concurrently with state persistence.

## Named Browser Sessions

Use `-s` flag to isolate browser contexts:

```bash
# Browser 1: Authentication flow
bunx playwright-cli -s=auth open https://app.example.com/login

# Browser 2: Public browsing (separate cookies, storage)
bunx playwright-cli -s=public open https://example.com

# Commands are isolated by browser session
bunx playwright-cli -s=auth fill e1 "user@example.com"
bunx playwright-cli -s=public snapshot
```

## Browser Session Isolation Properties

Each browser session has independent:
- Cookies
- LocalStorage / SessionStorage
- IndexedDB
- Cache
- Browsing history
- Open tabs

## Browser Session Commands

```bash
# List all browser sessions
bunx playwright-cli list

# Stop a browser session (close the browser)
bunx playwright-cli close                # stop the default browser
bunx playwright-cli -s=mysession close   # stop a named browser

# Stop all browser sessions
bunx playwright-cli close-all

# Forcefully kill all daemon processes (for stale/zombie processes)
bunx playwright-cli kill-all

# Delete browser session user data (profile directory)
bunx playwright-cli delete-data                # delete default browser data
bunx playwright-cli -s=mysession delete-data   # delete named browser data
```

## Environment Variable

Set a default browser session name via environment variable:

```bash
export PLAYWRIGHT_CLI_SESSION="mysession"
bunx playwright-cli open example.com  # Uses "mysession" automatically
```

## Common Patterns

### Concurrent Scraping

```bash
#!/bin/bash
# Scrape multiple sites concurrently

# Start all browsers
bunx playwright-cli -s=site1 open https://site1.com &
bunx playwright-cli -s=site2 open https://site2.com &
bunx playwright-cli -s=site3 open https://site3.com &
wait

# Take snapshots from each
bunx playwright-cli -s=site1 snapshot
bunx playwright-cli -s=site2 snapshot
bunx playwright-cli -s=site3 snapshot

# Cleanup
bunx playwright-cli close-all
```

### A/B Testing Sessions

```bash
# Test different user experiences
bunx playwright-cli -s=variant-a open "https://app.com?variant=a"
bunx playwright-cli -s=variant-b open "https://app.com?variant=b"

# Compare
bunx playwright-cli -s=variant-a screenshot
bunx playwright-cli -s=variant-b screenshot
```

### Persistent Profile

By default, browser profile is kept in memory only. Use `--persistent` flag on `open` to persist the browser profile to disk:

```bash
# Use persistent profile (auto-generated location)
bunx playwright-cli open https://example.com --persistent

# Use persistent profile with custom directory
bunx playwright-cli open https://example.com --profile=/path/to/profile
```

## Attaching to a Running Browser

Use `attach` to connect to a browser that is already running, instead of launching a new one.

### Attach by channel name

Connect to a running Chrome or Edge instance by its channel name. The browser must have remote debugging enabled — navigate to `chrome://inspect/#remote-debugging` in the target browser and check "Allow remote debugging for this browser instance".

```bash
# Attach to Chrome
bunx playwright-cli attach --cdp=chrome

# Attach to Chrome Canary
bunx playwright-cli attach --cdp=chrome-canary

# Attach to Microsoft Edge
bunx playwright-cli attach --cdp=msedge

# Attach to Edge Dev
bunx playwright-cli attach --cdp=msedge-dev
```

Supported channels: `chrome`, `chrome-beta`, `chrome-dev`, `chrome-canary`, `msedge`, `msedge-beta`, `msedge-dev`, `msedge-canary`.

When `--session` is not provided, the session is named after the channel (e.g. `--cdp=msedge` creates a session called `msedge`), so parallel attaches to Chrome and Edge don't collide on `default`. Pass `--session=<name>` to override.

### Attach via CDP endpoint

Connect to a browser that exposes a Chrome DevTools Protocol endpoint:

```bash
bunx playwright-cli attach --cdp=http://localhost:9222
```

### Attach via browser extension

Connect to a browser with the Playwright extension installed:

```bash
bunx playwright-cli attach --extension
```

### Detach

Tear down an attached session without affecting the external browser:

```bash
# Detach the default attached session
bunx playwright-cli detach

# Detach a specific attached session
bunx playwright-cli -s=msedge detach
```

`detach` only works on sessions created via `attach`. For sessions created via `open`, use `close`.

## Default Browser Session

When `-s` is omitted, commands use the default browser session:

```bash
# These use the same default browser session
bunx playwright-cli open https://example.com
bunx playwright-cli snapshot
bunx playwright-cli close  # Stops default browser
```

## Browser Session Configuration

Configure a browser session with specific settings when opening:

```bash
# Open with config file
bunx playwright-cli open https://example.com --config=.playwright/my-cli.json

# Open with specific browser
bunx playwright-cli open https://example.com --browser=firefox

# Open in headed mode
bunx playwright-cli open https://example.com --headed

# Open with persistent profile
bunx playwright-cli open https://example.com --persistent
```

## Best Practices

### 1. Name Browser Sessions Semantically

```bash
# GOOD: Clear purpose
bunx playwright-cli -s=github-auth open https://github.com
bunx playwright-cli -s=docs-scrape open https://docs.example.com

# AVOID: Generic names
bunx playwright-cli -s=s1 open https://github.com
```

### 2. Always Clean Up

```bash
# Stop browsers when done
bunx playwright-cli -s=auth close
bunx playwright-cli -s=scrape close

# Or stop all at once
bunx playwright-cli close-all

# If browsers become unresponsive or zombie processes remain
bunx playwright-cli kill-all
```

### 3. Delete Stale Browser Data

```bash
# Remove old browser data to free disk space
bunx playwright-cli -s=oldsession delete-data
```
