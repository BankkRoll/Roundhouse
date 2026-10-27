import { describe, expect, it } from "vitest";
import { RUNTIME_DO_CLASS, RUNTIME_WORKER_SOURCE } from "../src/cf-runtime";

describe("runtime Worker source", () => {
  it("is bundled as text, not executed", () => {
    expect(typeof RUNTIME_WORKER_SOURCE).toBe("string");
    expect(RUNTIME_WORKER_SOURCE).toContain(
      `export class ${RUNTIME_DO_CLASS} extends DurableObject`,
    );
  });
});
