import "@testing-library/jest-dom/vitest";
import { clearToasts } from "@openrail/ui";
import { act, cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { resetDb } from "../mocks/db";
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
// COMPAT: The router restores scroll on navigation; jsdom only logs "not implemented".
window.scrollTo = () => {};

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));

afterEach(() => {
  cleanup();
  act(() => clearToasts());
  server.resetHandlers();
  resetDb();
  localStorage.clear();
  document.documentElement.className = "";
});

afterAll(() => server.close());
