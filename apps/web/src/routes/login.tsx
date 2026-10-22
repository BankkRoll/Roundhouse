import { createFileRoute, redirect } from "@tanstack/react-router";
import { LoginPage } from "../features/auth/login-page";
import { ensureSetupDone } from "../lib/route-guards";
import { safeRedirect } from "../lib/safe-redirect";
import { meQueryOptions } from "../queries/me";

interface LoginSearch {
  redirect?: string;
}

/** Sign-in page; skipped when already signed in. */
export const Route = createFileRoute("/login")({
  staticData: { title: "Sign in" },
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    await ensureSetupDone(context.queryClient);
    const me = await context.queryClient.ensureQueryData(meQueryOptions()).catch(() => null);
    if (me) throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: LoginRoute,
});

function LoginRoute() {
  const { redirect: target } = Route.useSearch();
  return <LoginPage redirectTo={safeRedirect(target)} />;
}
