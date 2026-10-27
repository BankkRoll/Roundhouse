/** The development-only Cloudflare API base override. */
import { afterEach, describe, expect, it } from "vitest";
import {
  cloudflareCall,
  configureCloudflareApi,
  setCloudflareTransport,
} from "../src/lib/certificates/cloudflare-dns";

const seen: string[] = [];
const ok = async (input: RequestInfo | URL) => {
  seen.push(String(input));
  return Response.json({ success: true, result: {} });
};

afterEach(() => {
  configureCloudflareApi({});
  setCloudflareTransport(null);
  seen.length = 0;
});

describe("CLOUDFLARE_API_URL", () => {
  it("is honoured only in development", async () => {
    setCloudflareTransport(ok as typeof fetch);
    configureCloudflareApi({ CLOUDFLARE_API_URL: "http://127.0.0.1:9/client/v4/" });
    await cloudflareCall({ apiToken: "t" }, "GET", "/zones/z");
    configureCloudflareApi({
      ROUNDHOUSE_DEV: "1",
      CLOUDFLARE_API_URL: "http://127.0.0.1:9/client/v4/",
    });
    await cloudflareCall({ apiToken: "t" }, "GET", "/zones/z");
    configureCloudflareApi({ ROUNDHOUSE_DEV: "1", CLOUDFLARE_API_URL: "not a url" });
    await cloudflareCall({ apiToken: "t" }, "GET", "/zones/z");
    expect(seen).toEqual([
      "https://api.cloudflare.com/client/v4/zones/z",
      "http://127.0.0.1:9/client/v4/zones/z",
      "https://api.cloudflare.com/client/v4/zones/z",
    ]);
  });
});
