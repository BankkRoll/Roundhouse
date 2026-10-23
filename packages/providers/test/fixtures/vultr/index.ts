/**
 * Vultr test data built from the documented response shapes in this folder.
 * Each builder clones a documented object and overrides only what a scenario
 * needs. Plan IDs and prices are illustrative.
 *
 * @module
 */
import type { VultrInstance, VultrOs, VultrPlan, VultrRegion } from "../../../src/vultr/types";
import createInstanceDoc from "./create_instance.202.json";
import getInstanceDoc from "./get_instance.200.json";
import listOsDoc from "./list_os.200.json";
import listPlansDoc from "./list_plans.200.json";
import listRegionsDoc from "./list_regions.200.json";

export { default as firewallGroupDoc } from "./create_firewall_group.201.json";
export { default as firewallRuleDoc } from "./create_firewall_rule.201.json";
export { default as sshKeyDoc } from "./create_ssh_key.201.json";
export { default as errors } from "./errors.json";
export { default as accountDoc } from "./get_account.200.json";

const clone = <T>(v: T): T => structuredClone(v);

/** The documented plan example. */
export const docPlan = listPlansDoc.plans[0] as unknown as VultrPlan;
/** The documented region example. */
export const docRegion = listRegionsDoc.regions[0] as unknown as VultrRegion;
/** The documented OS example. */
export const docOs = listOsDoc.os[0] as unknown as VultrOs;
/** The documented create response, including `default_password`. */
export const docCreatedInstance = createInstanceDoc.instance as unknown as VultrInstance;
/** The documented running instance. */
export const docInstance = getInstanceDoc.instance as unknown as VultrInstance;

/** Builds a region from the documented example. */
export function region(id: string, city: string, country: string): VultrRegion {
  return { ...clone(docRegion), id, city, country };
}

/** Regions used across tests. */
export const REGIONS: VultrRegion[] = [
  region("ewr", "New Jersey", "US"),
  region("ams", "Amsterdam", "NL"),
  region("sao", "São Paulo", "BR"),
];

/** Builds a plan from the documented example. */
export function plan(spec: Partial<VultrPlan> & Pick<VultrPlan, "id">): VultrPlan {
  const base = clone(docPlan);
  return { ...base, location_cost: {}, ...spec };
}

/** Plans covering each offer rule, including a São Paulo price override. */
export const PLANS: VultrPlan[] = [
  plan({
    id: "vc2-1c-0.5gb",
    vcpu_count: 1,
    ram: 512,
    disk: 10,
    bandwidth: 500,
    monthly_cost: 2.5,
    type: "vc2",
    locations: ["ewr"],
  }),
  plan({
    id: "vc2-1c-1gb",
    vcpu_count: 1,
    ram: 1024,
    disk: 25,
    bandwidth: 1024,
    monthly_cost: 5,
    type: "vc2",
    locations: ["ewr", "ams", "sao"],
    location_cost: { sao: { monthly_cost: 7.5, hourly_cost: 0.01 } },
  }),
  plan({
    id: "vc2-2c-4gb",
    vcpu_count: 2,
    ram: 4096,
    disk: 80,
    bandwidth: 3072,
    monthly_cost: 20,
    type: "vc2",
    locations: ["ewr", "ams"],
  }),
  plan({
    id: "voc-g-2c-8gb-50s",
    vcpu_count: 2,
    ram: 8192,
    disk: 50,
    bandwidth: 4096,
    monthly_cost: 60,
    type: "voc-g",
    locations: ["ewr"],
  }),
  plan({
    id: "vcg-a16-2c-16g-4vram",
    vcpu_count: 2,
    ram: 16384,
    disk: 50,
    monthly_cost: 215,
    type: "vcg",
    gpu_brand: "NVIDIA",
    locations: ["ewr"],
  }),
  plan({
    id: "vhf-1c-1gb",
    vcpu_count: 1,
    ram: 1024,
    disk: 32,
    monthly_cost: 6,
    type: "vhf",
    locations: [],
  }),
];

/** Builds an OS entry from the documented example. */
export function os(id: number, name: string, family: string, arch = "x64"): VultrOs {
  return { ...clone(docOs), id, name, family, arch };
}

/** OS list: the supported images plus ones to filter out. */
export const OS_LIST: VultrOs[] = [
  os(2284, "Ubuntu 24.04 LTS x64", "ubuntu"),
  os(1743, "Ubuntu 22.04 LTS x64", "ubuntu"),
  os(2136, "Debian 12 x64 (bookworm)", "debian"),
  os(2625, "Debian 13 x64 (trixie)", "debian"),
  os(2760, "Ubuntu 26.04 LTS x64", "ubuntu"),
  os(127, "CentOS 6 x64", "centos"),
];

/** Builds a running instance from the documented example. */
export function instance(
  spec: Partial<VultrInstance> & Pick<VultrInstance, "id" | "label">,
): VultrInstance {
  return { ...clone(docInstance), tags: [], ...spec };
}
