import { it, expect } from "bun:test";
import { SurrealBackend } from "../../../src/store/surreal/surreal-backend.js";
import { isSurrealUp, localDescribe, uniqueNs } from "./_helpers.js";

const up = await isSurrealUp();

localDescribe("SurrealBackend", up, () => {
  it("init() bootstraps schema and is idempotent; healthCheck passes", async () => {
    const ns = uniqueNs();
    const backend = new SurrealBackend({ namespace: ns, database: ns });
    try {
      await backend.init();            // defines ns/db, analyzer, indexes, tables, seq
      await backend.init();            // idempotent re-run must not throw
      await backend.healthCheck();     // RETURN 1 — does not throw

      // Counter bootstrapped to 0, incrementable to 1.
      const next = await backend.client.query<number>(
        `(UPDATE seq:memory SET value += 1 RETURN VALUE value)[0]`,
      );
      expect(next).toBe(1);
    } finally {
      await backend.close();
      // Best-effort cleanup of the throwaway namespace.
      try {
        await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`);
      } catch { /* ignore */ }
    }
  });
});
