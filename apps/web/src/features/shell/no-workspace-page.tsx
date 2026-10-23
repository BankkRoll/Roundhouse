import { Button } from "@roundhouse/ui";
import { AuthLayout } from "../../components/auth-layout";
import { useMe, useSignOut } from "../../queries/me";

/**
 * Shown to signed-in users who belong to no workspace, e.g. after leaving or being
 * removed from their only one. They cannot create one themselves: the API reserves that
 * for people who already own or administer a workspace.
 *
 * @returns The page.
 */
export function NoWorkspacePage() {
  const { data: me } = useMe();
  const signOut = useSignOut();
  return (
    <AuthLayout
      title="You're not in a workspace yet"
      description="Ask a workspace admin to send you an invite link. Opening it adds you to their workspace."
    >
      <div className="grid gap-3">
        {me ? (
          <p className="text-sm text-muted-foreground">
            Signed in as <span className="font-mono text-foreground">{me.user.email}</span>.
          </p>
        ) : null}
        <Button variant="secondary" loading={signOut.isPending} onClick={() => signOut.mutate()}>
          Sign out
        </Button>
      </div>
    </AuthLayout>
  );
}
