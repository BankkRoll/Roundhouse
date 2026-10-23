/**
 * Entry point of the public site, published to GitHub Pages. It is a static page with no
 * API: the dashboard each install runs lives on that install's own Worker.
 *
 * @module
 */
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@roundhouse/ui/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LandingPage } from "./landing-page";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <LandingPage />
  </StrictMode>,
);
