import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Kpi, KpiStrip } from "./kpi-strip";
import {
  ChoiceCards,
  DangerZone,
  SaveBar,
  SettingsLayout,
  SettingsNav,
  SettingsNavGroup,
  SettingsNavItem,
  SettingsRow,
  SettingsSection,
  SettingsStack,
} from "./settings";

function Nav() {
  return (
    <SettingsNav label="Settings">
      <SettingsNavGroup label="Workspace">
        <SettingsNavItem href="/general" aria-current="page">
          General
        </SettingsNavItem>
        <SettingsNavItem href="/members">Members</SettingsNavItem>
      </SettingsNavGroup>
      <SettingsNavGroup label="Preferences" defaultOpen={false}>
        <SettingsNavItem href="/appearance">Appearance</SettingsNavItem>
      </SettingsNavGroup>
    </SettingsNav>
  );
}

describe("SettingsLayout and SettingsNav", () => {
  it("renders a named navigation landmark beside the content", () => {
    render(
      <SettingsLayout nav={<Nav />}>
        <p>View</p>
      </SettingsLayout>,
    );
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(within(nav).getByRole("link", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("View")).toBeInTheDocument();
  });

  it("collapses and expands a group", async () => {
    render(<Nav />);
    const toggle = screen.getByRole("button", { name: "Preferences" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const list = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(list?.className).toContain("lg:hidden");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(list?.className).not.toContain("lg:hidden");
  });

  it("merges item classes onto a router link with asChild", () => {
    render(
      <ul>
        <SettingsNavItem asChild>
          <a href="/x" data-router="yes">
            Router link
          </a>
        </SettingsNavItem>
      </ul>,
    );
    const link = screen.getByRole("link", { name: "Router link" });
    expect(link).toHaveAttribute("data-router", "yes");
    expect(link.className).toContain("aria-[current=page]:text-foreground");
  });
});

describe("SettingsSection and SettingsRow", () => {
  it("labels the section by its heading and the control by the row label", () => {
    render(
      <SettingsStack>
        <SettingsSection title="Deploy" description="How the service runs.">
          <SettingsRow label="Replicas" description="0 stops the service." htmlFor="replicas">
            <input id="replicas" aria-describedby="replicas-description" />
          </SettingsRow>
        </SettingsSection>
      </SettingsStack>,
    );
    expect(screen.getByRole("region", { name: "Deploy" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Deploy" })).toBeInTheDocument();
    expect(screen.getByLabelText("Replicas")).toHaveAccessibleDescription("0 stops the service.");
  });

  it("keeps a switch beside its label at every width", () => {
    const { container } = render(
      <SettingsRow label="Generated domain" control="switch">
        <button type="button" role="switch" aria-checked="true" aria-label="Generated domain" />
      </SettingsRow>,
    );
    expect(container.firstElementChild?.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
  });

  it("renders a danger zone as a titled section", () => {
    render(
      <DangerZone>
        <SettingsRow label="Delete service" description="Stops every replica.">
          <button type="button">Delete service</button>
        </SettingsRow>
      </DangerZone>,
    );
    expect(screen.getByRole("heading", { name: "Danger zone" })).toBeInTheDocument();
  });
});

describe("SaveBar", () => {
  it("disables Save and hides the bar while clean", () => {
    render(
      <form>
        <SaveBar dirty={false} onDiscard={() => {}} />
      </form>,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();
  });

  it("shows unsaved changes with Discard, and submits the form on Save", async () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    const onDiscard = vi.fn();
    const { container } = render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent)}>
        <SaveBar dirty onDiscard={onDiscard} saveLabel="Save changes" />
      </form>,
    );
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(container.querySelector("[data-dirty]")?.className).toContain("sticky");
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

function Theme() {
  const [value, setValue] = useState<"light" | "dark" | "system">("dark");
  return (
    <ChoiceCards
      label="Theme"
      value={value}
      onValueChange={setValue}
      options={[
        { value: "light", label: "Light", preview: <div>light preview</div> },
        { value: "dark", label: "Dark" },
        { value: "system", label: "System", description: "Follows the OS" },
      ]}
    />
  );
}

describe("ChoiceCards", () => {
  it("is a radio group named by its legend", async () => {
    render(<Theme />);
    const group = screen.getByRole("group", { name: "Theme" });
    expect(within(group).getByRole("radio", { name: "Dark" })).toBeChecked();
    await userEvent.click(within(group).getByText("Light"));
    expect(within(group).getByRole("radio", { name: "Light" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Dark" })).not.toBeChecked();
  });

  it("moves the selection with arrow keys", async () => {
    render(<Theme />);
    screen.getByRole("radio", { name: "Dark" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: /System/ })).toBeChecked();
  });
});

describe("KpiStrip", () => {
  it("names each figure so it can be found on its own", () => {
    render(
      <KpiStrip label="At a glance">
        <Kpi label="Servers online" value="3" unit="of 4" sub="1 pending" />
        <Kpi label="Incidents" value="0" alert />
      </KpiStrip>,
    );
    const strip = screen.getByRole("group", { name: "At a glance" });
    expect(within(strip).getByRole("region", { name: "Servers online" })).toHaveTextContent(
      "Servers online3 of 41 pending",
    );
    expect(within(strip).getByText("0").className).toContain("text-danger");
  });
});
