import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "../features/landing/landing-page";

// IMPORTANT: Public page. It sits outside the `_app` layout and has no `beforeLoad`, so it
// renders signed out, before setup, and with the API down. The router plugin's automatic
// code splitting keeps the component out of the dashboard's main bundle.
/** Public landing page. */
export const Route = createFileRoute("/")({
  component: LandingPage,
});
