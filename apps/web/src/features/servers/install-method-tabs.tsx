import { CodeBlock, Tabs, TabsContent, TabsList, TabsTrigger } from "@roundhouse/ui";
import { CloudIcon, FileCodeIcon, LaptopIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import { FormField } from "../../components/form-field";
import type { JoinToken } from "../../lib/api/types";
import { BuilderCheckbox } from "./builder-checkbox";
import { CloudProviderPanel } from "./cloud-provider-panel";
import {
  cloudInitUserData,
  defaultNodeName,
  type InstallMethod,
  isLocalOrigin,
  linuxInstallCommand,
  localNodeCommand,
  storeMethod,
} from "./install-methods";

/** Props for {@link InstallMethodTabs}. */
export interface InstallMethodTabsProps {
  /** Workspace the new server joins. */
  workspaceId: string;
  /** The join token the manual tabs use; one per open flow. */
  token: JoinToken;
  /** Origin servers reach the control plane at. */
  origin: string;
  /** Methods to show, in tab order (see `offeredMethods`). */
  offered: readonly InstallMethod[];
  /** Selected method. */
  method: InstallMethod;
  /** Called when another tab is picked. The pick is also remembered. */
  onMethodChange: (method: InstallMethod) => void;
  /** Label of the button shown once a cloud server joined. */
  doneLabel: string;
  /** Called when the user finishes after a cloud server joined. */
  onDone: () => void;
}

function CloudInitPanel({
  origin,
  token,
  builder,
  onBuilderChange,
}: {
  origin: string;
  token: string;
  builder: boolean;
  onBuilderChange: (builder: boolean) => void;
}) {
  const [name, setName] = useState(() => defaultNodeName());
  const result = cloudInitUserData({ origin, token, name: name.trim(), builder });

  if (!result.ok && result.reason === "unreachable_origin") {
    return (
      <div className="grid gap-2 rounded-md border border-border bg-background p-3 text-sm">
        <p className="font-medium text-foreground">Cloud servers can't use this address</p>
        <p className="text-muted-foreground">
          This dashboard is open at <span className="font-mono text-foreground">{origin}</span>.{" "}
          {isLocalOrigin(origin)
            ? "A server at a cloud provider can't reach this computer."
            : "The join has to happen over HTTPS, so install.sh and the token can't be tampered with on the way."}{" "}
          Open the dashboard at its public <span className="font-mono">https://</span> address to
          get cloud-init user data, or use another tab.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        Paste this into the <span className="text-foreground">user data</span> field when you create
        a server at any cloud provider. At first boot it writes the token to a root-only file,
        installs the agent over HTTPS, and shreds the file. The token never appears in a command
        line.
      </p>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-start">
        <FormField
          label="Server name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={result.ok ? null : result.message}
          hint="Lowercase letters, digits and hyphens."
          inputClassName="font-mono"
          spellCheck={false}
          autoComplete="off"
        />
        <div className="sm:pt-6">
          <BuilderCheckbox checked={builder} onChange={onBuilderChange} />
        </div>
      </div>
      {result.ok ? (
        <CodeBlock code={result.userData} label="User data (cloud-config)" scroll />
      ) : null}
    </div>
  );
}

/**
 * The ways to add a server, as tabs: a Linux one-liner, a server created at a connected
 * cloud provider, cloud-init user data for any provider, and a local Docker node (only
 * when the dashboard runs on this machine). The manual tabs share one join token; the
 * cloud tab provisions with its own. The last tab picked is remembered.
 *
 * @param props - Workspace, join token, origin and the controlled method.
 * @returns The tabs.
 */
export function InstallMethodTabs({
  workspaceId,
  token,
  origin,
  offered,
  method,
  onMethodChange,
  doneLabel,
  onDone,
}: InstallMethodTabsProps) {
  const local = offered.includes("local");
  const [builder, setBuilder] = useState(false);

  function choose(next: string) {
    const picked = next as InstallMethod;
    onMethodChange(picked);
    storeMethod(picked);
  }

  return (
    <Tabs value={method} onValueChange={choose} className="grid gap-4">
      <TabsList label="How to add the server">
        <TabsTrigger value="linux">
          <TerminalIcon aria-hidden="true" />
          Linux server
        </TabsTrigger>
        <TabsTrigger value="cloud">
          <CloudIcon aria-hidden="true" />
          Cloud provider
        </TabsTrigger>
        <TabsTrigger value="cloud-init">
          <FileCodeIcon aria-hidden="true" />
          Cloud-init
        </TabsTrigger>
        {local ? (
          <TabsTrigger value="local">
            <LaptopIcon aria-hidden="true" />
            This computer
          </TabsTrigger>
        ) : null}
      </TabsList>
      <TabsContent value="linux" className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Run this on a fresh Linux server with root access. It installs Docker if needed, then the
          agent, which connects back here.
        </p>
        <p className="font-mono text-[11px] text-subtle-foreground">
          Supported: Ubuntu 22.04 and 24.04, Debian 12
        </p>
        <BuilderCheckbox checked={builder} onChange={setBuilder} />
        <CodeBlock
          code={linuxInstallCommand(token.install_command, builder)}
          label="Install command"
          prompt
        />
      </TabsContent>

      <TabsContent value="cloud">
        <CloudProviderPanel
          workspaceId={workspaceId}
          builder={builder}
          onBuilderChange={setBuilder}
          doneLabel={doneLabel}
          onDone={onDone}
        />
      </TabsContent>

      <TabsContent value="cloud-init">
        <CloudInitPanel
          origin={origin}
          token={token.token}
          builder={builder}
          onBuilderChange={setBuilder}
        />
      </TabsContent>

      {local ? (
        <TabsContent value="local" className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            For local development from a clone of the Roundhouse repository: runs a builder node in
            Docker on this computer, next to the control plane from{" "}
            <span className="font-mono text-foreground">pnpm dev</span>.
          </p>
          <CodeBlock code={localNodeCommand(token.token)} label="Run in the repository" prompt />
          <p className="text-xs text-subtle-foreground">
            Needs Docker. Remove it later with{" "}
            <span className="font-mono">pnpm dev:node --down</span>.
          </p>
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
