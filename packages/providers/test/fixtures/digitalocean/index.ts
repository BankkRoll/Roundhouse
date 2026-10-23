/**
 * DigitalOcean test data built from the documented response shapes in this
 * folder. Each builder clones a documented object and overrides only what a
 * scenario needs. Slugs and prices are illustrative.
 *
 * @module
 */
import type { DoDroplet, DoImage, DoRegion, DoSize } from "../../../src/digitalocean/types";
import createDropletDoc from "./create_droplet.202.json";
import networksDoc from "./droplet_networks.json";
import listImagesDoc from "./list_images.200.json";
import listRegionsDoc from "./list_regions.200.json";
import listSizesDoc from "./list_sizes.200.json";

export { default as errors } from "./errors.json";
export { default as accountDoc } from "./get_account.200.json";

const clone = <T>(v: T): T => structuredClone(v);

/** The documented size example. */
export const docSize = listSizesDoc.sizes[0] as unknown as DoSize;
/** The documented region example. */
export const docRegion = listRegionsDoc.regions[0] as unknown as DoRegion;
/** The documented image example. */
export const docImage = listImagesDoc.images[0] as unknown as DoImage;
/** The documented droplet from the create response. */
export const docDroplet = createDropletDoc.droplet as unknown as DoDroplet;
/** The documented networks of an active droplet. */
export const docNetworks = networksDoc.networks as unknown as DoDroplet["networks"];

/** Builds a region from the documented example. */
export function region(slug: string, name: string, available = true): DoRegion {
  return { ...clone(docRegion), slug, name, available };
}

/** Regions used across tests; `sgp1` is unavailable. */
export const REGIONS: DoRegion[] = [
  region("nyc3", "New York 3"),
  region("fra1", "Frankfurt 1"),
  region("sgp1", "Singapore 1", false),
];

/** Builds a size from the documented example. */
export function size(spec: Partial<DoSize> & Pick<DoSize, "slug">): DoSize {
  return { ...clone(docSize), ...spec };
}

/** Sizes covering each offer rule. */
export const SIZES: DoSize[] = [
  size({ slug: "s-1vcpu-512mb-10gb", memory: 512, disk: 10, price_monthly: 4, regions: ["nyc3"] }),
  size({
    slug: "s-1vcpu-1gb",
    memory: 1024,
    disk: 25,
    price_monthly: 6,
    regions: ["nyc3", "fra1"],
  }),
  size({
    slug: "s-2vcpu-4gb",
    vcpus: 2,
    memory: 4096,
    disk: 80,
    price_monthly: 24,
    transfer: 4,
    regions: ["nyc3", "fra1", "sgp1"],
  }),
  size({
    slug: "g-2vcpu-8gb",
    vcpus: 2,
    memory: 8192,
    disk: 25,
    price_monthly: 63,
    description: "General Purpose",
    regions: ["nyc3"],
  }),
  size({
    slug: "s-4vcpu-8gb",
    vcpus: 4,
    memory: 8192,
    disk: 160,
    price_monthly: 48,
    available: false,
  }),
  size({
    slug: "gpu-h100x1-80gb",
    vcpus: 20,
    memory: 245760,
    disk: 720,
    price_monthly: 2500,
    description: "GPU",
    gpu_info: { count: 1, model: "nvidia_h100" },
    regions: ["nyc3"],
  }),
];

/** Builds an image from the documented example. */
export function image(spec: Partial<DoImage> & Pick<DoImage, "id" | "slug">): DoImage {
  return { ...clone(docImage), ...spec };
}

/** Images: the supported slugs plus ones to filter out. */
export const IMAGES: DoImage[] = [
  image({ id: 1001, slug: "ubuntu-24-04-x64", name: "24.04 (LTS) x64", regions: ["nyc3", "fra1"] }),
  image({ id: 1002, slug: "ubuntu-22-04-x64", name: "22.04 (LTS) x64", regions: ["nyc3", "fra1"] }),
  image({
    id: 1003,
    slug: "debian-12-x64",
    name: "12 x64",
    distribution: "Debian",
    regions: ["nyc3"],
  }),
  image({ id: 1004, slug: "ubuntu-20-04-x64", regions: ["nyc3"] }),
  image({
    id: 1005,
    slug: "debian-11-x64",
    distribution: "Debian",
    status: "retired",
    regions: ["nyc3"],
  }),
  image({ id: 1006, slug: "fedora-42-x64", distribution: "Fedora", regions: ["nyc3"] }),
];

/** Builds a droplet from the documented example. */
export function droplet(spec: Partial<DoDroplet> & Pick<DoDroplet, "id" | "name">): DoDroplet {
  return {
    ...clone(docDroplet),
    status: "active",
    networks: clone(docNetworks),
    tags: [],
    ...spec,
  };
}
