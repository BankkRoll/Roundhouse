import "@testing-library/jest-dom/vitest";
import { clearToasts } from "@openrail/ui";
import { act, cleanup, configure } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { resetDb } from "../mocks/db";
import { resetRealtime } from "../mocks/deploy-handlers";
import { server } from "../mocks/server";

// COMPAT: jsdom lacks pointer capture and scrollIntoView, which Radix calls during
// pointer and keyboard interaction.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
// COMPAT: jsdom has no ResizeObserver; Radix (slider thumbs) measures with it.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// COMPAT: The router restores scroll on navigation; jsdom only logs "not implemented".
window.scrollTo = () => {};

// NOTE: Project and service pages chain several requests (project, config, deployments,
// socket); under a full parallel run the default 1 s for findBy* is too tight.
configure({ asyncUtilTimeout: 4_000 });

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));

afterEach(() => {
  cleanup();
  act(() => clearToasts());
  server.resetHandlers();
  resetDb();
  resetRealtime();
  localStorage.clear();
  document.documentElement.className = "";
});

afterAll(() => server.close());
