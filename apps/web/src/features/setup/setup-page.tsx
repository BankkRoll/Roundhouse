import { PRODUCT_NAME } from "@openrail/shared";
import { Button, Skeleton } from "@openrail/ui";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthLayout } from "../../components/auth-layout";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import { generateMasterKey } from "../../lib/master-key";
import { useSetupStatus } from "../../queries/setup";
import { AddServerFlow } from "../servers/add-server-flow";
import { AccountStep } from "./account-step";
import { MasterKeyStep } from "./master-key-step";
import { StepIndicator } from "./step-indicator";

const STEPS = ["Master key", "Admin", "First server"] as const;

/** Props for {@link SetupPage}. */
export interface SetupPageProps {
  /** Node polling interval for step 3 (tests shorten it). */
  pollIntervalMs?: number;
}

/**
 * First-run wizard: configure MASTER_KEY, create the admin and workspace, add a server.
 *
 * SECURITY: The suggested master key lives only in component state. It is never written
 * to storage, the URL, or logs.
 *
 * @param props - Optional polling override.
 * @returns The wizard.
 */
export function SetupPage({ pollIntervalMs }: SetupPageProps = {}) {
  const navigate = useNavigate();
  const status = useSetupStatus();
  const [suggestedKey] = useState(generateMasterKey);
  // The route loads setup status before rendering, so this reads what the operator saw
  // on arrival rather than a later refetch.
  const [keyMissingOnArrival] = useState(() => status.data?.master_key_configured === false);
  const [checks, setChecks] = useState(0);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const goToDashboard = (id: string) =>
    void navigate({ to: "/w/$workspaceId", params: { workspaceId: id } });

  if (status.isPending) {
    return (
      <AuthLayout title={`Set up ${PRODUCT_NAME}`}>
        <Skeleton className="h-40" />
      </AuthLayout>
    );
  }
  if (status.isError) {
    return (
      <AuthLayout title={`Set up ${PRODUCT_NAME}`}>
        <ErrorState message={errorMessage(status.error)} onRetry={() => void status.refetch()} />
      </AuthLayout>
    );
  }

  const step = workspaceId ? 3 : status.data.master_key_configured ? 2 : 1;
  const sawKeyStep = keyMissingOnArrival || checks > 0;

  if (step === 3 && workspaceId) {
    return (
      <AuthLayout
        width={560}
        above={<StepIndicator steps={STEPS} current={3} />}
        title="Add your first server"
        description="Connect a machine for your apps to run on. You can also do this later from Servers."
      >
        <AddServerFlow
          workspaceId={workspaceId}
          pollIntervalMs={pollIntervalMs}
          doneLabel="Go to dashboard"
          onDone={() => goToDashboard(workspaceId)}
        />
        <div className="mt-4 flex justify-start border-t border-border pt-4">
          <Button variant="ghost" size="sm" onClick={() => goToDashboard(workspaceId)}>
            Skip for now
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (step === 1) {
    return (
      <AuthLayout
        width={560}
        above={<StepIndicator steps={STEPS} current={1} />}
        title="Configure the master key"
        description={`${PRODUCT_NAME} needs one secret before anyone can sign in.`}
      >
        <MasterKeyStep
          suggestedKey={suggestedKey}
          checking={status.isFetching}
          stillMissing={checks > 0 && !status.isFetching}
          onCheckAgain={() => {
            setChecks((count) => count + 1);
            void status.refetch();
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      width={560}
      above={<StepIndicator steps={STEPS} current={2} />}
      title="Create the admin account"
      description="This account owns the instance and its first workspace."
    >
      <AccountStep
        initialMasterKey={sawKeyStep ? suggestedKey : ""}
        onComplete={setWorkspaceId}
        onMasterKeyMissing={() => void status.refetch()}
      />
    </AuthLayout>
  );
}
