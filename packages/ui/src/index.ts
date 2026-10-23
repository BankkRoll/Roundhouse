/**
 * Dashboard component library: design tokens (`@roundhouse/ui/styles.css`), primitives
 * built on Radix, and domain widgets (server cards, meters, status glyphs, command
 * palette). Components rely only on the CSS tokens, never on app state.
 *
 * Heavier controls used only by some pages (sliders, switches, segmented controls, the
 * ANSI renderer and list windowing) live in `@roundhouse/ui/controls`, so apps that split
 * code by route don't load them up front.
 *
 * @module
 */
export * from "./components/activity-item";
export * from "./components/avatar";
export * from "./components/badge";
export * from "./components/button";
export * from "./components/card";
export * from "./components/code-block";
export * from "./components/command-palette";
export * from "./components/dialog";
export * from "./components/dropdown-menu";
export * from "./components/empty-state";
export * from "./components/input";
export * from "./components/kbd-hint";
export * from "./components/label";
export * from "./components/meter";
export * from "./components/section-label";
export * from "./components/server-card";
export * from "./components/skeleton";
export * from "./components/spinner";
export * from "./components/stat-card";
export * from "./components/status";
export * from "./components/table";
export * from "./components/tabs";
export * from "./components/toast";
export * from "./components/tooltip";
export * from "./lib/clipboard";
export * from "./lib/cn";
export * from "./lib/shortcuts";
export * from "./lib/theme";
