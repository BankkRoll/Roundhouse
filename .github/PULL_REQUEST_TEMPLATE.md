## Summary

<!-- What does this change and why? Link the issue it resolves. -->

Closes #

## Checklist

- [ ] PR title follows Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `refactor:`, `test:`, `perf:`)
- [ ] Tests added or updated, and `pnpm test` / `go test ./...` pass locally
- [ ] Docs updated (README, CONTRIBUTING, ADR, or inline JSDoc/godoc) where behaviour changed
- [ ] Database: schema change has a generated migration (`pnpm --filter @roundhouse/db generate`) committed, or N/A
- [ ] Protocol: schema and fixtures regenerated, Go types updated, and the change is compatible with agents one minor version behind (N-1), or N/A
- [ ] No secrets, tokens, or personal data in code, fixtures, or logs

## Notes for reviewers

<!-- Rollout concerns, follow-ups, anything you want a second opinion on. -->
