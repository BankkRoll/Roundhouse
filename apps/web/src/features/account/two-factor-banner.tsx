import { Link, useRouterState } from "@tanstack/react-router";
import { ShieldAlertIcon } from "lucide-react";
import { useSecurityStatus } from "../../queries/security";

/**
 * Tells an admin who hasn't set up two-factor authentication why their changes are
 * refused (`two_factor_required`) and where to fix it. Hidden on the security page.
 *
 * @param props - Workspace id, for the link.
 * @returns The banner, or nothing.
 */
export function TwoFactorBanner({ workspaceId }: { workspaceId: string }) {
  const status = useSecurityStatus();
  const onSecurityPage = useRouterState({
    select: (state) => state.location.pathname.endsWith("/security"),
  });
  if (!status.data?.two_factor_required || status.data.two_factor_enabled || onSecurityPage) {
    return null;
  }
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-foreground">
      <ShieldAlertIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        Your role requires two-factor authentication. Until you set it up you can look around, but
        not change anything.
      </p>
      <Link
        to="/w/$workspaceId/security"
        params={{ workspaceId }}
        className="font-medium text-accent-text underline-offset-4 hover:underline"
      >
        Set up two-factor
      </Link>
    </div>
  );
}
