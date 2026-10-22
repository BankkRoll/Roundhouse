import { CheckIcon } from "lucide-react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Dropdown menu root. */
export const DropdownMenu = MenuPrimitive.Root;

/** Element that toggles the menu. Use `asChild` to wrap a {@link Button}. */
export const DropdownMenuTrigger = MenuPrimitive.Trigger;

/** Groups mutually exclusive {@link DropdownMenuRadioItem}s. */
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

const itemClasses =
  "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted data-[highlighted]:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

/**
 * Menu panel rendered in a portal.
 *
 * @param props - Radix content props.
 * @returns The rendered menu panel.
 */
export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-48 overflow-hidden rounded-md border border-border-strong bg-surface-raised p-1 text-foreground shadow-xl shadow-black/30",
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

/** Props for {@link DropdownMenuItem}. */
export interface DropdownMenuItemProps extends ComponentProps<typeof MenuPrimitive.Item> {
  /** Paint the item in the danger color, for destructive actions. */
  destructive?: boolean;
}

/**
 * Selectable menu item.
 *
 * @param props - Radix item props plus `destructive`.
 * @returns The rendered item.
 */
export function DropdownMenuItem({ className, destructive, ...props }: DropdownMenuItemProps) {
  return (
    <MenuPrimitive.Item
      className={cn(
        itemClasses,
        destructive && "text-danger data-[highlighted]:text-danger [&_svg]:text-danger",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Item inside a {@link DropdownMenuRadioGroup}, with a check when selected.
 *
 * @param props - Radix radio item props.
 * @returns The rendered radio item.
 */
export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(itemClasses, "pr-7", className)} {...props}>
      {children}
      <MenuPrimitive.ItemIndicator className="absolute right-2 flex items-center">
        <CheckIcon aria-hidden="true" />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

/**
 * Non-interactive heading inside a menu.
 *
 * @param props - Radix label props.
 * @returns The rendered label.
 */
export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      className={cn(
        "px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-subtle-foreground",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Hairline between menu groups.
 *
 * @param props - Radix separator props.
 * @returns The rendered separator.
 */
export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return (
    <MenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
  );
}
