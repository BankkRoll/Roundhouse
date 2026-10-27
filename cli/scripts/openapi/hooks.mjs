// Module hooks that let the API's source load under Node, outside workerd:
// `cloudflare:workers` and `cloudflare:workflows` resolve to stubs (the dump
// only reads route registries; no Durable Object or Workflow is constructed),
// and `*.sh` imports load as text, as wrangler's Text rule does.
import { readFile } from "node:fs/promises";

export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") {
    return { url: new URL("./cloudflare-workers.mjs", import.meta.url).href, shortCircuit: true };
  }
  if (specifier === "cloudflare:workflows") {
    return { url: new URL("./cloudflare-workflows.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith("file:") && url.endsWith(".sh")) {
    const text = await readFile(new URL(url), "utf8");
    return {
      format: "module",
      source: `export default ${JSON.stringify(text)};`,
      shortCircuit: true,
    };
  }
  return next(url, context);
}
