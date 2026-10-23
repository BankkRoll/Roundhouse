import { Button } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { CircleAlertIcon, CircleCheckIcon, ClockIcon } from "lucide-react";
import { AuthLayout } from "../../components/auth-layout";
import { useMe } from "../../queries/me";

/** Props for {@link GithubCallbackPage}: the search params the API redirects with. */
export interface GithubCallbackPageProps {
  status?: string;
  error?: string;
}

type Tone = "success" | "pending" | "error";

const OUTCOMES: Record<string, { title: string; description: string; tone: Tone }> = {
  installed: {
    title: "GitHub App installed",
    description: "Its repositories now appear when you add a service from GitHub.",
    tone: "success",
  },
  requested: {
    title: "Installation requested",
    description:
      "An owner of the GitHub organization has to approve the installation. Repositories appear here once they do.",
    tone: "pending",
  },
  exchange_failed: {
    title: "GitHub App wasn't created",
    description:
      "GitHub didn't confirm the new App (the link may have expired or been used already). Start again from Platform settings.",
    tone: "error",
  },
  installation_not_found: {
    title: "Installation not found",
    description:
      "GitHub reported an installation the App can't see. Try installing again from Platform settings.",
    tone: "error",
  },
  installation_claimed: {
    title: "Already used by another workspace",
    description:
      "That GitHub account's installation belongs to another workspace on this instance. Ask its owners, or install on a different account.",
    tone: "error",
  },
};

const ICONS = {
  success: <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />,
  pending: <ClockIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />,
  error: <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />,
} satisfies Record<Tone, unknown>;

/**
 * Landing page after GitHub's App creation and installation flow: explains the outcome
 * the API reported and leads back to Platform settings.
 *
 * @param props - `status` or `error` from the URL.
 * @returns The page.
 */
export function GithubCallbackPage({ status, error }: GithubCallbackPageProps) {
  const { data: me } = useMe();
  const workspaceId = me?.workspaces[0]?.id;
  const outcome = (error && OUTCOMES[error]) ||
    (status && OUTCOMES[status]) || {
      title: "GitHub setup didn't finish",
      description: "GitHub sent you back without a result. Try again from Platform settings.",
      tone: "error" as const,
    };
  return (
    <AuthLayout
      title={outcome.title}
      description={
        <span
          role={outcome.tone === "error" ? "alert" : "status"}
          className="flex items-start gap-2"
        >
          {ICONS[outcome.tone]}
          {outcome.description}
        </span>
      }
    >
      {workspaceId ? (
        <Button asChild variant="primary" className="w-full">
          <Link to="/w/$workspaceId/platform" params={{ workspaceId }}>
            Back to Platform settings
          </Link>
        </Button>
      ) : (
        <Button asChild variant="secondary" className="w-full">
          <Link to="/dashboard">Go to dashboard</Link>
        </Button>
      )}
    </AuthLayout>
  );
}
