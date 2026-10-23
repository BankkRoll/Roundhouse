import { PRODUCT_NAME } from "@roundhouse/shared";
import {
  CommandPalette,
  cn,
  copyText,
  type PaletteCommand,
  useCommandPaletteHotkey,
} from "@roundhouse/ui";
import {
  BookOpenIcon,
  ChevronDownIcon,
  CopyIcon,
  HashIcon,
  MoonIcon,
  SearchIcon,
  SunIcon,
  XIcon,
} from "lucide-react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { LogoMark } from "../brand";
import { FEATURE_GROUPS, type FeatureGroup } from "../content";
import {
  CONTRIBUTING_URL,
  DEPLOY_URL,
  DOCS_URL,
  INSTALL_COMMAND,
  RELEASES_URL,
  REPO_URL,
  SECURITY_URL,
} from "../links";
import { nextMenuItem } from "../model/menu";
import { buttonClass, ExternalLink, GitHubMark } from "../ui";
import { useTheme } from "../use-theme";
import { MenuPreview } from "./menu-previews";

/** In-page sections, in page order. Used by the header links, search and tests. */
export const PAGE_SECTIONS = [
  ["deploys", "Push to live"],
  ["canvas", "Project canvas"],
  ["security", "Security"],
  ["pricing", "Pricing"],
  ["features", "Everything it does"],
  ["install", "Install"],
  ["faq", "FAQ"],
] as const;

/**
 * Scrolls to an in-page section and moves focus there.
 *
 * NOTE: The router owns `location`, so hash links are handled here instead of letting the
 * browser change the URL and trigger a navigation.
 *
 * @param id - Section id.
 * @returns `true` when the section exists.
 */
export function goToSection(id: string): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  return true;
}

function onAnchorClick(event: MouseEvent<HTMLAnchorElement>) {
  const id = event.currentTarget.hash.slice(1);
  if (id && goToSection(id)) event.preventDefault();
}

function useScrolled(threshold = 8) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > threshold);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [threshold]);
  return scrolled;
}

const NAV_LINKS = [
  { label: "Pricing", href: "#pricing" },
  { label: "Security", href: "#security" },
  { label: "Install", href: "#install" },
  { label: "Docs", href: DOCS_URL, external: true },
] as const;

/**
 * Header: a solid bar with the wordmark, the Product mega menu, a few links, search and the
 * one action. Below `lg` it folds into a full-screen sheet.
 *
 * @returns The header.
 */
export function SiteHeader() {
  const scrolled = useScrolled();
  const headerRef = useRef<HTMLElement>(null);

  // One measured value for everything that sits under the bar (the menu panel, pinned and
  // sticky sections). Measuring follows the bar through its shrink transition, so nothing
  // leaves a sliver between itself and the header.
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const root = document.documentElement;
    const write = () =>
      root.style.setProperty("--lp-header-h", `${header.getBoundingClientRect().height}px`);
    write();
    if (typeof ResizeObserver === "undefined")
      return () => root.style.removeProperty("--lp-header-h");
    const observer = new ResizeObserver(write);
    observer.observe(header);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--lp-header-h");
    };
  }, []);
  const theme = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState<{ left: number; width: number } | null>(null);

  useCommandPaletteHotkey(() => setSearchOpen((open) => !open));

  const moveHighlight = (element: HTMLElement | null) => {
    const nav = navRef.current;
    if (!element || !nav) return setHighlight(null);
    const navBox = nav.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    setHighlight({ left: box.left - navBox.left, width: box.width });
  };

  const commands = useSearchCommands({ toggleTheme: theme.toggle });

  return (
    <header
      ref={headerRef}
      className={cn(
        "sticky top-0 z-50 transition-[background-color,height] duration-300",
        scrolled ? "bg-[var(--lp-step)]" : "bg-[var(--lp-ground)]",
      )}
    >
      <div
        className={cn(
          "lp-wrap flex items-center gap-3 transition-[height] duration-300",
          scrolled ? "h-14" : "h-[68px]",
        )}
      >
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0 })}
          aria-label={`${PRODUCT_NAME}, back to top`}
          className="flex cursor-pointer items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <LogoMark size={24} />
          <span className="text-[18px] font-semibold tracking-[-0.02em]">{PRODUCT_NAME}</span>
        </button>

        <nav
          aria-label="Main"
          className="relative ml-6 hidden lg:block"
          ref={navRef}
          onPointerLeave={() => !menuOpen && setHighlight(null)}
        >
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-y-0 rounded-md bg-[var(--lp-step-2)] transition-[left,width,opacity] duration-200",
              highlight ? "opacity-100" : "opacity-0",
            )}
            style={highlight ?? undefined}
          />
          <ul className="relative flex items-center">
            <li>
              <ProductMenu
                open={menuOpen}
                onOpenChange={(open) => {
                  setMenuOpen(open);
                  if (!open) setHighlight(null);
                }}
                onHighlight={moveHighlight}
              />
            </li>
            {NAV_LINKS.map((link) => {
              const props = {
                className:
                  "relative block rounded-md px-3 py-2 text-[15px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
                onPointerEnter: (event: MouseEvent<HTMLAnchorElement>) =>
                  moveHighlight(event.currentTarget),
                onFocus: (event: FocusEvent<HTMLAnchorElement>) =>
                  moveHighlight(event.currentTarget),
              };
              return (
                <li key={link.label}>
                  {"external" in link ? (
                    <a href={link.href} target="_blank" rel="noopener noreferrer" {...props}>
                      {link.label}
                    </a>
                  ) : (
                    <a
                      href={link.href}
                      onClick={link.href.startsWith("#") ? onAnchorClick : undefined}
                      {...props}
                    >
                      {link.label}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search the page"
            className="hidden h-10 cursor-pointer items-center gap-3 rounded-md bg-[var(--lp-step-2)] pr-2 pl-3 text-[15px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:flex"
          >
            <SearchIcon className="size-4" aria-hidden="true" />
            Search
            <kbd className="rounded-sm bg-[var(--lp-field)] px-1.5 py-0.5 font-sans text-[13px] text-foreground">
              Ctrl K
            </kbd>
          </button>
          <button
            type="button"
            onClick={theme.toggle}
            aria-label={
              theme.resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"
            }
            className="hidden size-10 cursor-pointer items-center justify-center rounded-md text-foreground outline-none transition-colors hover:bg-[var(--lp-step-2)] focus-visible:ring-2 focus-visible:ring-ring sm:flex"
          >
            {theme.resolved === "dark" ? (
              <SunIcon className="size-4" aria-hidden="true" />
            ) : (
              <MoonIcon className="size-4" aria-hidden="true" />
            )}
          </button>
          <ExternalLink
            href={REPO_URL}
            aria-label="Roundhouse on GitHub"
            className="hidden size-10 items-center justify-center rounded-md text-foreground outline-none transition-colors hover:bg-[var(--lp-step-2)] focus-visible:ring-2 focus-visible:ring-ring sm:flex"
          >
            <GitHubMark className="size-4" />
          </ExternalLink>
          <ExternalLink
            href={DEPLOY_URL}
            className={buttonClass("primary", "ml-1.5 min-h-10 px-4 text-[15px]")}
          >
            <span className="hidden sm:inline">Deploy to Cloudflare</span>
            <span className="sm:hidden">Deploy</span>
          </ExternalLink>
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            aria-expanded={sheetOpen}
            aria-controls="lp-mobile-menu"
            className="min-h-10 cursor-pointer rounded-md px-3 text-[15px] font-medium text-foreground outline-none hover:bg-[var(--lp-step-2)] focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          >
            Menu
          </button>
        </div>
      </div>

      {sheetOpen ? <MobileSheet onClose={() => setSheetOpen(false)} /> : null}
      <CommandPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        commands={commands}
        placeholder="Jump to a section, open the docs…"
      />
    </header>
  );
}

function useSearchCommands({ toggleTheme }: { toggleTheme: () => void }) {
  const sections: PaletteCommand[] = PAGE_SECTIONS.map(([id, label]) => ({
    id: `section:${id}`,
    label,
    group: "On this page",
    icon: <HashIcon />,
    onSelect: () => goToSection(id),
  }));
  const open = (href: string) => () => window.open(href, "_blank", "noopener,noreferrer");
  const resources: PaletteCommand[] = [
    {
      id: "docs",
      label: "Read the docs",
      group: "Resources",
      icon: <BookOpenIcon />,
      onSelect: open(DOCS_URL),
    },
    {
      id: "github",
      label: "Source on GitHub",
      group: "Resources",
      icon: <GitHubMark />,
      onSelect: open(REPO_URL),
    },
    {
      id: "releases",
      label: "Releases",
      group: "Resources",
      icon: <GitHubMark />,
      onSelect: open(RELEASES_URL),
    },
    {
      id: "security",
      label: "Report a vulnerability",
      group: "Resources",
      icon: <GitHubMark />,
      onSelect: open(SECURITY_URL),
    },
    {
      id: "contributing",
      label: "Contributing guide",
      group: "Resources",
      icon: <GitHubMark />,
      onSelect: open(CONTRIBUTING_URL),
    },
  ];
  const actions: PaletteCommand[] = [
    {
      id: "copy-install",
      label: "Copy the install command",
      group: "Actions",
      icon: <CopyIcon />,
      keywords: ["curl", "agent", "server"],
      onSelect: () => void copyText(INSTALL_COMMAND),
    },
    {
      id: "theme",
      label: "Toggle theme",
      group: "Actions",
      icon: <SunIcon />,
      onSelect: toggleTheme,
    },
  ];
  return [...sections, ...resources, ...actions];
}

/** Props for {@link ProductMenu}. */
interface ProductMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Moves the bar's shared highlight under the trigger. */
  onHighlight: (element: HTMLElement | null) => void;
}

/**
 * The Product trigger and its full-width panel: every feature, grouped, with a live crop of
 * the dashboard for the group under the pointer.
 *
 * Keyboard: Enter, Space or ArrowDown opens it and focuses the first item; arrows move
 * between items and groups; Tab stays inside the panel; Escape closes it and returns focus
 * to the trigger.
 *
 * @param props - Open state and the highlight callback.
 * @returns The trigger and panel.
 */
export function ProductMenu({ open, onOpenChange, onHighlight }: ProductMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [active, setActive] = useState<FeatureGroup["id"]>("deploy");
  const [focusFirst, setFocusFirst] = useState(false);
  const panelId = useId();

  const items = useCallback(
    () => [...(panelRef.current?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? [])],
    [],
  );

  const close = useCallback(
    (returnFocus: boolean) => {
      onOpenChange(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    [onOpenChange],
  );

  useLayoutEffect(() => {
    if (open && focusFirst) {
      items()[0]?.focus();
      setFocusFirst(false);
    }
  }, [open, focusFirst, items]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const openMenu = (withFocus: boolean) => {
    clearTimeout(closeTimer.current);
    onOpenChange(true);
    onHighlight(triggerRef.current);
    if (withFocus) setFocusFirst(true);
  };

  const scheduleClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => close(false), 160);
  };

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu(true);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      close(true);
    }
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const current = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      // Keep focus inside the open panel; Escape is the way out.
      event.preventDefault();
      const step = event.shiftKey ? -1 : 1;
      list[(current + step + list.length) % list.length]?.focus();
      return;
    }
    const groups = list.map((item) => Number(item.dataset.group ?? 0));
    const next = nextMenuItem(event.key, current, groups);
    if (next === null) return;
    event.preventDefault();
    list[next]?.focus();
  }

  return (
    <div onPointerEnter={() => openMenu(false)} onPointerLeave={scheduleClose}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="true"
        onClick={() => (open ? close(false) : openMenu(false))}
        onKeyDown={onTriggerKeyDown}
        onFocus={(event) => onHighlight(event.currentTarget)}
        className="relative flex cursor-pointer items-center gap-1 rounded-md px-3 py-2 text-[15px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Product
        <ChevronDownIcon
          className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <section
          ref={panelRef}
          id={panelId}
          aria-label="Product"
          onKeyDown={onPanelKeyDown}
          className="lp-menu-in fixed inset-x-0 top-[var(--lp-header-h)] z-40 bg-[var(--lp-step)] shadow-2xl shadow-black/40"
        >
          <div className="lp-wrap grid grid-cols-12 gap-[var(--lp-gap)] py-8">
            <div className="col-span-8 grid grid-cols-5 gap-6">
              {FEATURE_GROUPS.map((group, groupIndex) => (
                // biome-ignore lint/a11y/noStaticElementInteractions: hover only picks the preview; focus inside the column does the same for keyboards
                <div
                  key={group.id}
                  onPointerEnter={() => setActive(group.id)}
                  onFocus={() => setActive(group.id)}
                  className="min-w-0"
                >
                  <a
                    href={`#${group.anchor}`}
                    data-menu-item
                    data-group={groupIndex}
                    onClick={(event) => {
                      onAnchorClick(event);
                      close(false);
                    }}
                    className="block rounded-md p-2 -m-2 outline-none hover:bg-[var(--lp-step-2)] focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="block text-[16px] font-semibold text-foreground">
                      {group.title}
                    </span>
                    <span className="mt-1 block text-[14px] leading-snug text-muted-foreground">
                      {group.summary}
                    </span>
                  </a>
                  <ul className="mt-5 grid gap-1">
                    {group.features.map((feature) => (
                      <li key={feature.title}>
                        <a
                          href={`#${feature.anchor ?? "features"}`}
                          data-menu-item
                          data-group={groupIndex}
                          onClick={(event) => {
                            onAnchorClick(event);
                            close(false);
                          }}
                          className="block rounded-md px-2 py-1.5 -mx-2 text-[15px] text-foreground outline-none transition-colors hover:bg-[var(--lp-step-2)] focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {feature.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="col-span-4 min-h-[260px]">
              <MenuPreview group={active} />
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function MobileSheet({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    ref.current?.querySelector<HTMLElement>("button, a")?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(ref.current?.querySelectorAll<HTMLElement>("a, button") ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  const go = (event: MouseEvent<HTMLAnchorElement>) => {
    onClose();
    onAnchorClick(event);
  };

  return (
    <div
      ref={ref}
      id="lp-mobile-menu"
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      onKeyDown={onKeyDown}
      className="lp-menu-in fixed inset-0 z-[60] overflow-y-auto bg-[var(--lp-ground)]"
    >
      <div className="lp-wrap flex h-[68px] items-center justify-between">
        <span className="flex items-center gap-2">
          <LogoMark size={24} />
          <span className="text-[18px] font-semibold tracking-[-0.02em]">{PRODUCT_NAME}</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-3 text-[16px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon className="size-4" aria-hidden="true" />
          Close
        </button>
      </div>
      <nav aria-label="Menu" className="lp-wrap pb-10">
        <p className="mt-4 text-[15px] text-muted-foreground">Product</p>
        <ul className="mt-2">
          {FEATURE_GROUPS.map((group) => {
            const isOpen = expanded === group.id;
            return (
              <li key={group.id}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : group.id)}
                  className="flex min-h-14 w-full cursor-pointer items-center justify-between text-left text-[26px] font-semibold tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {group.title}
                  <ChevronDownIcon
                    className={cn("size-5 transition-transform", isOpen && "rotate-180")}
                    aria-hidden="true"
                  />
                </button>
                {isOpen ? (
                  <ul className="mb-3 grid gap-1 rounded-lg bg-[var(--lp-step)] p-3">
                    {group.features.map((feature) => (
                      <li key={feature.title}>
                        <a
                          href={`#${feature.anchor ?? "features"}`}
                          onClick={go}
                          className="block py-2 text-[17px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {feature.title}
                          <span className="block text-[14px] text-muted-foreground">
                            {feature.body}
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
        <ul className="mt-8 grid gap-1 text-[20px]">
          <li>
            {/* biome-ignore lint/a11y/useValidAnchor: a real in-page link; the handler closes the sheet before scrolling */}
            <a
              href="#pricing"
              onClick={go}
              className="block py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Pricing
            </a>
          </li>
          <li>
            {/* biome-ignore lint/a11y/useValidAnchor: a real in-page link; the handler closes the sheet before scrolling */}
            <a
              href="#security"
              onClick={go}
              className="block py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Security
            </a>
          </li>
          <li>
            <ExternalLink
              href={DOCS_URL}
              className="block py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Docs
            </ExternalLink>
          </li>
          <li>
            <ExternalLink
              href={REPO_URL}
              className="block py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              GitHub
            </ExternalLink>
          </li>
        </ul>
        <ExternalLink href={DEPLOY_URL} className={buttonClass("primary", "mt-8 w-full")}>
          Deploy to Cloudflare
        </ExternalLink>
      </nav>
    </div>
  );
}
