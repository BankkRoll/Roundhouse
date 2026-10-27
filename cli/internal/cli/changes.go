package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// maxDiffValue bounds how much of a non-variable diff value is printed.
const maxDiffValue = 120

func (a *App) changesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "changes",
		Aliases: []string{"change-sets", "draft"},
		Short:   "Review and apply staged changes",
		Long: `Review, approve, apply and discard change sets: changes staged together
against one environment and applied as one. Each environment has a shared
draft that the dashboard stages into; API clients and MCP agents may open
sets of their own.

Without a change set ID, every subcommand acts on the environment's draft.
Diffs never show variable values: a variable appears as its tier and
fingerprint (equal values have equal fingerprints).

When an environment's protection requires approval, a set applies only once
someone else approves it: submit it for review, a reviewer with the
changes:approve permission approves or rejects exactly the revision they saw,
and any later edit voids the decision. Nobody who opened a set or staged a
change in it may review it, and whoever approved it can't also apply it.

Rebase moves a stale set onto the current state. Conflicts (a change whose
target moved on since it was staged) are resolved in the dashboard.`,
		Example: `  roundhouse changes
  roundhouse changes diff
  roundhouse changes submit --note "Rotates the Stripe key"
  roundhouse changes approve chs_01J9Z6Y4M0V8 --yes
  roundhouse changes reject chs_01J9Z6Y4M0V8 --note "Scale staging first"
  roundhouse changes rebase
  roundhouse changes apply --yes
  roundhouse changes apply chs_01J9Z6Y4M0V8 --no-deploy
  roundhouse changes discard --environment staging`,
		Args: noArgs,
	}
	var f targetFlags
	cmd.RunE = func(cmd *cobra.Command, _ []string) error { return a.runChangesList(cmd.Context(), f, false) }
	f.register(cmd, false)
	cmd.AddCommand(a.changesListCmd(), a.changesDiffCmd(), a.changesSubmitCmd(), a.changesDecideCmd(true), a.changesDecideCmd(false),
		a.changesRebaseCmd(), a.changesApplyCmd(), a.changesDiscardCmd())
	return cmd
}

func (a *App) changesListCmd() *cobra.Command {
	var f targetFlags
	var all bool
	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List an environment's change sets",
		Long:    `List the open change sets of the linked environment, newest first; --all includes applied, discarded and failed ones.`,
		Example: `  roundhouse changes list
  roundhouse changes list --all --environment staging --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return a.runChangesList(cmd.Context(), f, all) },
	}
	f.register(cmd, false)
	cmd.Flags().BoolVar(&all, "all", false, "include change sets that are no longer open")
	return cmd
}

func (a *App) runChangesList(ctx context.Context, f targetFlags, all bool) error {
	t, err := a.resolve(ctx, f, serviceOptional)
	if err != nil {
		return err
	}
	list, err := t.sess.client.ListChangeSets(ctx, t.env.ID, all)
	if err != nil {
		return err
	}
	sets := list.ChangeSets
	if a.jsonOut {
		if sets == nil {
			sets = []api.ChangeSetSummary{}
		}
		return a.printJSON(changeSetListJSON{ChangeSets: sets, EnvironmentRequiresApproval: list.EnvironmentRequiresApproval})
	}
	if len(sets) == 0 {
		if all {
			fmt.Fprintf(a.IO.Out, "No change sets in %s\n", t.env.Name)
		} else {
			fmt.Fprintf(a.IO.Out, "No open change sets in %s\n", t.env.Name)
		}
		return nil
	}
	tbl := a.newTable("id", "title", "status", "review", "approval", "changes", "conflicts", "source", "updated")
	for _, s := range sets {
		review := s.ReviewStatus
		if review == "" || review == api.ReviewNone {
			review = "-"
		}
		tbl.row(s.ID, changeSetTitle(s), s.Status, review, approvalCell(s, list.EnvironmentRequiresApproval),
			fmt.Sprint(s.OpCount), fmt.Sprint(s.ConflictedCount), s.Source, ago(a.Now(), s.UpdatedAt))
	}
	tbl.flush()
	return nil
}

// changeSetListJSON is what `changes list --json` prints.
type changeSetListJSON struct {
	ChangeSets                  []api.ChangeSetSummary `json:"change_sets"`
	EnvironmentRequiresApproval bool                   `json:"environment_requires_approval"`
}

// approvalCell says whether an open set still needs an approval before it
// can apply.
func approvalCell(s api.ChangeSetSummary, required bool) string {
	switch {
	case !required || s.Status != api.ChangeSetOpen:
		return "-"
	case s.ReviewStatus == api.ReviewApproved:
		return "approved"
	}
	return "required"
}

func changeSetTitle(s api.ChangeSetSummary) string {
	switch {
	case s.Title != nil && s.IsDraft:
		return *s.Title + " (draft)"
	case s.Title != nil:
		return *s.Title
	case s.IsDraft:
		return "draft"
	}
	return "-"
}

// -----------------------------------------------------------------------------
// Loading a change set
// -----------------------------------------------------------------------------

// changeScope is what a change set command acts on.
type changeScope struct {
	sess *session
	// set is nil when the environment has no draft.
	set *api.ChangeSet
	// envName names the set's environment, or holds its ID when the
	// project could not be loaded.
	envName     string
	workspaceID string
	projectID   string
}

// loadChangeSet fetches the change set named in args, or the draft of the
// target environment.
func (a *App) loadChangeSet(ctx context.Context, f targetFlags, args []string) (*changeScope, error) {
	if len(args) == 1 {
		sess, err := a.connect()
		if err != nil {
			return nil, err
		}
		cs, err := sess.client.GetChangeSet(ctx, args[0])
		if err != nil {
			return nil, err
		}
		sc := &changeScope{sess: sess, set: cs, envName: cs.EnvironmentID, projectID: cs.ProjectID}
		// Only names the environment in messages, so a failure is not fatal.
		if p, err := sess.client.GetProject(ctx, cs.ProjectID); err == nil {
			sc.workspaceID = p.WorkspaceID
			for _, e := range p.Environments {
				if e.ID == cs.EnvironmentID {
					sc.envName = e.Name
				}
			}
		}
		return sc, nil
	}
	t, err := a.resolve(ctx, f, serviceOptional)
	if err != nil {
		return nil, err
	}
	cs, err := t.sess.client.Draft(ctx, t.env.ID)
	if err != nil {
		return nil, err
	}
	return &changeScope{sess: t.sess, set: cs, envName: t.env.Name, workspaceID: t.project.WorkspaceID, projectID: t.project.ID}, nil
}

// requireOpen loads the change set an apply or discard acts on and checks
// that it can still change.
func (a *App) requireOpen(ctx context.Context, f targetFlags, args []string, verb string) (*changeScope, error) {
	sc, err := a.loadChangeSet(ctx, f, args)
	if err != nil {
		return nil, err
	}
	switch {
	case sc.set == nil:
		return nil, exitcode.New(exitcode.NotFound, "nothing staged in %s: the environment has no draft", sc.envName)
	case sc.set.Status != api.ChangeSetOpen:
		return nil, exitcode.New(exitcode.Conflict, "%s is %s; only open change sets can be %s", sc.set.ID, sc.set.Status, verb)
	}
	return sc, nil
}

func (sc *changeScope) label() string {
	if sc.set.IsDraft {
		return "the draft of " + sc.envName
	}
	if sc.set.Title != nil {
		return fmt.Sprintf("%q (%s)", *sc.set.Title, sc.set.ID)
	}
	return sc.set.ID + " in " + sc.envName
}

// headerLabel describes the set beside its ID.
func (sc *changeScope) headerLabel() string {
	switch {
	case sc.set.IsDraft:
		return "draft of " + sc.envName
	case sc.set.Title != nil:
		return fmt.Sprintf("%q in %s", *sc.set.Title, sc.envName)
	}
	return sc.envName
}

// dashboardHint words where conflicts are resolved.
func (sc *changeScope) dashboardHint() string {
	where := "the dashboard"
	if sc.workspaceID != "" {
		where += " (" + dashboardURL(sc.sess.url, sc.workspaceID, sc.projectID, "") + ")"
	}
	return fmt.Sprintf("resolve the conflicts in %s, then review with `roundhouse changes diff %s` and apply again", where, sc.set.ID)
}

// -----------------------------------------------------------------------------
// Diff
// -----------------------------------------------------------------------------

func (a *App) changesDiffCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:     "diff [change-set]",
		Aliases: []string{"show", "review"},
		Short:   "Show what a change set would change",
		Long: `Check a change set against the current state without changing anything:
each staged change with its diff, the changes that conflict with changes made
since, and the services an apply would deploy. Without an argument, review
the environment's draft.

Variables appear as <tier fp:…>, never their values.`,
		Example: `  roundhouse changes diff
  roundhouse changes diff chs_01J9Z6Y4M0V8
  roundhouse changes diff --environment staging --json`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sc, err := a.loadChangeSet(ctx, f, args)
			if err != nil {
				return err
			}
			if sc.set == nil {
				if a.jsonOut {
					return a.printJSON(map[string]any{"change_set": nil})
				}
				fmt.Fprintf(a.IO.Out, "Nothing staged in %s\n", sc.envName)
				return nil
			}
			review, err := sc.sess.client.ReviewChangeSet(ctx, sc.set.ID)
			if err != nil {
				return err
			}
			sc.set = &review.ChangeSet
			if a.jsonOut {
				return a.printJSON(review)
			}
			a.printReview(sc, review)
			return nil
		},
	}
	f.register(cmd, false)
	return cmd
}

// printReview writes a change set's changes, conflicts and planned deploys.
func (a *App) printReview(sc *changeScope, r *api.ChangeSetReview) {
	c := a.IO.OutColor()
	cs := &r.ChangeSet
	review := ""
	if cs.ReviewStatus != "" && cs.ReviewStatus != api.ReviewNone {
		review = ", " + cs.ReviewStatus
	}
	fmt.Fprintf(a.IO.Out, "%s %s\n", c.Bold(cs.ID), c.Dim(fmt.Sprintf("(%s, %s, revision %d, %s%s)",
		sc.headerLabel(), cs.Status, cs.Revision, plural(cs.OpCount, "change", "changes"), review)))
	conflicts := map[string]api.StagedConflict{}
	for _, cf := range cs.Changes {
		if cf.Conflict != nil {
			conflicts[cf.ID] = *cf.Conflict
		}
	}
	for _, cf := range r.Conflicts {
		conflicts[cf.ID] = cf.Conflict
	}
	rebases := map[string]bool{}
	for _, id := range r.Rebases {
		rebases[id] = true
	}
	for _, ch := range cs.Changes {
		fmt.Fprintln(a.IO.Out)
		status := ""
		switch _, conflicted := conflicts[ch.ID]; {
		case conflicted:
			status = "  " + c.Red("conflicted")
		case rebases[ch.ID]:
			status = "  " + c.Yellow("rebases")
		case ch.Status != api.StagedPending:
			status = "  " + c.Dim(ch.Status)
		}
		fmt.Fprintf(a.IO.Out, "  %s%s\n", c.Bold(ch.Summary), status)
		for _, d := range ch.Diff {
			fmt.Fprintf(a.IO.Out, "    %s: %s -> %s\n", d.Path, diffSide(d.Path, d.Before), diffSide(d.Path, d.After))
		}
		if cf, ok := conflicts[ch.ID]; ok {
			fmt.Fprintf(a.IO.Out, "    %s %s\n", c.Red("conflict:"), conflictText(cf))
		}
	}
	if len(cs.Changes) == 0 {
		fmt.Fprintf(a.IO.Out, "\n  %s\n", c.Dim("no changes staged"))
	}
	fmt.Fprintln(a.IO.Out)
	if n := len(conflicts); n > 0 {
		fmt.Fprintf(a.IO.Out, "%s %s must be resolved in the dashboard before applying\n", c.Red("conflicts:"), plural(n, "change", "changes"))
	}
	deploys := make([]string, len(r.Deploys))
	for i, d := range r.Deploys {
		deploys[i] = fmt.Sprintf("%s (%s)", d.Name, d.Reason)
	}
	if len(deploys) == 0 {
		deploys = []string{"nothing"}
	}
	fmt.Fprintf(a.IO.Out, "%s %s\n", c.Dim("will deploy:"), strings.Join(deploys, ", "))
	if line := reviewLine(r); line != "" {
		fmt.Fprintf(a.IO.Out, "%s %s\n", c.Dim("review:"), line)
	}
	if cs.ReviewNote != nil {
		fmt.Fprintf(a.IO.Out, "%s %s\n", c.Dim("note:"), sanitizeCell(*cs.ReviewNote, maxReviewNote))
	}
}

// maxReviewNote is the API's longest review note.
const maxReviewNote = 500

// reviewLine words where a set is in review, or "" when nobody asked for a
// review and none is required.
func reviewLine(r *api.ChangeSetReview) string {
	cs := &r.ChangeSet
	var line string
	switch {
	case cs.ReviewStatus == api.ReviewRejected:
		line = "rejected" + byUser(cs.RejectedBy)
	case cs.ReviewStatus == api.ReviewApproved || r.Approval.Approved:
		line = "approved" + byUser(cs.ApprovedBy)
	case cs.ReviewStatus == api.ReviewSubmitted:
		line = "waiting for a reviewer"
	case r.Approval.Required:
		line = "not submitted"
	default:
		return ""
	}
	if r.Approval.Required && !r.Approval.Approved {
		line += "; approval required before applying"
	}
	return line
}

func byUser(user *string) string {
	if user == nil {
		return ""
	}
	return " by " + *user
}

func conflictText(cf api.StagedConflict) string {
	if cf.Deleted {
		return "its target no longer exists"
	}
	if len(cf.Paths) > 0 {
		return "changed since it was staged (" + strings.Join(cf.Paths, ", ") + ")"
	}
	return "changed since it was staged"
}

// diffSide renders one side of a diff entry.
//
// SECURITY: a variable's side is reduced to its tier and fingerprint, and
// anything else under /variables/ is hidden, so no value is printed even
// if a control plane sent one.
func diffSide(path string, raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return "(none)"
	}
	if strings.HasPrefix(path, "/variables/") {
		var v struct {
			Tier        string `json:"tier"`
			Fingerprint string `json:"fingerprint"`
		}
		if json.Unmarshal(raw, &v) != nil || v.Tier == "" {
			return "<hidden>"
		}
		if v.Fingerprint == "" {
			return "<" + v.Tier + ">"
		}
		return "<" + v.Tier + " fp:" + v.Fingerprint + ">"
	}
	var masked struct {
		Masked bool `json:"masked"`
	}
	if json.Unmarshal(raw, &masked) == nil && masked.Masked {
		return "<masked>"
	}
	var buf bytes.Buffer
	if json.Compact(&buf, raw) != nil {
		return "<invalid>"
	}
	s := []rune(buf.String())
	if len(s) > maxDiffValue {
		return string(s[:maxDiffValue-1]) + "…"
	}
	return string(s)
}

// -----------------------------------------------------------------------------
// Apply and discard
// -----------------------------------------------------------------------------

func (a *App) changesApplyCmd() *cobra.Command {
	var f targetFlags
	var yes, noDeploy bool
	cmd := &cobra.Command{
		Use:   "apply [change-set]",
		Short: "Apply a change set",
		Long: `Apply a change set exactly as reviewed: every change is checked again for
you in the target environment, written at once, and the services it affects
are deployed (unless --no-deploy). Without an argument, apply the
environment's draft. Shows the changes and asks for confirmation unless
--yes is given.

The apply is refused when the set changed after it was shown, or when a
change conflicts with changes made since it was staged; resolve conflicts
in the dashboard and apply again.`,
		Example: `  roundhouse changes apply
  roundhouse changes apply --yes --json
  roundhouse changes apply chs_01J9Z6Y4M0V8 --no-deploy`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runChangesApply(cmd.Context(), f, args, yes, noDeploy)
		},
	}
	f.register(cmd, false)
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	cmd.Flags().BoolVar(&noDeploy, "no-deploy", false, "apply without deploying the affected services")
	return cmd
}

func (a *App) runChangesApply(ctx context.Context, f targetFlags, args []string, yes, noDeploy bool) error {
	sc, err := a.requireOpen(ctx, f, args, "applied")
	if err != nil {
		return err
	}
	review, err := sc.sess.client.ReviewChangeSet(ctx, sc.set.ID)
	if err != nil {
		return err
	}
	sc.set = &review.ChangeSet
	cs := sc.set
	if cs.OpCount == 0 {
		return exitcode.New(exitcode.Conflict, "%s has no changes to apply", sc.label())
	}
	if len(review.Conflicts) > 0 {
		lines := make([]string, 0, len(review.Conflicts))
		for _, cf := range review.Conflicts {
			lines = append(lines, "  "+changeSummary(cs, cf.ID)+": "+conflictText(cf.Conflict))
		}
		return withHint(exitcode.New(exitcode.Conflict, "%s with changes made since they were staged:\n%s",
			plural(len(lines), "staged change conflicts", "staged changes conflict"), strings.Join(lines, "\n")), sc.dashboardHint())
	}
	// The API refuses these too; checking first spares a confirmation that
	// can only fail.
	switch {
	case cs.ReviewStatus == api.ReviewRejected:
		return withHint(exitcode.New(exitcode.Conflict, "%s was rejected%s at revision %d", capitalize(sc.label()), byUser(cs.RejectedBy), cs.Revision), sc.rejectedHint())
	case review.Approval.Required && !review.Approval.Approved:
		return withHint(exitcode.New(exitcode.Forbidden, "%s requires an approval before changes apply", sc.envName), sc.approvalHint())
	}
	if !a.jsonOut {
		a.printReview(sc, review)
	}
	if !yes {
		question := fmt.Sprintf("Apply %s to %s", plural(cs.OpCount, "change", "changes"), sc.envName)
		switch {
		case noDeploy:
			question += " without deploying?"
		case len(review.Deploys) > 0:
			question += fmt.Sprintf(" and deploy %s?", plural(len(review.Deploys), "service", "services"))
		default:
			question += "?"
		}
		ok, err := a.IO.Confirm(question, false, "pass --yes")
		if err != nil {
			return err
		}
		if !ok {
			return exitcode.New(exitcode.Error, "apply aborted")
		}
	}
	in := api.ApplyChangeSetInput{ExpectedRevision: cs.Revision, Deploy: api.DeployAffected}
	if noDeploy {
		in.Deploy = api.DeployNone
	}
	res, err := sc.sess.client.ApplyChangeSet(ctx, cs.ID, in)
	if err != nil {
		return a.applyError(sc, err)
	}
	if a.jsonOut {
		return a.printJSON(res)
	}
	c := a.IO.OutColor()
	fmt.Fprintf(a.IO.Out, "%s Applied %s to %s (%s)\n", c.Green("✓"), plural(cs.OpCount, "change", "changes"), sc.envName, cs.ID)
	for _, id := range res.DeploymentIDs {
		fmt.Fprintf(a.IO.Out, "  %s %s  %s\n", c.Dim("Deploying:"), c.Bold(id), c.Dim("roundhouse logs --deployment "+id+" -f"))
	}
	for _, s := range res.Skipped {
		fmt.Fprintf(a.IO.Out, "  %s %s: %s\n", c.Dim("Skipped:  "), s.ServiceID, s.Reason)
	}
	switch {
	case noDeploy:
		fmt.Fprintln(a.IO.Out, "Nothing deployed. Run `roundhouse deploy` to roll the changes out.")
	case len(res.DeploymentIDs) == 0 && len(res.Skipped) == 0:
		fmt.Fprintln(a.IO.Out, "No service needed a deployment.")
	}
	return nil
}

// applyError adds the next step to the refusals an apply can meet.
func (a *App) applyError(sc *changeScope, err error) error {
	var apiErr *api.Error
	if !errors.As(err, &apiErr) {
		return err
	}
	switch apiErr.Code {
	case "change_set_conflict":
		return withHint(err, sc.dashboardHint())
	case "change_set_changed":
		return withHint(err, fmt.Sprintf("someone staged or resolved changes meanwhile; review with `roundhouse changes diff %s` and apply again", sc.set.ID))
	case "invalid_references":
		return withHint(err, "fix the references in the staged variables, then apply again")
	case "approval_required":
		return withHint(err, sc.approvalHint())
	case "change_set_rejected":
		return withHint(err, sc.rejectedHint())
	case "forbidden":
		if sc.set.ReviewStatus == api.ReviewApproved {
			return withHint(err, "whoever approved a change set can't also apply it; ask someone else to run `roundhouse changes apply "+sc.set.ID+"`")
		}
	}
	return err
}

// approvalHint words how a set waiting for approval moves on.
func (sc *changeScope) approvalHint() string {
	if sc.set.ReviewStatus == api.ReviewSubmitted {
		return fmt.Sprintf("it is waiting for a reviewer: someone else with the changes:approve permission runs `roundhouse changes approve %s`", sc.set.ID)
	}
	return fmt.Sprintf("submit it for review with `roundhouse changes submit %s`; someone else with the changes:approve permission then approves it", sc.set.ID)
}

// rejectedHint words how a rejected set moves on.
func (sc *changeScope) rejectedHint() string {
	return fmt.Sprintf("change it in the dashboard, or ask for another review with `roundhouse changes submit %s`", sc.set.ID)
}

// changeSummary is the summary of the op with id, or the id itself.
func changeSummary(cs *api.ChangeSet, id string) string {
	for _, ch := range cs.Changes {
		if ch.ID == id {
			return ch.Summary
		}
	}
	return id
}

func (a *App) changesDiscardCmd() *cobra.Command {
	var f targetFlags
	var yes bool
	cmd := &cobra.Command{
		Use:   "discard [change-set]",
		Short: "Throw a change set away",
		Long: `Discard a change set and every change staged in it; staged secret values
are erased. Without an argument, discard the environment's draft. Asks for
confirmation unless --yes is given.`,
		Example: `  roundhouse changes discard
  roundhouse changes discard chs_01J9Z6Y4M0V8 --yes`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sc, err := a.requireOpen(ctx, f, args, "discarded")
			if err != nil {
				return err
			}
			cs := sc.set
			if !yes {
				question := fmt.Sprintf("Discard %s (%s)? Staged changes can't be recovered.", sc.label(), plural(cs.OpCount, "change", "changes"))
				ok, err := a.IO.Confirm(question, false, "pass --yes")
				if err != nil {
					return err
				}
				if !ok {
					return exitcode.New(exitcode.Error, "discard aborted")
				}
			}
			out, err := sc.sess.client.DiscardChangeSet(ctx, cs.ID, api.DiscardChangeSetInput{ExpectedRevision: cs.Revision})
			if err != nil {
				var apiErr *api.Error
				if errors.As(err, &apiErr) && apiErr.Code == "change_set_changed" {
					return withHint(err, fmt.Sprintf("review it with `roundhouse changes diff %s` and discard again", cs.ID))
				}
				return err
			}
			if a.jsonOut {
				return a.printJSON(out)
			}
			fmt.Fprintf(a.IO.Out, "Discarded %s (%s)\n", sc.label(), plural(cs.OpCount, "change", "changes"))
			return nil
		},
	}
	f.register(cmd, false)
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	return cmd
}

// capitalize upper-cases the first letter of s, for labels that start a
// sentence.
func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// -----------------------------------------------------------------------------
// Review and rebase
// -----------------------------------------------------------------------------

func (a *App) changesSubmitCmd() *cobra.Command {
	var f targetFlags
	var note string
	cmd := &cobra.Command{
		Use:   "submit [change-set]",
		Short: "Ask for a review of a change set",
		Long: `Submit a change set for review, so someone with the changes:approve
permission can approve or reject it. Without an argument, submit the
environment's draft. A set already waiting for a reviewer, or approved at its
current revision, is left as it is; a rejected set is submitted again.`,
		Example: `  roundhouse changes submit
  roundhouse changes submit chs_01J9Z6Y4M0V8 --note "Rotates the Stripe key"`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sc, err := a.requireOpen(ctx, f, args, "submitted")
			if err != nil {
				return err
			}
			before := sc.set.ReviewStatus
			out, err := sc.sess.client.SubmitChangeSet(ctx, sc.set.ID, api.SubmitChangeSetInput{ExpectedRevision: sc.set.Revision, Note: note})
			if err != nil {
				return reviewError(sc, err, "submit")
			}
			if a.jsonOut {
				return a.printJSON(out)
			}
			switch {
			case before == api.ReviewSubmitted && out.ReviewStatus == api.ReviewSubmitted:
				fmt.Fprintf(a.IO.Out, "%s is already waiting for a reviewer\n", capitalize(sc.label()))
			case out.ReviewStatus == api.ReviewApproved:
				fmt.Fprintf(a.IO.Out, "%s is already approved at revision %d\n", capitalize(sc.label()), out.Revision)
			default:
				fmt.Fprintf(a.IO.Out, "Submitted %s for review (%s, revision %d)\n", sc.label(), plural(out.OpCount, "change", "changes"), out.Revision)
			}
			return nil
		},
	}
	f.register(cmd, false)
	cmd.Flags().StringVar(&note, "note", "", "what reviewers should know")
	return cmd
}

// changesDecideCmd builds approve, or reject when approve is false.
func (a *App) changesDecideCmd(approve bool) *cobra.Command {
	var f targetFlags
	var note string
	var yes bool
	cmd := &cobra.Command{
		Use:   "approve [change-set]",
		Short: "Approve a change set",
		Long: `Approve exactly the revision of a change set shown to you; any later edit
voids the approval. Without an argument, approve the environment's draft.
Shows the changes and asks for confirmation unless --yes is given.

Needs the changes:approve permission. Nobody who opened the set or staged a
change in it may approve it, and whoever approves it can't also apply it.`,
		Example: `  roundhouse changes approve chs_01J9Z6Y4M0V8
  roundhouse changes approve --environment production --yes --json`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runChangesDecide(cmd.Context(), f, args, approve, note, yes)
		},
	}
	noteUsage := "a note for the author"
	if !approve {
		cmd.Use = "reject [change-set]"
		cmd.Short = "Reject a change set"
		cmd.Long = `Reject exactly the revision of a change set shown to you: it can't apply
until it is changed or submitted again. Without an argument, reject the
environment's draft. Shows the changes and asks for confirmation unless --yes
is given; say why with --note.

Needs the changes:approve permission. Nobody who opened the set or staged a
change in it may reject it.`
		cmd.Example = `  roundhouse changes reject chs_01J9Z6Y4M0V8 --note "Scale staging first"
  roundhouse changes reject --yes`
		noteUsage = "why the change set is rejected"
	}
	f.register(cmd, false)
	cmd.Flags().StringVar(&note, "note", "", noteUsage)
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	return cmd
}

func (a *App) runChangesDecide(ctx context.Context, f targetFlags, args []string, approve bool, note string, yes bool) error {
	verb, past := "approve", "approved"
	if !approve {
		verb, past = "reject", "rejected"
	}
	sc, err := a.requireOpen(ctx, f, args, past)
	if err != nil {
		return err
	}
	review, err := sc.sess.client.ReviewChangeSet(ctx, sc.set.ID)
	if err != nil {
		return err
	}
	sc.set = &review.ChangeSet
	cs := sc.set
	if cs.OpCount == 0 {
		return exitcode.New(exitcode.Conflict, "%s has no changes to %s", sc.label(), verb)
	}
	if !a.jsonOut {
		a.printReview(sc, review)
	}
	if !yes {
		question := fmt.Sprintf("%s %s to %s at revision %d?", capitalize(verb), plural(cs.OpCount, "change", "changes"), sc.envName, cs.Revision)
		ok, err := a.IO.Confirm(question, false, "pass --yes")
		if err != nil {
			return err
		}
		if !ok {
			return exitcode.New(exitcode.Error, "%s aborted", verb)
		}
	}
	// The revision shown above, so the decision covers exactly what was reviewed.
	in := api.ReviewDecisionInput{ExpectedRevision: cs.Revision, Note: note}
	var out *api.ChangeSet
	if approve {
		out, err = sc.sess.client.ApproveChangeSet(ctx, cs.ID, in)
	} else {
		out, err = sc.sess.client.RejectChangeSet(ctx, cs.ID, in)
	}
	if err != nil {
		return reviewError(sc, err, verb)
	}
	if a.jsonOut {
		return a.printJSON(out)
	}
	c := a.IO.OutColor()
	fmt.Fprintf(a.IO.Out, "%s %s %s at revision %d\n", c.Green("✓"), capitalize(past), sc.label(), out.Revision)
	if approve && review.Approval.Required {
		fmt.Fprintf(a.IO.Out, "Someone else applies it: `roundhouse changes apply %s`\n", cs.ID)
	}
	return nil
}

// reviewError adds the next step to the refusals submit, approve and
// reject can meet.
func reviewError(sc *changeScope, err error, verb string) error {
	var apiErr *api.Error
	if !errors.As(err, &apiErr) {
		return err
	}
	switch apiErr.Code {
	case "change_set_changed":
		return withHint(err, fmt.Sprintf("someone staged or resolved changes meanwhile; review with `roundhouse changes diff %s` and %s again", sc.set.ID, verb))
	case "self_review":
		return withHint(err, fmt.Sprintf("ask someone else with the changes:approve permission to review it with `roundhouse changes diff %s`", sc.set.ID))
	}
	return err
}

func (a *App) changesRebaseCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:   "rebase [change-set]",
		Short: "Move a change set onto the current state",
		Long: `Rebase a change set: changes whose target moved on, on fields they don't
touch, are moved onto the current state and their diffs recomputed; the rest
are marked conflicted, to resolve in the dashboard. Without an argument,
rebase the environment's draft.

When anything moves, the set's revision changes and an approval or rejection
of it is voided: it needs another review.`,
		Example: `  roundhouse changes rebase
  roundhouse changes rebase chs_01J9Z6Y4M0V8 --json`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sc, err := a.requireOpen(ctx, f, args, "rebased")
			if err != nil {
				return err
			}
			before := sc.set
			out, err := sc.sess.client.RebaseChangeSet(ctx, before.ID, api.RebaseChangeSetInput{ExpectedRevision: before.Revision})
			if err != nil {
				var apiErr *api.Error
				if errors.As(err, &apiErr) && apiErr.Code == "change_set_changed" {
					return withHint(err, fmt.Sprintf("review it with `roundhouse changes diff %s` and rebase again", before.ID))
				}
				return err
			}
			if a.jsonOut {
				return a.printJSON(out)
			}
			sc.set = &out.ChangeSet
			a.printRebase(sc, before, out)
			return nil
		},
	}
	f.register(cmd, false)
	return cmd
}

// printRebase reports what a rebase moved and what still conflicts.
func (a *App) printRebase(sc *changeScope, before *api.ChangeSet, out *api.RebasedChangeSet) {
	c := a.IO.OutColor()
	moved := out.ChangeSet.Revision != before.Revision
	switch {
	case !moved && len(out.Conflicts) == 0:
		fmt.Fprintf(a.IO.Out, "%s is up to date\n", capitalize(sc.label()))
	case len(out.Rebased) > 0:
		fmt.Fprintf(a.IO.Out, "%s Rebased %s onto the current state (revision %d)\n", c.Green("✓"),
			plural(len(out.Rebased), "change", "changes"), out.ChangeSet.Revision)
	default:
		fmt.Fprintf(a.IO.Out, "Nothing could be rebased in %s\n", sc.label())
	}
	for _, id := range out.Rebased {
		fmt.Fprintf(a.IO.Out, "  %s %s\n", c.Dim("rebased: "), changeSummary(sc.set, id))
	}
	for _, cf := range out.Conflicts {
		fmt.Fprintf(a.IO.Out, "  %s %s: %s\n", c.Red("conflict:"), changeSummary(sc.set, cf.ID), conflictText(cf.Conflict))
	}
	if moved {
		switch before.ReviewStatus {
		case api.ReviewApproved:
			fmt.Fprintln(a.IO.Out, "The approval no longer applies; the set needs another review.")
		case api.ReviewRejected:
			fmt.Fprintln(a.IO.Out, "The rejection no longer applies; the set is waiting for another review.")
		}
	}
	if len(out.Conflicts) > 0 {
		fmt.Fprintf(a.IO.Out, "Next: %s\n", sc.dashboardHint())
	}
}
