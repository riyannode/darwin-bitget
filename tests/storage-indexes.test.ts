import { describe, expect, it } from "vitest";
import { ensureStorage } from "../src/storage/schema.js";

describe("Durable Object storage indexes", () => {
  it("creates only the justified hot ORDER BY indexes", () => {
    const queries: string[] = [];
    ensureStorage({
      sql(strings: TemplateStringsArray, ...values: unknown[]) {
        queries.push(strings.reduce((query, part, index) => query + part + (index < values.length ? "?" : ""), ""));
        return [];
      },
    });

    for (const index of [
      "journals_created_at_idx",
      "experiences_created_at_idx",
      "events_created_at_idx",
      "events_cycle_created_at_idx",
      "lessons_updated_at_idx",
      "backtests_created_at_idx",
    ]) {
      expect(queries).toContainEqual(expect.stringContaining(`CREATE INDEX IF NOT EXISTS ${index}`));
    }
  });
});
