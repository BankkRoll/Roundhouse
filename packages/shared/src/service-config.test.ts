import { describe, expect, it } from "vitest";
import { defaultServiceConfig } from "./service-config";

describe("defaultServiceConfig", () => {
  it("keeps the given source", () => {
    const source = { type: "image", image: "nginx:1.27" } as const;
    expect(defaultServiceConfig(source).source).toBe(source);
  });

  it("returns a fresh object each time", () => {
    const a = defaultServiceConfig({ type: "image", image: "a" });
    a.deploy.replicas = 5;
    a.build.build_args.X = "1";
    const b = defaultServiceConfig({ type: "image", image: "a" });
    expect(b.deploy.replicas).toBe(1);
    expect(b.build.build_args).toEqual({});
  });

  it("starts private, single-replica and without a health probe", () => {
    const c = defaultServiceConfig({
      type: "git",
      repo_url: "https://github.com/a/b",
      branch: "main",
      root_dir: ".",
    });
    expect(c.networking.generated_domain).toBe(false);
    expect(c.deploy.replicas).toBe(1);
    expect(c.healthcheck).toBeNull();
  });
});
