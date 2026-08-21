import { test } from "bun:test";
import assert from "node:assert/strict";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

test("withFakeHomeAsync serializes concurrent callers (no overlapping HOME windows)", async () => {
  let active = 0;
  let maxActive = 0;
  const overlapped = { value: false };
  const makeCall = (home: string) =>
    withFakeHomeAsync(home, async () => {
      active += 1;
      if (active > 1) overlapped.value = true;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
    });
  await Promise.all([makeCall("/tmp/fh-1"), makeCall("/tmp/fh-2"), makeCall("/tmp/fh-3")]);
  assert.equal(overlapped.value, false, "HOME critical sections must not overlap across concurrent callers");
  assert.equal(maxActive, 1, `expected max 1 concurrent HOME window, got ${maxActive}`);
});

test("withFakeHomeAsync still restores the original HOME after a serialized run", async () => {
  const original = process.env.HOME;
  await withFakeHomeAsync("/tmp/fh-restore", async () => {
    assert.equal(process.env.HOME, "/tmp/fh-restore");
  });
  assert.equal(process.env.HOME, original, "HOME restored after the call");
});
