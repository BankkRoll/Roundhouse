import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import { PRODUCT_NAME } from "@roundhouse/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { createAppContext } from "./bootstrap";
import { applyPreferences, readPreferences } from "./lib/preferences";

document.title = PRODUCT_NAME;
applyPreferences(readPreferences());

const { queryClient, router } = createAppContext();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App queryClient={queryClient} router={router} />
  </StrictMode>,
);
