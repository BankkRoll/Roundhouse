import { isProviderId, PROVIDERS } from "@roundhouse/providers";
import type { AuditAction } from "@roundhouse/shared";
import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  Building2Icon,
  CloudIcon,
  KeyRoundIcon,
  ServerIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import type { AuditLogEntry } from "../../lib/api/types";

/** Readable rendering of an audit entry for the activity feed. */
export interface DescribedAction {
  /** Verb phrase, e.g. "removed server". */
  verb: string;
  /** What it happened to, e.g. a node name; `null` when the verb says it all. */
  target: string | null;
  /** Icon for the kind of thing affected. */
  icon: LucideIcon;
}

type Metadata = AuditLogEntry["metadata"];

const VERBS: Record<AuditAction, string> = {
  "instance.setup_completed": "set up this instance",
  "workspace.created": "created the workspace",
  "workspace.renamed": "renamed the workspace to",
  "member.role_changed": "changed a member's role",
  "member.removed": "removed member",
  "member.left": "left the workspace",
  "invite.created": "invited",
  "invite.revoked": "revoked the invite for",
  "invite.accepted": "joined via invite",
  "node.join_token_created": "created a join token",
  "node.joined": "connected",
  "node.removed": "removed server",
  "node.went_offline": "lost contact with a server",
  "node.provision_requested": "started creating server",
  "node.provisioned": "created server",
  "node.provision_failed": "failed to create server",
  "node.deprovisioned": "deleted cloud server",
  "provider.connected": "connected",
  "provider.disconnected": "disconnected",
  "project.created": "created project",
  "project.updated": "updated project",
  "project.deleted": "deleted project",
  "service.created": "created service",
  "service.updated": "updated service",
  "service.deleted": "deleted service",
  "variables.updated": "updated variables of",
  "variables.revealed": "revealed secret variables of",
  "variables.resolved": "resolved the environment of",
  "deployment.created": "deployed",
  "deployment.rolled_back": "rolled back",
  "deployment.cancelled": "cancelled a deployment of",
  "deployment.succeeded": "deployment succeeded for",
  "deployment.failed": "deployment failed for",
  "github.app_created": "created the GitHub App",
  "github.installation_added": "installed the GitHub App on",
  "github.installation_rejected": "was refused a GitHub App installation",
  "github.installation_released": "released the GitHub installation",
  "instance.settings_updated": "updated instance settings",
  "instance.admin_granted": "made an instance admin:",
  "instance.admin_revoked": "removed instance admin",
  "instance.key_rotation_started": "started a key rotation",
  "instance.key_rotation_completed": "completed a key rotation",
  "instance.key_rotation_failed": "key rotation failed",
  "token.created": "created API token",
  "token.revoked": "revoked API token",
  "workspace.access_settings_updated": "changed default project access",
  "team.created": "created team",
  "team.updated": "updated team",
  "team.deleted": "deleted team",
  "team.member_added": "added a member to team",
  "team.member_removed": "removed a member from team",
  "access.granted": "granted access to",
  "access.changed": "changed access to",
  "access.revoked": "revoked access to",
  "environment.protection_updated": "changed protection of",
  "node.encryption_key_registered": "registered an encryption key for",
  "auth.sign_in_succeeded": "signed in",
  "auth.sign_in_failed": "failed to sign in",
  "auth.account_locked": "was locked out after failed sign-ins",
  "auth.reauthenticated": "re-authenticated",
  "auth.two_factor_enabled": "enabled two-factor authentication",
  "auth.two_factor_disabled": "disabled two-factor authentication",
  "auth.backup_codes_regenerated": "regenerated backup codes",
  "auth.two_factor_failed": "entered a wrong two-factor code",
};

/**
 * Targets for actions where the generic name/email lookup is wrong: their metadata has
 * no name (so they say what changed instead), or names the actor themselves.
 */
const TARGETS: Partial<Record<AuditAction, (metadata: Metadata) => string | null>> = {
  "member.role_changed": (metadata) => {
    const from = stringField(metadata, "from");
    const to = stringField(metadata, "to");
    return from && to ? `${from} → ${to}` : null;
  },
  "invite.accepted": (metadata) => {
    const role = stringField(metadata, "role");
    return role ? `as ${role}` : null;
  },
  "member.left": () => null,
  "provider.connected": providerName,
  "provider.disconnected": providerName,
  "github.installation_rejected": (metadata) => {
    const reason = stringField(metadata, "reason") ?? stringField(metadata, "code");
    return reason ? `(${reason.replace(/_/g, " ")})` : null;
  },
};

function isKnownAction(action: string): action is AuditAction {
  return Object.hasOwn(VERBS, action);
}

const ICONS: Record<string, LucideIcon> = {
  node: ServerIcon,
  join_token: KeyRoundIcon,
  member: UsersIcon,
  invite: UserPlusIcon,
  workspace: Building2Icon,
  provider: CloudIcon,
  api_token: KeyRoundIcon,
  token: KeyRoundIcon,
};

function stringField(metadata: Metadata, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function providerName(metadata: Metadata): string | null {
  const provider = stringField(metadata, "provider");
  if (!provider) return null;
  return isProviderId(provider) ? PROVIDERS[provider].displayName : provider;
}

/**
 * Turns an audit entry into a short sentence fragment and an icon.
 *
 * The target comes from metadata only (a name, email or what changed), never from raw ids.
 * Actions without such metadata, or whose actor is also the target (a node joining),
 * are self-describing and have no target. Unknown actions fall back to the action name
 * with separators turned into spaces, so new server-side actions render sensibly before
 * the dashboard learns about them.
 *
 * @param entry - Audit log entry.
 * @returns Verb, target label and icon.
 * @example
 * describeAction({ action: "node.removed", metadata: { name: "hel-1" }, ... });
 * // { verb: "removed server", target: "hel-1", icon: ServerIcon }
 */
export function describeAction(entry: AuditLogEntry): DescribedAction {
  const known = isKnownAction(entry.action) ? entry.action : null;
  const verb = known ? VERBS[known] : entry.action.replace(/[._]/g, " ");
  const prefix = entry.action.split(".")[0] ?? "";
  const icon = ICONS[entry.target_type ?? ""] ?? ICONS[prefix] ?? ActivityIcon;

  const actsOnItself = entry.actor_id !== null && entry.actor_id === entry.target_id;
  const describe = known ? TARGETS[known] : undefined;
  const target = actsOnItself
    ? null
    : describe
      ? describe(entry.metadata)
      : (stringField(entry.metadata, "name") ??
        stringField(entry.metadata, "email") ??
        stringField(entry.metadata, "target_name"));
  return { verb, target, icon };
}

/**
 * Display name for whoever performed an audited action. API tokens are marked as such,
 * so a token named after a person isn't mistaken for them.
 *
 * @param entry - Audit log entry.
 * @returns Actor name, falling back to the id or the actor type ("system").
 * @example
 * actorLabel({ actor_type: "token", actor_name: "ci-deploy", ... }); // "ci-deploy (API token)"
 */
export function actorLabel(entry: AuditLogEntry): string {
  if (entry.actor_type === "token") {
    return entry.actor_name ? `${entry.actor_name} (API token)` : "API token";
  }
  return entry.actor_name ?? entry.actor_id ?? entry.actor_type;
}
