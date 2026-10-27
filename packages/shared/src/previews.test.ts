import { describe, expect, it } from "vitest";
import {
  canApprovePreview,
  clampPreviewConfig,
  gatePreview,
  isForkPullRequest,
  previewCommentMarker,
  previewEnvironmentSlug,
  previewStatusContext,
  previewWithholdsSecrets,
} from "./previews";
import { defaultServiceConfig } from "./service-config";

describe("isForkPullRequest", () => {
  it("treats another repository, or a deleted one, as a fork", () => {
    expect(isForkPullRequest("acme/shop", "acme/shop")).toBe(false);
    expect(isForkPullRequest("ACME/Shop", "acme/shop")).toBe(false);
    expect(isForkPullRequest("mallory/shop", "acme/shop")).toBe(true);
    expect(isForkPullRequest(null, "acme/shop")).toBe(true);
  });
});

describe("gatePreview", () => {
  it.each([
    [false, "disabled", "a", null, "pass"],
    [true, "disabled", "a", "a", "fork_disabled"],
    [true, "approval", "a", null, "pending_approval"],
    [true, "approval", "b", "a", "pending_approval"],
    [true, "approval", "a", "a", "pass"],
  ] as const)(
    "fork %s, policy %s, head %s, approved %s → %s",
    (isFork, forkPolicy, headSha, approvedSha, want) => {
      expect(gatePreview({ isFork, forkPolicy, headSha, approvedSha })).toBe(want);
    },
  );
});

describe("canApprovePreview", () => {
  it("accepts write access and above only", () => {
    for (const p of ["admin", "maintain", "write"]) expect(canApprovePreview(p)).toBe(true);
    for (const p of ["triage", "read", "none", "", null, undefined]) {
      expect(canApprovePreview(p)).toBe(false);
    }
  });
});

describe("previewWithholdsSecrets", () => {
  it("withholds for forks always, and for same-repository PRs on omit", () => {
    expect(previewWithholdsSecrets(true, "copy")).toBe(true);
    expect(previewWithholdsSecrets(false, "omit")).toBe(true);
    expect(previewWithholdsSecrets(false, "copy")).toBe(false);
  });
});

describe("clampPreviewConfig", () => {
  it("lowers to the caps, keeps lower values and a stopped service", () => {
    const spec = defaultServiceConfig({ type: "image", image: "nginx:1.27" });
    spec.deploy.replicas = 0;
    spec.resources = { cpu_millis: 250, memory_mb: 4096 };
    const out = clampPreviewConfig(
      spec,
      { replicas: 2, cpu_millis: 1000, memory_mb: 512, volume_mb: 1024 },
      {},
    );
    expect(out.deploy.replicas).toBe(0);
    expect(out.resources).toEqual({ cpu_millis: 250, memory_mb: 512 });
  });
});

describe("names", () => {
  it("derives the slug, comment marker and status context", () => {
    expect(previewEnvironmentSlug(42)).toBe("pr-42");
    expect(previewCommentMarker("prj_1")).toBe("<!-- roundhouse-preview:prj_1 -->");
    expect(previewStatusContext("shop")).toBe("roundhouse/preview/shop");
  });
});
