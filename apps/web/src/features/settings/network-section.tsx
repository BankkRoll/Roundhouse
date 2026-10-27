/**
 * Platform → Network (ADR 0005): turning the WireGuard mesh between servers on or off,
 * and the private `/16` its addresses come from, which is fixed once a server joined.
 *
 * @module
 */
import { Badge, SaveBar, SettingsRow, SettingsSection, toast } from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { SettingsField } from "../../components/settings-field";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { InstanceSettings } from "../../lib/api/deploy-types";
import { useUpdateInstanceSettings } from "../../queries/instance";

/**
 * A supernet the API accepts: a `/16` under `10.0.0.0/8`, which keeps clear of Docker's
 * default address pools. Mirrors `MeshSupernetField` in the API.
 */
export const MESH_SUPERNET_PATTERN = /^10\.(25[0-5]|2[0-4]\d|1?\d?\d)\.0\.0\/16$/;

function settingsError(cause: unknown): string {
  return isApiError(cause, "reauth_required")
    ? `${errorMessage(cause)} Sign in again, then retry.`
    : errorMessage(cause);
}

function SupernetForm({ settings }: { settings: InstanceSettings }) {
  const update = useUpdateInstanceSettings();
  // NOTE: `null` until the user types, so the field follows the saved value.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? settings.mesh_supernet;
  const locked = settings.mesh_supernet_locked;
  const dirty = !locked && draft !== null && draft.trim() !== settings.mesh_supernet;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const supernet = value.trim();
    if (!MESH_SUPERNET_PATTERN.test(supernet)) {
      setError("Enter a /16 under 10.0.0.0/8, like 10.200.0.0/16.");
      return;
    }
    setError(null);
    update.mutate(
      { mesh_supernet: supernet },
      {
        onSuccess: () => {
          setDraft(null);
          toast({ title: "Network range saved", tone: "success" });
        },
        onError: (cause) => setError(settingsError(cause)),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Network range">
      <SettingsField
        label="Address range"
        description={
          locked
            ? "Fixed: servers have joined the mesh with addresses from this range. Each server gets a /24 of it."
            : "Each server gets a /24 of this range for its containers and mesh address. It can't change once a server has joined."
        }
        value={value}
        onChange={(event) => setDraft(event.target.value)}
        readOnly={locked}
        aria-readonly={locked || undefined}
        error={error}
        hint={locked ? undefined : "A /16 under 10.0.0.0/8, outside Docker's default pools."}
        spellCheck={false}
        autoComplete="off"
        inputClassName="font-mono"
      />
      {locked ? null : (
        <SaveBar
          dirty={dirty}
          saving={update.isPending}
          onDiscard={() => {
            setDraft(null);
            setError(null);
          }}
        />
      )}
    </form>
  );
}

/**
 * The Network section of the platform settings: the mesh switch and its address range.
 * Turning the mesh off asks first, since it cuts traffic between servers.
 *
 * @param props - The instance settings.
 * @returns The section.
 */
export function NetworkSection({ settings }: { settings: InstanceSettings }) {
  const update = useUpdateInstanceSettings();
  const [error, setError] = useState<string | null>(null);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const switchId = useId();

  function save(enabled: boolean) {
    setError(null);
    update.mutate(
      { mesh_enabled: enabled },
      {
        onSuccess: () => {
          setConfirmingOff(false);
          toast({
            title: enabled ? "Private network on" : "Private network off",
            tone: "success",
          });
        },
        onError: (cause) => setError(settingsError(cause)),
      },
    );
  }

  return (
    <SettingsSection
      id="network"
      title="Network"
      description="A private WireGuard network between servers. With it an environment can span servers, services reach each other by private name, and any ingress server can serve any domain."
      actions={
        <Badge tone={settings.mesh_enabled ? "success" : "neutral"}>
          {settings.mesh_enabled ? "On" : "Off"}
        </Badge>
      }
    >
      <SettingsRow
        label="Private network between servers"
        description="Off on new installs. Servers need UDP 51820 open in the host and cloud firewalls; servers behind NAT reach each other through a public one."
        htmlFor={switchId}
        control="switch"
      >
        <Switch
          id={switchId}
          checked={settings.mesh_enabled}
          disabled={update.isPending}
          onCheckedChange={(enabled) => (enabled ? save(true) : setConfirmingOff(true))}
          aria-describedby={error ? `${switchId}-error` : undefined}
        />
      </SettingsRow>
      {error && !confirmingOff ? (
        <p id={`${switchId}-error`} role="alert" className="pb-4 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <SupernetForm settings={settings} />
      <ConfirmDialog
        open={confirmingOff}
        onOpenChange={(open) => {
          setConfirmingOff(open);
          if (!open) setError(null);
        }}
        title="Turn off the private network?"
        description="Servers take down their mesh tunnels. Services on different servers can no longer reach each other, and each ingress server only routes to replicas running on it, so DNS must point at those."
        confirmLabel="Turn off"
        pending={update.isPending}
        error={confirmingOff ? error : null}
        onConfirm={() => save(false)}
      />
    </SettingsSection>
  );
}
