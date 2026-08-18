# webui-audit-errdx — failure-path diagnostics for the audit tool

status: done

## Why

The audit's connectFailureReport had ONE failure story ("start the webui") for three distinct causes: webui unreachable (right hint), Chrome MISSING (install hint needed), Chrome launch FAILURE (Chrome exists but cannot start — policy block, broken install, playwright-core/Chrome mismatch). A launch failure waited the full NAV_TIMEOUT and then gave the wrong advice.

## What (PR #1607)

- connectFailureReport classifies: launchFailure (message regex), chromeMissing (!chromeLikelyAvailable()), else unreachable. Each cause carries its own fix hint; the cause name is in the header line. Exported for unit tests.

## Verification

power-tool suite green; unit tests pin the classifications.
