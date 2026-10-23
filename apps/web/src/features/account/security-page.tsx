/**
 * Settings → Account → Security: two-factor authentication (setup, backup codes,
 * turning it off) and the signed-in user's sessions, with sign-out per device.
 *
 * @module
 */
import {
  Badge,
  Button,
  EmptyState,
  SettingsRow,
  SettingsSection,
  SettingsStack,
  Skeleton,
  toast,
} from "@roundhouse/ui";
import { MonitorSmartphoneIcon } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import type { AccountSession } from "../../lib/api/security-types";
import { formatRelativeTime, formatTimestamp } from "../../lib/format";
import { useNow } from "../../lib/use-now";
import { useMe } from "../../queries/me";
import {
  useRevokeOtherSessions,
  useRevokeSession,
  useSecurityStatus,
  useSessions,
} from "../../queries/security";
import { SettingsFrame } from "../settings/settings-frame";
import { TwoFactorChangeDialog, TwoFactorSetupDialog } from "./two-factor-dialogs";
import { describeUserAgent } from "./user-agent";

/** Backup codes at or below this count get a warning. */
const LOW_BACKUP_CODES = 2;

function TwoFactorSection({ email }: { email: string }) {
  const status = useSecurityStatus();
  const [setupOpen, setSetupOpen] = useState(false);
  const [change, setChange] = useState<"disable" | "regenerate" | null>(null);

  if (status.isPending) return <Skeleton className="h-24" />;
  if (status.isError) {
    return (
      <ErrorState message={errorMessage(status.error)} onRetry={() => void status.refetch()} />
    );
  }
  const { two_factor_enabled: enabled, two_factor_required: required } = status.data;
  const remaining = status.data.backup_codes_remaining ?? 0;

  return (
    <SettingsSection
      title="Two-factor authentication"
      description="Signing in asks for a code from an authenticator app after your password."
      actions={
        enabled ? (
          <Badge tone="success">On</Badge>
        ) : required ? (
          <Badge tone="warning">Required</Badge>
        ) : (
          <Badge>Off</Badge>
        )
      }
    >
      {!enabled && required ? (
        <p role="status" className="py-3 text-sm text-warning">
          Your role requires two-factor authentication. Until you set it up you can look around, but
          not change anything.
        </p>
      ) : null}
      <SettingsRow
        control="switch"
        label="Authenticator app"
        description={
          enabled
            ? "Codes from your app are asked for at every sign-in and before sensitive changes."
            : "Use 1Password, Google Authenticator, Authy or any app that supports TOTP."
        }
      >
        {enabled ? (
          <Button variant="ghost" size="sm" onClick={() => setChange("disable")}>
            Turn off
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={() => setSetupOpen(true)}>
            Set up
          </Button>
        )}
      </SettingsRow>
      {enabled ? (
        <SettingsRow
          control="switch"
          label="Backup codes"
          description={
            <span className={remaining <= LOW_BACKUP_CODES ? "text-warning" : undefined}>
              {remaining === 1 ? "1 code left" : `${remaining} codes left`}. Each signs you in once
              without your app.
            </span>
          }
        >
          <Button variant="ghost" size="sm" onClick={() => setChange("regenerate")}>
            Generate new codes
          </Button>
        </SettingsRow>
      ) : null}
      <TwoFactorSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        email={email}
        onDone={() => toast({ tone: "success", title: "Two-factor authentication is on" })}
      />
      <TwoFactorChangeDialog
        mode={change}
        onClose={() => setChange(null)}
        email={email}
        required={required}
      />
    </SettingsSection>
  );
}

function SessionRow({
  session,
  now,
  onRevoke,
}: {
  session: AccountSession;
  now: number;
  onRevoke: () => void;
}) {
  const device = describeUserAgent(session.user_agent);
  return (
    <SettingsRow
      control="switch"
      label={
        <span className="flex items-center gap-2">
          {device}
          {session.current ? <Badge tone="accent">This device</Badge> : null}
        </span>
      }
      description={
        <>
          {session.ip_address ?? "Unknown address"} · signed in{" "}
          <time
            dateTime={new Date(session.created_at).toISOString()}
            title={formatTimestamp(session.created_at)}
          >
            {formatRelativeTime(session.created_at, now)}
          </time>
        </>
      }
    >
      {session.current ? null : (
        <Button variant="ghost" size="sm" aria-label={`Sign out ${device}`} onClick={onRevoke}>
          Sign out
        </Button>
      )}
    </SettingsRow>
  );
}

function SessionsSection() {
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const [revoking, setRevoking] = useState<AccountSession | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);
  const now = useNow(60_000);
  const others = sessions.data?.filter((s) => !s.current).length ?? 0;

  return (
    <SettingsSection
      title="Sessions"
      description="Where you're signed in. Signing a device out ends its session at once."
      actions={
        others > 0 ? (
          <Button variant="secondary" size="sm" onClick={() => setRevokingOthers(true)}>
            Sign out other sessions
          </Button>
        ) : null
      }
    >
      {sessions.isPending ? (
        <Skeleton className="h-24" />
      ) : sessions.isError ? (
        <ErrorState
          message={errorMessage(sessions.error)}
          onRetry={() => void sessions.refetch()}
        />
      ) : sessions.data.length === 0 ? (
        <EmptyState
          icon={<MonitorSmartphoneIcon />}
          title="No sessions"
          description="Sessions appear here when you sign in."
          className="py-10"
        />
      ) : (
        sessions.data.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            now={now}
            onRevoke={() => setRevoking(session)}
          />
        ))
      )}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevoking(null);
            revoke.reset();
          }
        }}
        title={`Sign out ${revoking ? describeUserAgent(revoking.user_agent) : "this session"}?`}
        description="That device is signed out on its next request and has to sign in again."
        confirmLabel="Sign out"
        pending={revoke.isPending}
        error={revoke.isError ? errorMessage(revoke.error) : null}
        onConfirm={() => {
          if (!revoking) return;
          revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) });
        }}
      />
      <ConfirmDialog
        open={revokingOthers}
        onOpenChange={(open) => {
          setRevokingOthers(open);
          if (!open) revokeOthers.reset();
        }}
        title="Sign out every other session?"
        description="Every device but this one is signed out and has to sign in again."
        confirmLabel="Sign out others"
        pending={revokeOthers.isPending}
        error={revokeOthers.isError ? errorMessage(revokeOthers.error) : null}
        onConfirm={() =>
          revokeOthers.mutate(undefined, {
            onSuccess: ({ revoked }) => {
              setRevokingOthers(false);
              toast({
                tone: "success",
                title: revoked === 1 ? "1 session signed out" : `${revoked} sessions signed out`,
              });
            },
          })
        }
      />
    </SettingsSection>
  );
}

/**
 * Settings → Account → Security.
 *
 * @param props - Workspace id, for the settings navigation.
 * @returns The page.
 */
export function SecurityPage({ workspaceId }: { workspaceId: string }) {
  const { data: me } = useMe();
  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="Security"
      description="Two-factor authentication and the devices you're signed in on."
    >
      <SettingsStack>
        <TwoFactorSection email={me?.user.email ?? ""} />
        <SessionsSection />
      </SettingsStack>
    </SettingsFrame>
  );
}
