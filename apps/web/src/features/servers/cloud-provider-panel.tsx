import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "@roundhouse/providers";
import { Badge, Button, cn, Label, Select, Skeleton } from "@roundhouse/ui";
import { RefreshCwIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { FormField } from "../../components/form-field";
import { errorMessage } from "../../lib/api/client";
import type { ProviderOffer } from "../../lib/api/providers-types";
import { useIntegrations, useProviderOffers, useProvisionNode } from "../../queries/providers";
import { BuilderCheckbox } from "./builder-checkbox";
import {
  defaultOffer,
  formatMonthlyPrice,
  formatPlanSize,
  groupOffersByPlan,
  nodeNameError,
  type OfferPlan,
} from "./cloud-offers";
import { defaultNodeName } from "./install-methods";
import { ProviderConnection } from "./provider-connection";
import { ProvisionStatus } from "./provision-status";

/** Props for {@link CloudProviderPanel}. */
export interface CloudProviderPanelProps {
  /** Workspace the new server joins. */
  workspaceId: string;
  /** Whether the server joins as a builder; shared with the other tabs. */
  builder: boolean;
  /** Called when the builder toggle changes. */
  onBuilderChange: (builder: boolean) => void;
  /** Label of the button shown after the server joined. */
  doneLabel: string;
  /** Called when the user finishes after the server joined. */
  onDone: () => void;
  /** Poll interval for the provisioning run (tests). */
  pollIntervalMs?: number;
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="grid justify-items-start gap-2">
      <p className="text-sm text-danger">{message}</p>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        <RefreshCwIcon />
        Try again
      </Button>
    </div>
  );
}

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 py-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
      {htmlFor ? (
        <Label htmlFor={htmlFor} className="sm:pt-1.5">
          {label}
        </Label>
      ) : (
        <p className="text-sm font-medium text-foreground sm:pt-1.5">{label}</p>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * Creates a server at a cloud provider in one click: pick a provider, connect it with a
 * write-only API token if needed, pick a plan and region from its live offers (the
 * recommended one preselected), name the server, and follow the run until it joins.
 *
 * @param props - Workspace, the shared builder toggle and completion handlers.
 * @returns The panel.
 */
export function CloudProviderPanel({
  workspaceId,
  builder,
  onBuilderChange,
  doneLabel,
  onDone,
  pollIntervalMs,
}: CloudProviderPanelProps) {
  const integrations = useIntegrations(workspaceId);
  const [picked, setPicked] = useState<ProviderId | null>(null);
  const [provisionId, setProvisionId] = useState<string | null>(null);
  const providerSelectId = useId();

  if (provisionId) {
    return (
      <ProvisionStatus
        workspaceId={workspaceId}
        provisionId={provisionId}
        doneLabel={doneLabel}
        onDone={onDone}
        onRetry={() => setProvisionId(null)}
        pollIntervalMs={pollIntervalMs}
      />
    );
  }

  if (integrations.isPending) {
    return (
      <div className="grid gap-3" role="status" aria-label="Loading cloud providers">
        <Skeleton className="h-8" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (integrations.isError) {
    return (
      <InlineError
        message={errorMessage(integrations.error)}
        onRetry={() => void integrations.refetch()}
      />
    );
  }

  const list = integrations.data;
  const provider =
    picked ?? list.find((entry) => entry.connected)?.provider ?? (PROVIDER_IDS[0] as ProviderId);
  const integration = list.find((entry) => entry.provider === provider);

  return (
    <div className="grid divide-y divide-border/70 border-y border-border/70">
      <Row label="Provider" htmlFor={providerSelectId}>
        <Select
          id={providerSelectId}
          value={provider}
          onChange={(event) => setPicked(event.target.value as ProviderId)}
          className="h-8 w-full sm:w-64"
        >
          {PROVIDER_IDS.map((id) => {
            const connected = list.some((entry) => entry.provider === id && entry.connected);
            return (
              <option key={id} value={id}>
                {PROVIDERS[id].displayName}
                {connected ? " · connected" : ""}
              </option>
            );
          })}
        </Select>
      </Row>
      <Row label="API token">
        {integration ? (
          <ProviderConnection workspaceId={workspaceId} integration={integration} />
        ) : null}
      </Row>
      {integration?.connected ? (
        <CreateServerForm
          key={provider}
          workspaceId={workspaceId}
          provider={provider}
          builder={builder}
          onBuilderChange={onBuilderChange}
          onStarted={setProvisionId}
        />
      ) : null}
    </div>
  );
}

function CreateServerForm({
  workspaceId,
  provider,
  builder,
  onBuilderChange,
  onStarted,
}: {
  workspaceId: string;
  provider: ProviderId;
  builder: boolean;
  onBuilderChange: (builder: boolean) => void;
  onStarted: (provisionId: string) => void;
}) {
  const role = builder ? "builder" : "node";
  const offers = useProviderOffers(workspaceId, provider, role);
  const provision = useProvisionNode(workspaceId);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [name, setName] = useState(() => defaultNodeName());
  const regionId = useId();
  const trimmed = name.trim();
  const nameProblem = nodeNameError(trimmed);

  const data = offers.data;
  const selected = data
    ? (data.offers.find((offer) => offer.id === pickedId) ??
      defaultOffer(data.offers, data.recommendations))
    : undefined;
  const plans = data ? groupOffersByPlan(data.offers, data.recommendations) : [];
  const plan = plans.find((entry) => entry.plan === selected?.plan);

  function pickPlan(next: OfferPlan) {
    const sameRegion = next.offers.find((offer) => offer.region === selected?.region);
    const recommended = data
      ? data.recommendations
          .map((entry) => next.offers.find((offer) => offer.id === entry.offer_id))
          .find(Boolean)
      : undefined;
    setPickedId((sameRegion ?? recommended ?? next.cheapest).id);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!selected || nameProblem) return;
    provision.mutate(
      { provider, plan: selected.plan, region: selected.region, name: trimmed, builder },
      { onSuccess: (run) => onStarted(run.id) },
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid divide-y divide-border/70" aria-label="New server">
      <Row label="Role">
        <BuilderCheckbox
          checked={builder}
          onChange={(next) => {
            setPickedId(null);
            onBuilderChange(next);
          }}
          hint="Also builds images from git repositories; plans are suggested with room for builds."
        />
      </Row>
      <Row label="Plan">
        {offers.isPending ? (
          <div className="grid gap-2" role="status" aria-label="Loading plans">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : offers.isError ? (
          <InlineError message={errorMessage(offers.error)} onRetry={() => void offers.refetch()} />
        ) : plans.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {PROVIDERS[provider].displayName} has no plans that fit this role right now.
          </p>
        ) : (
          <PlanList plans={plans} selected={selected} onPick={pickPlan} />
        )}
      </Row>
      {plan && selected ? (
        <Row label="Region" htmlFor={regionId}>
          <Select
            id={regionId}
            value={selected.id}
            onChange={(event) => setPickedId(event.target.value)}
            className="h-8 w-full sm:w-72"
          >
            {plan.offers.map((offer) => (
              <option key={offer.id} value={offer.id}>
                {offer.region_name} ({offer.region}) ·{" "}
                {formatMonthlyPrice(offer.monthly_cents, offer.currency)}
              </option>
            ))}
          </Select>
        </Row>
      ) : null}
      <div className="py-3">
        <FormField
          label="Server name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={nameProblem}
          hint="Lowercase letters, digits and hyphens. Also the name at the provider."
          inputClassName="font-mono"
          className="grid content-start gap-1.5 sm:max-w-72"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="grid gap-2 py-3">
        {provision.isError ? (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(provision.error)}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {selected ? (
              <>
                <span className="font-mono text-foreground">{selected.plan}</span> in{" "}
                {selected.region_name} ·{" "}
                <span className="tabular-nums text-foreground">
                  {formatMonthlyPrice(selected.monthly_cents, selected.currency)}
                </span>
                , billed by {PROVIDERS[provider].displayName}
              </>
            ) : null}
          </p>
          <Button
            type="submit"
            variant="primary"
            loading={provision.isPending}
            disabled={!selected || nameProblem !== null}
          >
            Create server
          </Button>
        </div>
      </div>
    </form>
  );
}

function PlanList({
  plans,
  selected,
  onPick,
}: {
  plans: readonly OfferPlan[];
  selected: ProviderOffer | undefined;
  onPick: (plan: OfferPlan) => void;
}) {
  const group = useId();
  return (
    <div
      role="radiogroup"
      aria-label="Plan"
      className="max-h-72 divide-y divide-border/70 overflow-y-auto rounded-md border border-border"
    >
      {plans.map((plan) => {
        const checked = plan.plan === selected?.plan;
        const price = checked && selected ? selected : plan.cheapest;
        const varies = plan.offers.some(
          (offer) => offer.monthly_cents !== plan.cheapest.monthly_cents,
        );
        return (
          <label
            key={plan.plan}
            className={cn(
              "flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50",
              checked && "bg-accent-subtle/60",
            )}
          >
            <input
              type="radio"
              name={group}
              value={plan.plan}
              checked={checked}
              onChange={() => onPick(plan)}
              className="mt-1 accent-accent"
            />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-foreground">{plan.plan}</span>
                {plan.recommendation ? <Badge tone="accent">Recommended</Badge> : null}
                {plan.cheapest.deprecated ? <Badge tone="warning">Deprecated</Badge> : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatPlanSize(plan)} · {plan.arch}
                {plan.dedicated ? " · dedicated" : ""}
              </span>
              {plan.recommendation ? (
                <span className="text-xs text-accent-text">{plan.recommendation}</span>
              ) : null}
            </span>
            <span className="shrink-0 text-right text-sm tabular-nums text-foreground">
              {!checked && varies ? (
                <span className="text-xs text-muted-foreground">from </span>
              ) : null}
              {formatMonthlyPrice(price.monthly_cents, price.currency)}
            </span>
          </label>
        );
      })}
    </div>
  );
}
