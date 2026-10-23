/**
 * This browser's preferences, kept in localStorage and never sent to the server:
 *
 * - Appearance: light, dark or system theme, and table density.
 * - Keyboard shortcuts: every real shortcut, read from the same lists that bind them.
 * - Accessibility: reduced motion, overriding the OS setting when chosen.
 *
 * @module
 */
import type { ThemePreference } from "@roundhouse/ui";
import { ChoiceCards, cn, SettingsRow, SettingsSection, SettingsStack } from "@roundhouse/ui";
import { useSyncExternalStore } from "react";
import { isApplePlatform } from "../../lib/platform";
import { type Density, type MotionPreference, usePreferences } from "../../lib/preferences";
import { useTheme } from "../../lib/use-theme";
import { SERVICE_SHORTCUTS } from "../services/tabs";
import { SettingsFrame } from "../settings/settings-frame";
import { NAV_ITEMS } from "../shell/nav";

// -----------------------------------------------------------------------------
// Appearance
// -----------------------------------------------------------------------------

/** The two palettes as fixed colours, so each preview shows its theme whatever is active. */
const PREVIEW = {
  dark: { ground: "#0b0c0d", side: "#111315", line: "#2a2d31", text: "#8a8f98", ink: "#e8eaed" },
  light: { ground: "#ffffff", side: "#f7f7f8", line: "#e4e5e8", text: "#9a9ea6", ink: "#111315" },
} as const;

function MiniScreen({ palette }: { palette: (typeof PREVIEW)["dark" | "light"] }) {
  return (
    <div className="flex h-full" style={{ background: palette.ground }}>
      <div
        className="flex w-1/4 flex-col gap-1.5 p-2"
        style={{ background: palette.side, borderRight: `1px solid ${palette.line}` }}
      >
        <span className="size-2 rounded-[2px]" style={{ background: "#d4f53c" }} />
        <span className="h-1 w-full rounded-full" style={{ background: palette.text }} />
        <span className="h-1 w-3/4 rounded-full" style={{ background: palette.line }} />
        <span className="h-1 w-4/5 rounded-full" style={{ background: palette.line }} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2.5">
        <span className="h-1.5 w-1/2 rounded-full" style={{ background: palette.ink }} />
        <span className="h-1 w-3/4 rounded-full" style={{ background: palette.text }} />
        <span className="mt-1 h-px w-full" style={{ background: palette.line }} />
        <span className="h-1 w-2/3 rounded-full" style={{ background: palette.text }} />
        <span className="h-px w-full" style={{ background: palette.line }} />
        <span className="h-1 w-1/2 rounded-full" style={{ background: palette.text }} />
      </div>
    </div>
  );
}

function ThemePreview({ theme }: { theme: ThemePreference }) {
  if (theme === "system") {
    return (
      <div className="relative h-20">
        <div className="absolute inset-0">
          <MiniScreen palette={PREVIEW.light} />
        </div>
        <div className="absolute inset-0 [clip-path:polygon(0_0,55%_0,45%_100%,0_100%)]">
          <MiniScreen palette={PREVIEW.dark} />
        </div>
      </div>
    );
  }
  return (
    <div className="h-20">
      <MiniScreen palette={PREVIEW[theme]} />
    </div>
  );
}

function DensityPreview({ density }: { density: Density }) {
  const rows = density === "compact" ? 6 : 4;
  return (
    <div className="flex h-20 flex-col justify-center bg-background px-3">
      {Array.from({ length: rows }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing; rows never reorder
          key={index}
          className={cn(
            "flex items-center gap-2 border-border border-b last:border-0",
            density === "compact" ? "py-[3px]" : "py-[5px]",
          )}
        >
          <span className="h-1 w-1/3 rounded-full bg-muted-foreground/60" />
          <span className="ml-auto h-1 w-1/6 rounded-full bg-border-strong" />
        </div>
      ))}
    </div>
  );
}

/**
 * Preferences → Appearance: the theme (light, dark or following the OS) and how tightly
 * tables are set. Both apply at once and stay with this browser.
 *
 * @param props - Workspace id, for the settings navigation.
 * @returns The page.
 */
export function AppearancePage({ workspaceId }: { workspaceId: string }) {
  const theme = useTheme();
  const { density, set } = usePreferences();
  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="Appearance"
      description="How the dashboard looks in this browser. Saved on this device only."
    >
      <SettingsStack>
        <SettingsSection
          title="Theme"
          description={`Dark is the default. System follows your device, which is ${theme.resolved} right now.`}
        >
          <SettingsRow label="Interface theme" control="wide" className="pt-3">
            <ChoiceCards
              label="Interface theme"
              value={theme.preference}
              onValueChange={theme.setPreference}
              className="max-w-xl"
              options={[
                { value: "light", label: "Light", preview: <ThemePreview theme="light" /> },
                { value: "dark", label: "Dark", preview: <ThemePreview theme="dark" /> },
                { value: "system", label: "System", preview: <ThemePreview theme="system" /> },
              ]}
            />
          </SettingsRow>
        </SettingsSection>
        <SettingsSection
          title="Table density"
          description="Row spacing in deployments, members, tokens, the audit log and other tables."
        >
          <SettingsRow label="Rows" control="wide" className="pt-3">
            <ChoiceCards
              label="Table density"
              value={density}
              onValueChange={(next) => set("density", next)}
              className="max-w-md"
              options={[
                {
                  value: "comfortable",
                  label: "Comfortable",
                  description: "More room to scan",
                  preview: <DensityPreview density="comfortable" />,
                },
                {
                  value: "compact",
                  label: "Compact",
                  description: "More rows on screen",
                  preview: <DensityPreview density="compact" />,
                },
              ]}
            />
          </SettingsRow>
        </SettingsSection>
      </SettingsStack>
    </SettingsFrame>
  );
}

// -----------------------------------------------------------------------------
// Keyboard shortcuts
// -----------------------------------------------------------------------------

function Keys({ keys, then = false }: { keys: readonly string[]; then?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {keys.map((key, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: keys can repeat and never reorder
        <span key={index} className="flex items-center gap-1.5">
          {index > 0 ? <span>{then ? "then" : "+"}</span> : null}
          <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border-strong bg-surface px-1.5 font-mono text-xs text-foreground">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  );
}

/**
 * Preferences → Keyboard shortcuts: the command palette, the "G then <key>" jumps and
 * the ones that exist only on a service's pages. Built from the lists that bind them, so
 * it can't drift from what the keys do.
 *
 * @param props - Workspace id, for the settings navigation.
 * @returns The page.
 */
export function ShortcutsPage({ workspaceId }: { workspaceId: string }) {
  const mod = isApplePlatform() ? "⌘" : "Ctrl";
  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="Keyboard shortcuts"
      description="Shortcuts work anywhere except while typing in a field or with a dialog open."
    >
      <SettingsStack>
        <SettingsSection title="Everywhere">
          <SettingsRow
            label="Search or run a command"
            description="Opens the command palette."
            control="switch"
          >
            <Keys keys={[mod, "K"]} />
          </SettingsRow>
          <SettingsRow label="Move through results" control="switch">
            <Keys keys={["↑", "↓"]} then />
          </SettingsRow>
          <SettingsRow label="Run the highlighted command" control="switch">
            <Keys keys={["Enter"]} />
          </SettingsRow>
          <SettingsRow label="Close a dialog or the palette" control="switch">
            <Keys keys={["Esc"]} />
          </SettingsRow>
        </SettingsSection>
        <SettingsSection title="Go to" description="Press G, then the letter, within a second.">
          {NAV_ITEMS.filter((item) => item.shortcut).map((item) => (
            <SettingsRow key={item.id} label={item.label} control="switch">
              <Keys keys={["G", (item.shortcut ?? "").toUpperCase()]} then />
            </SettingsRow>
          ))}
        </SettingsSection>
        <SettingsSection
          title="On a service"
          description="On a service's pages these open its tabs instead of the workspace pages."
        >
          {SERVICE_SHORTCUTS.map((shortcut) => (
            <SettingsRow key={shortcut.key} label={shortcut.label} control="switch">
              <Keys keys={["G", shortcut.key.toUpperCase()]} then />
            </SettingsRow>
          ))}
        </SettingsSection>
      </SettingsStack>
    </SettingsFrame>
  );
}

// -----------------------------------------------------------------------------
// Accessibility
// -----------------------------------------------------------------------------

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToMotion(listener: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener?.("change", listener);
  return () => media.removeEventListener?.("change", listener);
}

function systemReducesMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Preferences → Accessibility: whether interface motion follows the OS, is always
 * reduced, or always allowed.
 *
 * @param props - Workspace id, for the settings navigation.
 * @returns The page.
 */
export function AccessibilityPage({ workspaceId }: { workspaceId: string }) {
  const { motion, set } = usePreferences();
  const osReduces = useSyncExternalStore(subscribeToMotion, systemReducesMotion, () => false);
  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="Accessibility"
      description="Saved in this browser only."
    >
      <SettingsStack>
        <SettingsSection
          title="Motion"
          description="Transitions, pulsing status dots and spinners. Choosing here overrides your device's setting."
        >
          <SettingsRow label="Interface motion" control="wide" className="pt-3">
            <ChoiceCards<MotionPreference>
              label="Interface motion"
              value={motion}
              onValueChange={(next) => set("motion", next)}
              className="max-w-xl"
              options={[
                {
                  value: "system",
                  label: "Follow device",
                  description: osReduces ? "Reduced right now" : "Full motion right now",
                },
                { value: "reduce", label: "Reduce motion", description: "Stop animations" },
                { value: "allow", label: "Allow motion", description: "Even if the device asks" },
              ]}
            />
          </SettingsRow>
        </SettingsSection>
      </SettingsStack>
    </SettingsFrame>
  );
}
