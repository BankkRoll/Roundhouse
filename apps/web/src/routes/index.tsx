import { createFileRoute, redirect } from "@tanstack/react-router";

// NOTE: The public site lives in landing/ and is published to GitHub Pages; an install's
// root URL goes straight to its dashboard, which routes to setup or sign-in as needed.
/** Root URL: sends visitors to the dashboard. */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard" });
  },
});
