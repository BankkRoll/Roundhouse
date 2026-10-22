import { describe, expect, it } from "vitest";
import {
  branchError,
  gitUrlError,
  imageReferenceError,
  parsePort,
  rootDirError,
  suggestServiceName,
} from "./source";

describe("new-service input checks", () => {
  it.each(["nginx", "nginx:1.27", "ghcr.io/acme/api:1.4.2", "localhost:5000/app@sha256:abc"])(
    "accepts image %s",
    (image) => expect(imageReferenceError(image)).toBeNull(),
  );

  it.each([
    ["", /Enter an image/],
    ["my app", /spaces/],
    ["Acme/App", /lowercase/],
    ["nginx:", /tag/],
    ["nginx;rm", /letters/],
  ])("rejects image %j", (image, message) => expect(imageReferenceError(image)).toMatch(message));

  it("checks git URLs like the API", () => {
    expect(gitUrlError("https://github.com/acme/app.git")).toBeNull();
    expect(gitUrlError("git@github.com:acme/app.git")).toMatch(/https/);
    expect(gitUrlError("https://user:pw@github.com/acme/app")).toMatch(/credentials/);
    expect(gitUrlError("https://github.com")).toMatch(/Expected/);
  });

  it("checks branches and root directories", () => {
    expect(branchError("feature/x")).toBeNull();
    expect(branchError("bad..branch")).not.toBeNull();
    expect(branchError("trailing/")).not.toBeNull();
    expect(rootDirError(".")).toBeNull();
    expect(rootDirError("apps/web")).toBeNull();
    expect(rootDirError("../etc")).not.toBeNull();
    expect(rootDirError("/abs")).not.toBeNull();
  });

  it("suggests names from images and repositories", () => {
    expect(suggestServiceName("ghcr.io/acme/API:1.4")).toBe("api");
    expect(suggestServiceName("https://github.com/acme/store-front.git")).toBe("store-front");
    expect(suggestServiceName("redis@sha256:abc")).toBe("redis");
    expect(suggestServiceName("")).toBe("");
  });

  it("parses optional ports", () => {
    expect(parsePort("")).toBeNull();
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort("70000")).toMatch(/1 to 65535/);
  });
});
