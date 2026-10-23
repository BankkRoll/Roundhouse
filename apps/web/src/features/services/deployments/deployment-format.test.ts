import { describe, expect, it } from "vitest";
import { db } from "../../../mocks/db";
import { SEED } from "../../../mocks/deploy-db";
import { deploymentName, shortDeploymentId } from "./deployment-format";

describe("shortDeploymentId", () => {
  it("keeps the prefix and the last six characters of a long id", () => {
    expect(shortDeploymentId("dep_01JB9ZK8M4V7Q2R5T6Y8W7XK2QM")).toBe("dep_…7XK2QM");
  });

  it("leaves short ids alone", () => {
    expect(shortDeploymentId("dep_web_4")).toBe("dep_web_4");
    expect(shortDeploymentId("abc")).toBe("abc");
  });
});

describe("deploymentName", () => {
  it("adds the id to the ref, so redeploys of one commit stay distinguishable", () => {
    const row = db.deploy.deployments.find((entry) => entry.id === SEED.apiActive)!;
    expect(deploymentName({ ...row, build: null })).toBe(
      `ghcr.io/acme/api:1.4.2 (${SEED.apiActive})`,
    );
    expect(deploymentName({ ...row, id: "dep_01JB9ZK8M4V7Q2R5T6Y8W7XK2QM", build: null })).toBe(
      "ghcr.io/acme/api:1.4.2 (dep_…7XK2QM)",
    );
  });
});
