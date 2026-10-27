/**
 * Platform → Registry storage (ADR 0005, "Registry over the mesh"): an S3-compatible
 * bucket for built images. Without one, each workspace's builder keeps them on its disk
 * and other servers pull through it over the private network. With one, builders write
 * with a read-write key and every other server reads with a read-only key, so any number
 * of builders work and no mesh is needed. Both secrets are write-only.
 *
 * @module
 */
import { Badge, Button, SaveBar, SettingsSection, Skeleton, toast } from "@roundhouse/ui";
import { type FormEvent, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import { SettingsField } from "../../components/settings-field";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { RegistryStorage } from "../../lib/api/registry-client";
import {
  useRegistryStorage,
  useRemoveRegistryStorage,
  useSaveRegistryStorage,
} from "../../queries/registry";

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,32}$/;

interface Draft {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secret: string;
  readonlyKeyId: string;
  readonlySecret: string;
}

function draftOf(storage: RegistryStorage): Draft {
  return {
    endpoint: storage.endpoint ?? "",
    bucket: storage.bucket ?? "",
    region: storage.region ?? "",
    accessKeyId: storage.access_key_id ?? "",
    secret: "",
    readonlyKeyId: storage.readonly_access_key_id ?? "",
    readonlySecret: "",
  };
}

function validate(draft: Draft, secretsSet: boolean): Partial<Record<keyof Draft, string>> {
  const errors: Partial<Record<keyof Draft, string>> = {};
  let endpoint: URL | null = null;
  try {
    endpoint = new URL(draft.endpoint.trim());
  } catch {
    endpoint = null;
  }
  if (endpoint?.protocol !== "https:" || endpoint.pathname.length > 1) {
    errors.endpoint = "Enter the bucket service's https:// origin, without a path.";
  }
  if (!BUCKET.test(draft.bucket.trim())) errors.bucket = "Enter an S3 bucket name.";
  if (draft.region.trim() && !REGION.test(draft.region.trim())) {
    errors.region = "Lowercase letters, digits and dashes.";
  }
  if (!draft.accessKeyId.trim()) errors.accessKeyId = "Enter the read-write access key ID.";
  if (!draft.readonlyKeyId.trim()) errors.readonlyKeyId = "Enter the read-only access key ID.";
  if (!secretsSet && !draft.secret) errors.secret = "Enter the read-write secret.";
  if (!secretsSet && !draft.readonlySecret) errors.readonlySecret = "Enter the read-only secret.";
  return errors;
}

function saveError(cause: unknown): string {
  return isApiError(cause, "reauth_required")
    ? `${errorMessage(cause)} Sign in again, then retry.`
    : errorMessage(cause);
}

function StorageForm({ storage }: { storage: RegistryStorage }) {
  const save = useSaveRegistryStorage();
  const remove = useRemoveRegistryStorage();
  const [draft, setDraft] = useState(() => draftOf(storage));
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const s3 = storage.type === "s3";
  const errors = validate(draft, storage.secrets_set);
  const saved = draftOf(storage);
  const dirty = (Object.keys(saved) as (keyof Draft)[]).some((key) => draft[key] !== saved[key]);
  const show = (key: keyof Draft) => (submitted ? (errors[key] ?? null) : null);
  const set = (key: keyof Draft) => (event: { target: { value: string } }) =>
    setDraft((previous) => ({ ...previous, [key]: event.target.value }));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    setError(null);
    save.mutate(
      {
        endpoint: draft.endpoint.trim(),
        bucket: draft.bucket.trim(),
        ...(draft.region.trim() ? { region: draft.region.trim() } : {}),
        access_key_id: draft.accessKeyId.trim(),
        ...(draft.secret ? { secret_access_key: draft.secret } : {}),
        readonly_access_key_id: draft.readonlyKeyId.trim(),
        ...(draft.readonlySecret ? { readonly_secret_access_key: draft.readonlySecret } : {}),
      },
      {
        onSuccess: (next) => {
          setDraft(draftOf(next));
          setSubmitted(false);
          toast({ title: "Registry storage saved", tone: "success" });
        },
        onError: (cause) => setError(saveError(cause)),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Registry storage">
      <SettingsSection
        id="registry-storage"
        title="Registry storage"
        description="Where built images are kept. Without a bucket, each workspace's builder keeps them on its disk and other servers pull through it over the private network. With one, builders write to it and every other server reads it with a read-only key, so any number of builders work."
        className="scroll-mt-20"
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={s3 ? "success" : "neutral"}>{s3 ? "Bucket" : "Builder disk"}</Badge>
            {s3 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingRemove(true)}
              >
                Use builder disk
              </Button>
            ) : null}
          </div>
        }
      >
        <SettingsField
          label="Endpoint"
          description="The S3 API origin, e.g. https://<account>.r2.cloudflarestorage.com."
          value={draft.endpoint}
          onChange={set("endpoint")}
          error={show("endpoint")}
          placeholder="https://<account>.r2.cloudflarestorage.com"
          inputClassName="font-mono"
          spellCheck={false}
        />
        <SettingsField
          label="Bucket"
          value={draft.bucket}
          onChange={set("bucket")}
          error={show("bucket")}
          placeholder="roundhouse-registry"
          inputClassName="font-mono"
          spellCheck={false}
        />
        <SettingsField
          label="Region"
          description="auto for R2, which is the default."
          value={draft.region}
          onChange={set("region")}
          error={show("region")}
          placeholder="auto"
          inputClassName="font-mono"
          spellCheck={false}
        />
        <SettingsField
          label="Read-write access key ID"
          description="Used by builders only."
          value={draft.accessKeyId}
          onChange={set("accessKeyId")}
          error={show("accessKeyId")}
          autoComplete="off"
          inputClassName="font-mono"
          spellCheck={false}
        />
        <SettingsField
          label="Read-write secret"
          description={
            storage.secrets_set
              ? "Stored and never shown. Leave empty to keep it."
              : "Stored write-only; it is never shown again."
          }
          type="password"
          value={draft.secret}
          onChange={set("secret")}
          error={show("secret")}
          placeholder={storage.secrets_set ? "••••••••••••" : undefined}
          autoComplete="new-password"
          inputClassName="font-mono"
        />
        <SettingsField
          label="Read-only access key ID"
          description="Used by every other server; give it read access only (an R2 Object Read only token)."
          value={draft.readonlyKeyId}
          onChange={set("readonlyKeyId")}
          error={show("readonlyKeyId")}
          autoComplete="off"
          inputClassName="font-mono"
          spellCheck={false}
        />
        <SettingsField
          label="Read-only secret"
          description={
            storage.secrets_set
              ? "Stored and never shown. Leave empty to keep it."
              : "Stored write-only; it is never shown again."
          }
          type="password"
          value={draft.readonlySecret}
          onChange={set("readonlySecret")}
          error={show("readonlySecret")}
          placeholder={storage.secrets_set ? "••••••••••••" : undefined}
          autoComplete="new-password"
          inputClassName="font-mono"
        />
      </SettingsSection>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        onDiscard={() => {
          setDraft(draftOf(storage));
          setSubmitted(false);
          setError(null);
        }}
      />
      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={(open) => {
          setConfirmingRemove(open);
          if (!open) remove.reset();
        }}
        title="Keep builds on the builder's disk?"
        description="New builds go to each workspace's builder again, and other servers pull them through it over the private network. Images already in the bucket stay there; redeploy services built before to rebuild them."
        confirmLabel="Use builder disk"
        pending={remove.isPending}
        error={remove.isError ? saveError(remove.error) : null}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: (next) => {
              setConfirmingRemove(false);
              setDraft(draftOf(next));
              toast({ title: "Builds stay on the builder's disk", tone: "success" });
            },
          })
        }
      />
    </form>
  );
}

/**
 * The instance's registry bucket as a settings form.
 *
 * @returns The section.
 */
export function RegistryStorageSection() {
  const storage = useRegistryStorage();
  if (storage.isPending) return <Skeleton className="h-56 rounded-lg" />;
  if (storage.isError) {
    return (
      <ErrorState message={errorMessage(storage.error)} onRetry={() => void storage.refetch()} />
    );
  }
  return <StorageForm storage={storage.data} />;
}
