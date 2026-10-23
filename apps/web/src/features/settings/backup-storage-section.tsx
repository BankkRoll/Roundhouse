import { Badge, SaveBar, SettingsSection, Skeleton, toast } from "@roundhouse/ui";
import { type FormEvent, useState } from "react";
import { ErrorState } from "../../components/error-state";
import { SettingsField } from "../../components/settings-field";
import type { BackupStorage } from "../../lib/api/backups-client";
import { errorMessage, isApiError } from "../../lib/api/client";
import { useBackupStorage, useSaveBackupStorage } from "../../queries/backups";

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,32}$/;

interface Draft {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secret: string;
}

function draftOf(storage: BackupStorage): Draft {
  return {
    endpoint: storage.endpoint ?? "",
    bucket: storage.bucket ?? "",
    region: storage.region ?? "",
    accessKeyId: storage.access_key_id ?? "",
    secret: "",
  };
}

function validate(draft: Draft, secretSet: boolean): Partial<Record<keyof Draft, string>> {
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
  if (!draft.accessKeyId.trim()) errors.accessKeyId = "Enter the access key ID.";
  if (!secretSet && !draft.secret) errors.secret = "Enter the secret access key.";
  return errors;
}

function StorageForm({ storage }: { storage: BackupStorage }) {
  const save = useSaveBackupStorage();
  const [draft, setDraft] = useState(() => draftOf(storage));
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = validate(draft, storage.secret_access_key_set);
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
      },
      {
        onSuccess: (next) => {
          setDraft(draftOf(next));
          setSubmitted(false);
          toast({ title: "Backup storage saved", tone: "success" });
        },
        onError: (cause) =>
          setError(
            isApiError(cause, "reauth_required")
              ? `${errorMessage(cause)} Sign in again, then retry.`
              : errorMessage(cause),
          ),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Backup storage">
      <SettingsSection
        id="backup-storage"
        title="Backup storage"
        description="An S3-compatible bucket (Cloudflare R2 by default) that every database backup is uploaded to, encrypted. Saving checks that the credentials can reach it."
        className="scroll-mt-20"
        actions={
          <Badge tone={storage.configured ? "success" : "warning"}>
            {storage.configured ? "Configured" : "Not set up"}
          </Badge>
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
          placeholder="roundhouse-backups"
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
          label="Access key ID"
          value={draft.accessKeyId}
          onChange={set("accessKeyId")}
          error={show("accessKeyId")}
          autoComplete="off"
          inputClassName="font-mono"
          spellCheck={false}
        />
        <SettingsField
          label="Secret access key"
          description={
            storage.secret_access_key_set
              ? "Stored and never shown. Leave empty to keep it."
              : "Stored write-only; it is never shown again."
          }
          type="password"
          value={draft.secret}
          onChange={set("secret")}
          error={show("secret")}
          placeholder={storage.secret_access_key_set ? "••••••••••••" : undefined}
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
    </form>
  );
}

/**
 * The instance's backup bucket as a settings form. The secret access key is write-only:
 * the API only says whether one is stored.
 *
 * @returns The section.
 */
export function BackupStorageSection() {
  const storage = useBackupStorage();
  if (storage.isPending) return <Skeleton className="h-56 rounded-lg" />;
  if (storage.isError) {
    return (
      <ErrorState message={errorMessage(storage.error)} onRetry={() => void storage.refetch()} />
    );
  }
  return <StorageForm storage={storage.data} />;
}
