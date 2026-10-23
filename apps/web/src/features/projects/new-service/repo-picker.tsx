import { cn, Input, Skeleton } from "@openrail/ui";
import { LockIcon, SearchIcon } from "lucide-react";
import { useId, useState } from "react";
import type { GithubRepository } from "../../../lib/api/deploy-types";

/** Props for {@link RepoPicker}. */
export interface RepoPickerProps {
  repositories: readonly GithubRepository[] | undefined;
  loading: boolean;
  selectedId: number | null;
  onSelect: (repository: GithubRepository) => void;
}

/**
 * Searchable single choice among the repositories the workspace's GitHub App
 * installations can read. Native radio inputs keep arrow-key selection and screen reader
 * announcements correct.
 *
 * @param props - Repositories, selection and change handler.
 * @returns The picker.
 */
export function RepoPicker({ repositories, loading, selectedId, onSelect }: RepoPickerProps) {
  const [filter, setFilter] = useState("");
  const name = useId();
  const searchId = useId();
  const needle = filter.trim().toLowerCase();
  const shown = (repositories ?? []).filter((repo) =>
    repo.full_name.toLowerCase().includes(needle),
  );

  return (
    <div className="grid gap-2">
      <div className="relative">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground"
          aria-hidden="true"
        />
        <label htmlFor={searchId} className="sr-only">
          Search repositories
        </label>
        <Input
          id={searchId}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search repositories"
          className="pl-8"
        />
      </div>
      <fieldset className="max-h-52 overflow-y-auto rounded-md border border-border">
        <legend className="sr-only">Repository</legend>
        {loading ? (
          <div className="grid gap-2 p-3">
            <Skeleton className="h-5" />
            <Skeleton className="h-5" />
          </div>
        ) : shown.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            {repositories?.length
              ? "No repositories match."
              : "No repositories are shared with OpenRail yet."}
          </p>
        ) : (
          shown.map((repo) => {
            const checked = repo.id === selectedId;
            return (
              <label
                key={repo.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2 text-sm last:border-0 hover:bg-muted/50 has-focus-visible:bg-muted",
                  checked && "bg-accent-subtle",
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={repo.id}
                  checked={checked}
                  onChange={() => onSelect(repo)}
                  className="accent-[var(--accent-text)]"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                  {repo.full_name}
                </span>
                {repo.private ? (
                  <LockIcon className="size-3 text-subtle-foreground" aria-label="Private" />
                ) : null}
                <span className="text-xs text-muted-foreground">{repo.default_branch}</span>
              </label>
            );
          })
        )}
      </fieldset>
    </div>
  );
}
