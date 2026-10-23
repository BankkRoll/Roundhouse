import { Badge, Button, Skeleton } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ExternalLinkIcon, LockIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ErrorState } from "../../components/error-state";
import { PageHeader } from "../../components/page-header";
import { SectionHeader } from "../../components/section-header";
import { errorMessage, isApiError } from "../../lib/api/client";
import type {
  TemplateDetail,
  TemplateService,
  TemplateVariable,
} from "../../lib/api/templates-types";
import { useTemplate } from "../../queries/templates";
import { DeployTemplateForm } from "./deploy-template-form";
import {
  CATEGORY_LABELS,
  describeTemplateSource,
  requirementsLabel,
  TemplateIcon,
} from "./template-meta";

function BackLink({ workspaceId }: { workspaceId: string }) {
  return (
    <Link
      to="/w/$workspaceId/templates"
      params={{ workspaceId }}
      className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
    >
      <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
      Templates
    </Link>
  );
}

function VariableValue({ variable }: { variable: TemplateVariable }) {
  if (variable.secret) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <LockIcon className="size-3 shrink-0" aria-hidden="true" />
        {variable.generated ? "generated on deploy" : "write-only"}
      </span>
    );
  }
  return <span className="font-mono break-all text-foreground">{variable.value ?? ""}</span>;
}

function VariableList({ label, variables }: { label: string; variables: TemplateVariable[] }) {
  return (
    <ul aria-label={label} className="divide-y divide-border/50">
      {variables.map((variable) => (
        <li
          key={variable.key}
          className="grid gap-x-4 gap-y-0.5 py-1.5 text-xs sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]"
        >
          <span className="truncate font-mono text-foreground" title={variable.key}>
            {variable.key}
          </span>
          <span className="min-w-0">
            <VariableValue variable={variable} />
            {variable.description ? (
              <span className="block text-subtle-foreground">{variable.description}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </>
  );
}

function networkLabel(service: TemplateService): string {
  if (service.port === null) return "No listener";
  return `Port ${service.port} · ${service.public ? "public domain" : "private"}`;
}

function ServiceItem({ service }: { service: TemplateService }) {
  return (
    <li className="py-3.5">
      <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
        <TemplateIcon icon={service.icon} className="size-6 [&_svg]:size-3.5" />
        <span className="truncate">{service.name}</span>
        <span className="truncate font-mono text-xs font-normal text-subtle-foreground">
          {service.ref}
        </span>
      </h3>
      <dl className="mt-2 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        <Fact label="Source">
          <span className="font-mono">{describeTemplateSource(service.source)}</span>
        </Fact>
        <Fact label="Network">{networkLabel(service)}</Fact>
        {service.start_command ? (
          <Fact label="Start command">
            <span className="font-mono">{service.start_command}</span>
          </Fact>
        ) : null}
      </dl>
      {service.variables.length > 0 ? (
        <div className="mt-2.5">
          <p className="mb-0.5 text-xs font-medium text-muted-foreground">Variables</p>
          <VariableList label={`Variables of ${service.name}`} variables={service.variables} />
        </div>
      ) : null}
    </li>
  );
}

function TemplateBody({
  workspaceId,
  template,
}: {
  workspaceId: string;
  template: TemplateDetail;
}) {
  return (
    <>
      <PageHeader
        title={
          <span className="flex min-w-0 items-center gap-2.5">
            <TemplateIcon icon={template.icon} />
            <span className="truncate">{template.name}</span>
          </span>
        }
        subline={`${CATEGORY_LABELS[template.category]} · version ${template.version}`}
        actions={
          template.docs_url ? (
            <Button asChild variant="secondary">
              <a href={template.docs_url} target="_blank" rel="noreferrer noopener">
                Docs
                <ExternalLinkIcon />
              </a>
            </Button>
          ) : undefined
        }
      />
      <p className="-mt-2 mb-8 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        {template.description}
      </p>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] xl:gap-12">
        <div className="grid min-w-0 content-start gap-10">
          <section aria-labelledby="template-services-heading">
            <SectionHeader
              id="template-services-heading"
              title="Services"
              meta={`${template.services.length} created`}
            />
            <ul className="divide-y divide-border/70 border-y border-border/70">
              {template.services.map((service) => (
                <ServiceItem key={service.ref} service={service} />
              ))}
            </ul>
          </section>
          {template.shared_variables.length > 0 ? (
            <section aria-labelledby="template-shared-heading">
              <SectionHeader
                id="template-shared-heading"
                title="Shared variables"
                meta="every service can reference these"
              />
              <div className="border-y border-border/70">
                <VariableList label="Shared variables" variables={template.shared_variables} />
              </div>
            </section>
          ) : null}
        </div>
        <section aria-labelledby="template-deploy-heading" className="min-w-0">
          <SectionHeader id="template-deploy-heading" title="Deploy" />
          {template.supported ? (
            <DeployTemplateForm workspaceId={workspaceId} template={template} />
          ) : (
            <div className="grid gap-2 border-y border-border/70 py-4 text-sm text-muted-foreground">
              <Badge tone="warning" className="justify-self-start">
                {requirementsLabel(template.requirements)}
              </Badge>
              <p>This control plane can't deploy it yet.</p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

/**
 * One template: what it creates (services, sources, ports, variables with secret values
 * withheld) and the form that deploys it into a new or existing project.
 *
 * @param props - Workspace and template ids.
 * @returns The page.
 */
export function TemplateDetailPage({
  workspaceId,
  templateId,
}: {
  workspaceId: string;
  templateId: string;
}) {
  const template = useTemplate(workspaceId, templateId);
  return (
    <>
      <BackLink workspaceId={workspaceId} />
      {template.isPending ? (
        <div className="grid gap-3" role="status" aria-label="Loading template">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-full max-w-xl" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : template.isError ? (
        <ErrorState
          title={isApiError(template.error, 404) ? "Template not found" : "Couldn't load template"}
          message={errorMessage(template.error)}
          onRetry={isApiError(template.error, 404) ? undefined : () => void template.refetch()}
        />
      ) : (
        <TemplateBody workspaceId={workspaceId} template={template.data} />
      )}
    </>
  );
}
