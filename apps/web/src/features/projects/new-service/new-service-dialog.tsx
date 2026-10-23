import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  toast,
} from "@roundhouse/ui";
import { SegmentedControl, Switch } from "@roundhouse/ui/controls";
import { useNavigate } from "@tanstack/react-router";
import { ContainerIcon, DatabaseIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { FormField } from "../../../components/form-field";
import { GithubIcon } from "../../../components/github-mark";
import { errorMessage } from "../../../lib/api/client";
import type { GithubRepository, ServiceSource } from "../../../lib/api/deploy-types";
import { usePermissions } from "../../../lib/permissions";
import { useDeploy } from "../../../queries/deployments";
import { useGithubRepositories, useGithubStatus } from "../../../queries/instance";
import { pickEnvironment, useProject } from "../../../queries/projects";
import { useCreateService } from "../../../queries/services";
import {
  DatabaseFields,
  DatabaseReview,
  initialDatabaseDraft,
  parseVolumeSize,
} from "../../databases/new-database";
import { StepIndicator } from "../../setup/step-indicator";
import { RepoPicker } from "./repo-picker";
import {
  branchError,
  gitUrlError,
  imageReferenceError,
  MAX_SERVICE_NAME,
  parsePort,
  rootDirError,
  suggestServiceName,
} from "./source";

type SourceKind = "image" | "git" | "database";
type GitMode = "connected" | "url";

/** Props for {@link NewServiceDialog}. */
export interface NewServiceDialogProps {
  workspaceId: string;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function SourceOption({
  value,
  checked,
  onChange,
  name,
  icon,
  title,
  description,
}: {
  value: SourceKind;
  checked: boolean;
  onChange: (value: SourceKind) => void;
  name: string;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background p-3 transition-colors hover:border-border-strong has-focus-visible:ring-2 has-focus-visible:ring-ring",
        checked && "border-accent-text bg-accent-subtle",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="sr-only"
      />
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="grid gap-0.5">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

/**
 * The new-service flow: pick a source (a Docker image, or a GitHub repository from the
 * workspace's installations or any public HTTPS URL), then name it, set its port and
 * generated domain, and optionally deploy it straight away.
 *
 * @param props - Workspace, project and controlled open state.
 * @returns The dialog.
 */
export function NewServiceDialog({
  workspaceId,
  projectId,
  open,
  onOpenChange,
}: NewServiceDialogProps) {
  const navigate = useNavigate();
  const { can } = usePermissions(workspaceId);
  const project = useProject(projectId);
  const create = useCreateService(projectId);
  const deploy = useDeploy();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<SourceKind>("image");
  const [image, setImage] = useState("");
  const [gitMode, setGitMode] = useState<GitMode>("connected");
  const [repo, setRepo] = useState<GithubRepository | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [rootDir, setRootDir] = useState(".");
  const [name, setName] = useState<string | null>(null);
  const [port, setPort] = useState("8080");
  const [generatedDomain, setGeneratedDomain] = useState(true);
  const [deployNow, setDeployNow] = useState(can("deployments:create"));
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const sourceName = useId();
  const domainId = useId();
  const deployId = useId();
  const [database, setDatabase] = useState(initialDatabaseDraft);
  const [databaseSubmitted, setDatabaseSubmitted] = useState(false);
  const canAddDatabase = can("variables:manage");
  const environments = project.data?.environments ?? [];

  const github = useGithubStatus(workspaceId, kind === "git");
  const configured = github.data?.configured ?? false;
  const repositories = useGithubRepositories(workspaceId, kind === "git" && configured);
  const mode: GitMode = configured ? gitMode : "url";
  const sourceText =
    kind === "image" ? image : mode === "connected" ? (repo?.full_name ?? "") : repoUrl;
  const serviceName = name ?? suggestServiceName(sourceText);
  const pending = create.isPending || deploy.isPending;

  function buildSource(): ServiceSource | null {
    const next: Record<string, string | undefined> = {};
    let source: ServiceSource | null = null;
    if (kind === "image") {
      next.image = imageReferenceError(image) ?? undefined;
      source = { type: "image", image: image.trim() };
    } else if (kind === "database") {
      return null;
    } else if (mode === "connected") {
      if (!repo) next.repo = "Choose a repository.";
      next.branch = branchError(branch) ?? undefined;
      next.rootDir = rootDirError(rootDir) ?? undefined;
      source = repo
        ? {
            type: "git",
            repo_url: repo.clone_url,
            branch: branch.trim(),
            root_dir: rootDir.trim(),
            github_installation_id: repo.installation_id,
          }
        : null;
    } else {
      next.repoUrl = gitUrlError(repoUrl) ?? undefined;
      next.branch = branchError(branch) ?? undefined;
      next.rootDir = rootDirError(rootDir) ?? undefined;
      source = {
        type: "git",
        repo_url: repoUrl.trim(),
        branch: branch.trim(),
        root_dir: rootDir.trim(),
      };
    }
    setErrors(next);
    return Object.values(next).some(Boolean) ? null : source;
  }

  function onNext(event: FormEvent) {
    event.preventDefault();
    if (kind === "database") {
      setDatabaseSubmitted(true);
      if (typeof parseVolumeSize(database.sizeGib) === "number") setStep(2);
      return;
    }
    if (buildSource()) setStep(2);
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    const source = buildSource();
    if (!source) {
      setStep(1);
      return;
    }
    const parsedPort = parsePort(port);
    const nameError = serviceName.trim() ? undefined : "Enter a service name.";
    const portError = typeof parsedPort === "string" ? parsedPort : undefined;
    setErrors({ name: nameError, port: portError });
    if (nameError || portError) return;
    setSubmitError(null);
    try {
      const { service } = await create.mutateAsync({
        name: serviceName.trim(),
        source,
        config: {
          networking: {
            port: parsedPort as number | null,
            generated_domain: parsedPort !== null && generatedDomain,
          },
        },
      });
      const environment = project.data ? pickEnvironment(project.data.environments) : undefined;
      let deployed = false;
      if (deployNow && environment) {
        try {
          await deploy.mutateAsync({ serviceId: service.id, environmentId: environment.id });
          deployed = true;
        } catch (cause) {
          toast({
            title: `${service.name} was created, but the deploy failed to start`,
            description: errorMessage(cause),
            tone: "error",
          });
        }
      }
      toast({
        title: deployed ? `Deploying ${service.name}` : `Created ${service.name}`,
        tone: "success",
      });
      onOpenChange(false);
      await navigate({
        to: "/w/$workspaceId/p/$projectId/s/$serviceId/deployments",
        params: { workspaceId, projectId, serviceId: service.id },
      });
    } catch (cause) {
      setSubmitError(errorMessage(cause));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New service</DialogTitle>
          <DialogDescription>
            {step === 1
              ? "Where does the code come from?"
              : kind === "database"
                ? "Review what will be added. Credentials are generated by the server."
                : "How it runs. Everything here can be changed later in Settings."}
          </DialogDescription>
        </DialogHeader>
        <StepIndicator
          steps={["Source", kind === "database" ? "Review" : "Configure"]}
          current={step}
          label="New service progress"
        />

        {step === 1 ? (
          <form onSubmit={onNext} className="grid gap-4" noValidate>
            <fieldset
              className={cn("grid gap-2 sm:grid-cols-2", canAddDatabase && "sm:grid-cols-3")}
            >
              <legend className="sr-only">Source</legend>
              <SourceOption
                name={sourceName}
                value="image"
                checked={kind === "image"}
                onChange={setKind}
                icon={<ContainerIcon />}
                title="Docker image"
                description="Run a public or private image as-is."
              />
              <SourceOption
                name={sourceName}
                value="git"
                checked={kind === "git"}
                onChange={setKind}
                icon={<GithubIcon />}
                title="GitHub repository"
                description="Build with Railpack or your Dockerfile."
              />
              {canAddDatabase ? (
                <SourceOption
                  name={sourceName}
                  value="database"
                  checked={kind === "database"}
                  onChange={setKind}
                  icon={<DatabaseIcon />}
                  title="Database"
                  description="PostgreSQL, MySQL, Valkey or MongoDB with a volume."
                />
              ) : null}
            </fieldset>

            {kind === "database" ? (
              <DatabaseFields
                draft={database}
                onChange={setDatabase}
                sizeError={
                  databaseSubmitted && typeof parseVolumeSize(database.sizeGib) === "string"
                    ? (parseVolumeSize(database.sizeGib) as string)
                    : null
                }
              />
            ) : kind === "image" ? (
              <FormField
                label="Image"
                value={image}
                onChange={(event) => setImage(event.target.value)}
                placeholder="ghcr.io/owner/api:1.4.2"
                error={errors.image}
                hint="Docker Hub names like nginx:1.27 work too."
                inputClassName="font-mono"
                autoFocus
                spellCheck={false}
                autoComplete="off"
              />
            ) : (
              <div className="grid gap-3">
                {configured ? (
                  <SegmentedControl<GitMode>
                    label="Repository source"
                    value={mode}
                    onValueChange={setGitMode}
                    options={[
                      { value: "connected", label: "Connected repositories" },
                      { value: "url", label: "Public Git URL" },
                    ]}
                  />
                ) : (
                  <p className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                    No GitHub App is connected, so only public repositories can be built.
                    {can("instance:manage")
                      ? " Create one in Platform settings to use private repositories."
                      : ""}
                  </p>
                )}
                {mode === "connected" ? (
                  <div className="grid gap-1.5">
                    <RepoPicker
                      repositories={repositories.data}
                      loading={repositories.isPending}
                      selectedId={repo?.id ?? null}
                      onSelect={(selected) => {
                        setRepo(selected);
                        setBranch(selected.default_branch);
                      }}
                    />
                    {errors.repo ? (
                      <p role="alert" className="text-xs text-danger">
                        {errors.repo}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <FormField
                    label="Repository URL"
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                    placeholder="https://github.com/owner/app.git"
                    error={errors.repoUrl}
                    spellCheck={false}
                    autoComplete="off"
                    autoFocus
                  />
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField
                    label="Branch"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    error={errors.branch}
                    hint="Pushes to it deploy the service."
                    spellCheck={false}
                  />
                  <FormField
                    label="Root directory"
                    value={rootDir}
                    onChange={(event) => setRootDir(event.target.value)}
                    error={errors.rootDir}
                    hint=". is the repository root."
                    spellCheck={false}
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary">
                Continue
              </Button>
            </DialogFooter>
          </form>
        ) : kind === "database" ? (
          <DatabaseReview
            workspaceId={workspaceId}
            projectId={projectId}
            draft={database}
            environments={environments}
            defaultEnvironmentId={project.data ? pickEnvironment(environments)?.id : undefined}
            canDeploy={can("deployments:create")}
            onBack={() => setStep(1)}
            onCreated={() => onOpenChange(false)}
          />
        ) : (
          <form onSubmit={onCreate} className="grid gap-4" noValidate>
            <p className="truncate rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground">
              {kind === "image" ? "image" : "git"} · {sourceText}
            </p>
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <FormField
                label="Service name"
                value={serviceName}
                onChange={(event) => setName(event.target.value)}
                error={errors.name}
                maxLength={MAX_SERVICE_NAME}
                hint={`Other services reference its variables as \${{${suggestServiceName(serviceName) || "name"}.VAR}}.`}
                autoFocus
              />
              <FormField
                label="Port"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                error={errors.port}
                inputMode="numeric"
                hint="Empty for workers."
              />
            </div>
            <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-background px-3 py-2.5">
              <div className="grid gap-0.5">
                <Label htmlFor={domainId} className="text-sm text-foreground">
                  Generated domain
                </Label>
                <p className="text-xs text-muted-foreground">
                  A public https hostname under the instance's apps domain.
                </p>
              </div>
              <Switch
                id={domainId}
                checked={generatedDomain && parsePort(port) !== null}
                disabled={parsePort(port) === null}
                onCheckedChange={setGeneratedDomain}
              />
            </div>
            {can("deployments:create") ? (
              <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-background px-3 py-2.5">
                <div className="grid gap-0.5">
                  <Label htmlFor={deployId} className="text-sm text-foreground">
                    Deploy now
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Otherwise add variables first and deploy from the service page.
                  </p>
                </div>
                <Switch id={deployId} checked={deployNow} onCheckedChange={setDeployNow} />
              </div>
            ) : null}
            {submitError ? (
              <p role="alert" className="text-sm text-danger">
                {submitError}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="secondary" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button type="submit" variant="primary" loading={pending}>
                {deployNow && can("deployments:create") ? "Create and deploy" : "Create service"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
