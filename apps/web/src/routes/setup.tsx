import { createFileRoute, redirect } from "@tanstack/react-router";
import { SetupPage } from "../features/setup/setup-page";
import { setupQueryOptions } from "../queries/setup";

/** First-run setup wizard; only reachable before setup completes. */
export const Route = createFileRoute("/setup")({
  staticData: { title: "Set up" },
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(setupQueryOptions());
    if (!status.needs_setup) throw redirect({ to: "/dashboard" });
  },
  component: SetupPage,
});
