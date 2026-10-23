/**
 * Emits JSON Schemas for every protocol message into `../schema`, so non-TS
 * consumers (the Go agent, third-party tooling) have a language-neutral spec.
 *
 * Run with `pnpm --filter @roundhouse/protocol gen:schema` after changing a schema.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AgentFrameSchema,
  ControlMessageSchema,
  EnvelopeSchema,
  JoinRequestSchema,
  JoinResponseSchema,
} from "../src/index";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schema");
mkdirSync(outDir, { recursive: true });

const schemas = {
  // The complete union: every frame of every accepted version.
  "agent-message": AgentFrameSchema,
  "control-message": ControlMessageSchema,
  envelope: EnvelopeSchema,
  "join-request": JoinRequestSchema,
  "join-response": JoinResponseSchema,
};

for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12" });
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(json, null, 2)}\n`);
}
console.log(`wrote ${Object.keys(schemas).length} schemas to ${outDir}`);
