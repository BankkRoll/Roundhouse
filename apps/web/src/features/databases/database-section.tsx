import {
  DATABASE_ENGINE_SPECS,
  READONLY_PASSWORD_VARIABLE,
  type ServiceDatabaseEngine,
} from "@roundhouse/shared";
import { Badge, SettingsRow, SettingsSection } from "@roundhouse/ui";
import type { Environment, Service } from "../../lib/api/deploy-types";
import { useServiceVariables } from "../../queries/variables";
import { useEnvironmentGate } from "../access/environment-gate";
import { CopyButton } from "./copy-button";
import { CredentialRotationRows } from "./credential-rotation";
import {
  databaseVariableNames,
  databaseVersionLabel,
  privateHostname,
  variableReference,
} from "./database-meta";

/** Props for {@link DatabaseSection}. */
export interface DatabaseSectionProps {
  workspaceId: string;
  /** A database service: `database` is set. */
  service: Service & { database: { engine: ServiceDatabaseEngine; version: string } };
  environment: Environment | undefined;
}

/**
 * A database service's engine and how other services connect to it, as settings rows:
 * the private host and port, and each connection variable as a `${{slug.KEY}}` reference
 * with a copy button. Plain values (a user name) are shown; secret ones only by their
 * fingerprint, since the API never returns them. Credentials can be rotated from here.
 *
 * @param props - Workspace, the database service and the selected environment.
 * @returns The section.
 */
export function DatabaseSection({ workspaceId, service, environment }: DatabaseSectionProps) {
  const { can } = useEnvironmentGate(workspaceId, service.project_id, environment);
  const { engine, version } = service.database;
  const spec = DATABASE_ENGINE_SPECS[engine];
  const variables = useServiceVariables(service.id, environment?.id, can("variables:read"));
  const byKey = new Map((variables.data ?? []).map((v) => [v.key, v]));
  const names = databaseVariableNames(engine).sort((a, b) =>
    a.key === spec.connectionVariable ? -1 : b.key === spec.connectionVariable ? 1 : 0,
  );
  const host = environment ? privateHostname(service.slug, environment.slug) : null;

  return (
    <SettingsSection
      id="database"
      title="Database"
      description="Reachable only on the project's private network. Other services connect through references, so they follow the credentials wherever they are used."
      className="scroll-mt-20"
      actions={<Badge tone="neutral">{spec.name}</Badge>}
    >
      <SettingsRow
        label="Engine"
        description={
          engine === "redis"
            ? "Valkey is the default Redis-compatible engine; clients that speak Redis work unchanged."
            : undefined
        }
      >
        <p className="text-sm text-foreground md:text-right">
          {databaseVersionLabel(engine, version)}
        </p>
      </SettingsRow>
      <SettingsRow label="Private host" description="Resolves inside this environment only.">
        {host ? (
          <div className="flex items-center gap-1 md:justify-end">
            <code className="truncate font-mono text-sm text-foreground">
              {host}:{spec.port}
            </code>
            <CopyButton value={`${host}:${spec.port}`} label="Private host" />
          </div>
        ) : null}
      </SettingsRow>
      <SettingsRow
        label="Connection variables"
        description={
          <>
            Paste a reference into another service's variables, e.g.{" "}
            <code className="font-mono text-foreground">
              {variableReference(service.slug, spec.connectionVariable)}
            </code>
            . Secret values are write-only and shown by fingerprint.
          </>
        }
        control="wide"
      >
        <ul aria-label="Connection variables" className="divide-y divide-border/70">
          {names
            .filter((name) => name.key !== READONLY_PASSWORD_VARIABLE)
            .map((name) => {
              const stored = byKey.get(name.key);
              const reference = variableReference(service.slug, name.key);
              return (
                <li
                  key={name.key}
                  className="grid gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-center"
                >
                  <span className="truncate font-mono text-[13px] text-foreground">{name.key}</span>
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {name.secret || stored?.tier === "secret" ? (
                      <>
                        secret
                        {stored?.fingerprint ? (
                          <span title="Fingerprint of the value">
                            {" "}
                            · fp {stored.fingerprint.slice(0, 8)}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      (stored?.value ?? "plain")
                    )}
                  </span>
                  <span className="flex items-center gap-1 justify-self-start sm:justify-self-end">
                    <code className="hidden font-mono text-xs text-muted-foreground lg:inline">
                      {reference}
                    </code>
                    <CopyButton value={reference} label={`${name.key} reference`} />
                  </span>
                </li>
              );
            })}
        </ul>
      </SettingsRow>
      <CredentialRotationRows
        workspaceId={workspaceId}
        service={service}
        engine={engine}
        environment={environment}
      />
    </SettingsSection>
  );
}
