/**
 * Linode test data built from the documented response shapes in this
 * folder. Each builder clones a documented object and overrides only what a
 * scenario needs. Type IDs and prices are illustrative.
 *
 * @module
 */
import type { Linode, LinodeImage, LinodeRegion, LinodeType } from "../../../src/linode/types";
import getImageDoc from "./get_image.200.json";
import getLinodeDoc from "./get_linode.200.json";
import getRegionDoc from "./get_region.200.json";
import getTypeDoc from "./get_type.200.json";

export { default as firewallDoc } from "./create_firewall.200.json";
export { default as errors } from "./errors.json";
export { default as profileDoc } from "./get_profile.200.json";

const clone = <T>(v: T): T => structuredClone(v);

/** The documented type (`g6-standard-2`, with region price overrides). */
export const docType = getTypeDoc as unknown as LinodeType;
/** The documented region (`us-east`). */
export const docRegion = getRegionDoc as unknown as LinodeRegion;
/** The documented image (`linode/ubuntu24.04`). */
export const docImage = getImageDoc as unknown as LinodeImage;
/** The documented Linode. */
export const docLinode = getLinodeDoc as unknown as Linode;

/** Builds a region from the documented example. */
export function region(
  spec: Partial<LinodeRegion> & Pick<LinodeRegion, "id" | "label">,
): LinodeRegion {
  return { ...clone(docRegion), ...spec };
}

const without = (caps: string[], drop: string) => caps.filter((c) => c !== drop);

/**
 * Regions: two usable ones (one with Premium Plans), and one each without
 * Metadata, at a distributed site, and in an outage.
 */
export const REGIONS: LinodeRegion[] = [
  region({ id: "us-east", label: "Newark, NJ" }),
  region({
    id: "br-gru",
    label: "Sao Paulo, BR",
    country: "br",
    capabilities: [...docRegion.capabilities, "Premium Plans"],
  }),
  region({
    id: "eu-west",
    label: "London, UK",
    country: "gb",
    capabilities: without(docRegion.capabilities, "Metadata"),
  }),
  region({ id: "us-mia-edge", label: "Miami, FL", site_type: "distributed" }),
  region({ id: "ap-south", label: "Singapore, SG", country: "sg", status: "outage" }),
];

/** Builds a type from the documented example. */
export function type(spec: Partial<LinodeType> & Pick<LinodeType, "id">): LinodeType {
  return { ...clone(docType), region_prices: [], ...spec };
}

/** Types covering each offer rule. */
export const TYPES: LinodeType[] = [
  type({
    id: "g6-nanode-1",
    label: "Nanode 1GB",
    class: "nanode",
    vcpus: 1,
    memory: 1024,
    disk: 25600,
    transfer: 1000,
    price: { hourly: 0.0075, monthly: 5 },
  }),
  clone(docType),
  type({
    id: "g6-dedicated-2",
    label: "Dedicated 4GB",
    class: "dedicated",
    vcpus: 2,
    memory: 4096,
    disk: 81920,
    price: { hourly: 0.054, monthly: 36 },
  }),
  type({
    id: "g7-premium-2",
    label: "Premium 4GB",
    class: "premium",
    vcpus: 2,
    memory: 4096,
    disk: 81920,
    price: { hourly: 0.06, monthly: 43 },
  }),
  type({
    id: "g6-standard-1",
    label: "Linode 2GB",
    vcpus: 1,
    memory: 2048,
    disk: 51200,
    price: { hourly: 0.018, monthly: 12 },
    successor: "g7-standard-1",
  }),
  type({
    id: "g1-gpu-rtx6000-1",
    label: "RTX6000 GPU x1",
    class: "gpu",
    vcpus: 8,
    memory: 32768,
    disk: 655360,
    gpus: 1,
    price: { hourly: 1.5, monthly: 1000 },
  }),
];

/** Builds an image from the documented example. */
export function image(spec: Partial<LinodeImage> & Pick<LinodeImage, "id" | "label">): LinodeImage {
  return { ...clone(docImage), ...spec };
}

/** Images: the supported IDs plus ones to filter out. */
export const IMAGES: LinodeImage[] = [
  clone(docImage),
  image({ id: "linode/ubuntu22.04", label: "Ubuntu 22.04 LTS" }),
  image({ id: "linode/debian12", label: "Debian 12", vendor: "Debian" }),
  image({ id: "linode/debian11", label: "Debian 11", vendor: "Debian", deprecated: true }),
  image({
    id: "linode/slackware15.0",
    label: "Slackware 15.0",
    vendor: "Slackware",
    capabilities: [],
  }),
];

/** Builds a Linode from the documented example. */
export function linode(spec: Partial<Linode> & Pick<Linode, "id" | "label">): Linode {
  return { ...clone(docLinode), tags: [], ...spec };
}
