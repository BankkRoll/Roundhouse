import type { InfiniteData } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type {
  Deployment,
  DeploymentDetail,
  DeploymentPage,
  ProjectDetail,
} from "../lib/api/deploy-types";
import { createQueryClient } from "../lib/query-client";
import { queryKeys } from "./keys";
import { applyRealtimeMessage } from "./realtime";

const base: Deployment = {
  id: "dep_1",
  service_id: "svc_1",
  environment_id: "env_1",
  config_version: 1,
  build_id: null,
  build: null,
  image: "nginx",
  status: "deploying",
  trigger: "manual",
  triggered_by: null,
  rollback_of: null,
  failure_reason: null,
  started_at: 1,
  finished_at: null,
  created_at: 1,
  updated_at: 10,
};

function seeded() {
  const client = createQueryClient({ retry: false });
  const page: InfiniteData<DeploymentPage, string | null> = {
    pages: [{ deployments: [base], next_cursor: null }],
    pageParams: [null],
  };
  client.setQueryData(queryKeys.deployments("svc_1", "env_1"), page);
  client.setQueryData(queryKeys.latestDeployment("svc_1", "env_1"), base);
  client.setQueryData<DeploymentDetail>(queryKeys.deployment("dep_1"), {
    ...base,
    events: [],
    placements: [],
  });
  return client;
}

const list = (client: ReturnType<typeof seeded>) =>
  client.getQueryData<InfiniteData<DeploymentPage>>(queryKeys.deployments("svc_1", "env_1"))
    ?.pages[0]?.deployments;

describe("applyRealtimeMessage", () => {
  it("updates a deployment everywhere it is cached", () => {
    const client = seeded();
    applyRealtimeMessage(client, {
      type: "deployment.updated",
      deployment: { ...base, status: "active", updated_at: 20 },
    });
    expect(list(client)?.[0]?.status).toBe("active");
    expect(
      client.getQueryData<Deployment>(queryKeys.latestDeployment("svc_1", "env_1"))?.status,
    ).toBe("active");
    expect(client.getQueryData<DeploymentDetail>(queryKeys.deployment("dep_1"))).toMatchObject({
      status: "active",
      events: [],
    });
  });

  it("ignores an update older than what is cached", () => {
    const client = seeded();
    applyRealtimeMessage(client, {
      type: "deployment.updated",
      deployment: { ...base, status: "queued", updated_at: 5 },
    });
    expect(list(client)?.[0]?.status).toBe("deploying");
  });

  it("prepends a new deployment and makes it the newest", () => {
    const client = seeded();
    const next = {
      ...base,
      id: "dep_2",
      status: "queued" as const,
      created_at: 50,
      updated_at: 50,
    };
    applyRealtimeMessage(client, { type: "deployment.updated", deployment: next });
    expect(list(client)?.map((d) => d.id)).toEqual(["dep_2", "dep_1"]);
    expect(client.getQueryData<Deployment>(queryKeys.latestDeployment("svc_1", "env_1"))?.id).toBe(
      "dep_2",
    );
  });

  it("appends timeline events once, in order", () => {
    const client = seeded();
    const event = {
      id: "ev_2",
      deployment_id: "dep_1",
      type: "status_changed" as const,
      message: "Deploying",
      data: null,
      created_at: 5,
    };
    applyRealtimeMessage(client, { type: "deployment.event", event });
    applyRealtimeMessage(client, { type: "deployment.event", event });
    applyRealtimeMessage(client, {
      type: "deployment.event",
      event: { ...event, id: "ev_1", created_at: 2 },
    });
    expect(
      client.getQueryData<DeploymentDetail>(queryKeys.deployment("dep_1"))?.events.map((e) => e.id),
    ).toEqual(["ev_1", "ev_2"]);
  });

  it("renames a service in its project without resurrecting deleted ones", () => {
    const client = createQueryClient({ retry: false });
    const service = {
      id: "svc_1",
      project_id: "prj_1",
      name: "web",
      slug: "web",
      kind: "app" as const,
      icon: null,
      created_at: 1,
      updated_at: 1,
    };
    client.setQueryData<ProjectDetail>(queryKeys.project("prj_1"), {
      id: "prj_1",
      workspace_id: "ws",
      name: "p",
      slug: "p",
      description: null,
      created_at: 1,
      updated_at: 1,
      environments: [],
      services: [service],
    });
    applyRealtimeMessage(client, {
      type: "service.updated",
      service: { ...service, name: "frontend" },
    });
    applyRealtimeMessage(client, {
      type: "service.updated",
      service: { ...service, id: "svc_gone" },
    });
    expect(
      client.getQueryData<ProjectDetail>(queryKeys.project("prj_1"))?.services.map((s) => s.name),
    ).toEqual(["frontend"]);
  });
});
