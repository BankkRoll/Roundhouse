import { ROLES, type Role } from "@openrail/shared";
import { Select } from "@openrail/ui";
import type { ComponentProps } from "react";

/** Props for {@link RoleSelect}. */
export interface RoleSelectProps extends Omit<ComponentProps<"select">, "value" | "onChange"> {
  value: Role;
  onValueChange: (role: Role) => void;
  /** Roles the caller may pick. Others are listed but disabled. */
  allowed: readonly Role[];
}

const LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

/**
 * Human label for a role.
 *
 * @param role - Role.
 * @returns e.g. "Admin".
 */
export function roleLabel(role: Role): string {
  return LABELS[role];
}

/**
 * Native select listing every role.
 *
 * @param props - Current role, change handler, and which roles may be chosen.
 * @returns The select.
 */
export function RoleSelect({
  value,
  onValueChange,
  allowed,
  className,
  ...props
}: RoleSelectProps) {
  return (
    <Select
      value={value}
      onChange={(event) => onValueChange(event.target.value as Role)}
      className={className ?? "h-7 w-28 text-xs"}
      {...props}
    >
      {ROLES.map((role) => (
        <option key={role} value={role} disabled={role !== value && !allowed.includes(role)}>
          {LABELS[role]}
        </option>
      ))}
    </Select>
  );
}
