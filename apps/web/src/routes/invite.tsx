import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { InvitePage } from "../features/auth/invite-page";
import { tabStorage, takeInviteToken } from "../features/auth/invite-token";

/** Invite landing page (public). The token arrives in the fragment: `/invite#token=…`. */
export const Route = createFileRoute("/invite")({
  staticData: { title: "Join a workspace" },
  component: InviteRoute,
});

function InviteRoute() {
  const router = useRouter();
  // NOTE: Read once, on first render, so the fragment is gone from the address bar
  // before the preview request starts. The router's history does the `replaceState`,
  // so its own location stays in step.
  const [token] = useState(() => {
    const { hash, pathname, searchStr } = router.state.location;
    return takeInviteToken({
      hash,
      dropHash: () => router.history.replace(pathname + searchStr, router.history.location.state),
      storage: tabStorage(),
    });
  });
  return <InvitePage token={token} />;
}
