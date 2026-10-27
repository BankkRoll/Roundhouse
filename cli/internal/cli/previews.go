package cli

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// Widths, in runes, that pull request text is cut to in tables and
// summaries.
const (
	maxPreviewTitle = 40
	maxPreviewText  = 100
)

func (a *App) previewsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "previews",
		Aliases: []string{"preview"},
		Short:   "List, approve and tear down pull request previews",
		Long: `Work with a project's pull request previews: environments the control plane
creates from a pull request when it is opened or pushed to, and tears down
when it is closed or expires.

A preview of a pull request from a fork waits in pending_approval until a
maintainer approves its exact head commit, here or with the approval label
on GitHub; a later push needs a new approval. A preview is named by its ID
or by its pull request number (#12, or acme/shop#12 when the project builds
several repositories).`,
		Example: `  roundhouse previews list
  roundhouse previews approve 12
  roundhouse previews redeploy 12
  roundhouse previews destroy prv_01J9Z6Y4M0V8 --yes`,
		Args: noArgs,
	}
	cmd.AddCommand(a.previewsListCmd(), a.previewsApproveCmd(), a.previewsRedeployCmd(), a.previewsDestroyCmd())
	return cmd
}

func registerProjectFlag(cmd *cobra.Command, project *string) {
	cmd.Flags().StringVarP(project, "project", "p", "", "project ID or slug (default: linked project)")
}

// resolveProject connects and loads the project named by ref, else the
// linked one. Unlike [App.resolve] it ignores the linked environment and
// service, which a preview command never acts on.
func (a *App) resolveProject(ctx context.Context, ref string) (*session, *api.ProjectDetail, error) {
	sess, err := a.connect()
	if err != nil {
		return nil, nil, err
	}
	if ref == "" {
		link, err := a.loadLink()
		if err != nil {
			return nil, nil, err
		}
		if link != nil {
			ref = link.ProjectID
		}
	}
	if ref == "" {
		return nil, nil, exitcode.New(exitcode.NotLinked, "no project linked to this directory; run `roundhouse link` or pass --project")
	}
	p, err := a.findProject(ctx, sess.client, ref)
	if err != nil {
		return nil, nil, err
	}
	return sess, p, nil
}

// previewRef is a parsed preview argument: an ID, or a pull request
// number optionally qualified by its repository.
type previewRef struct {
	id   string
	repo string
	pr   int
}

// parsePreviewRef accepts prv_…, 12, #12 and owner/repo#12.
func parsePreviewRef(s string) (previewRef, error) {
	if strings.HasPrefix(s, "prv_") {
		return previewRef{id: s}, nil
	}
	repo, num, qualified := strings.Cut(s, "#")
	if !qualified {
		repo, num = "", s
	} else if repo != "" && strings.Count(repo, "/") != 1 {
		return previewRef{}, exitcode.New(exitcode.Usage, "invalid preview %q: expected a preview ID (prv_…), a pull request number, or owner/repo#number", s)
	}
	n, err := strconv.Atoi(num)
	if err != nil || n <= 0 || strings.HasPrefix(num, "+") {
		return previewRef{}, exitcode.New(exitcode.Usage, "invalid preview %q: expected a preview ID (prv_…), a pull request number, or owner/repo#number", s)
	}
	return previewRef{repo: repo, pr: n}, nil
}

// findPreview loads the preview named by arg: by ID directly, or by pull
// request number among the project's previews, closed ones included.
func (a *App) findPreview(ctx context.Context, project, arg string) (*session, *api.Preview, error) {
	ref, err := parsePreviewRef(arg)
	if err != nil {
		return nil, nil, err
	}
	if ref.id != "" {
		sess, err := a.connect()
		if err != nil {
			return nil, nil, err
		}
		p, err := sess.client.GetPreview(ctx, ref.id)
		return sess, p, err
	}
	sess, proj, err := a.resolveProject(ctx, project)
	if err != nil {
		return nil, nil, err
	}
	all, err := sess.client.ListPreviews(ctx, proj.ID, true)
	if err != nil {
		return nil, nil, err
	}
	var matches []api.Preview
	for _, p := range all {
		if p.PRNumber == ref.pr && (ref.repo == "" || strings.EqualFold(p.RepoFullName, ref.repo)) {
			matches = append(matches, p)
		}
	}
	switch len(matches) {
	case 0:
		return nil, nil, exitcode.New(exitcode.NotFound, "project %s has no preview of pull request %s; list them with `roundhouse previews list --all`", proj.Name, arg)
	case 1:
		return sess, &matches[0], nil
	}
	ids := make([]string, len(matches))
	for i, p := range matches {
		ids[i] = fmt.Sprintf("%s (%s)", p.ID, previewLabel(&p))
	}
	return nil, nil, exitcode.New(exitcode.Usage, "pull request %s matches %d previews: %s; pass the preview ID", arg, len(matches), strings.Join(ids, ", "))
}

// previewLabel names a preview's pull request, e.g. "acme/shop#12".
func previewLabel(p *api.Preview) string {
	return sanitizeCell(p.RepoFullName, maxPreviewText) + "#" + strconv.Itoa(p.PRNumber)
}

func shortSHA(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// -----------------------------------------------------------------------------
// previews list
// -----------------------------------------------------------------------------

func (a *App) previewsListCmd() *cobra.Command {
	var project string
	var all bool
	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the project's previews",
		Long: `List the project's open previews, newest pull request activity first;
--all adds closed and expired ones. SECRETS is "withheld" when the preview's
secrets were replaced by empty placeholders, as for a fork's pull request.`,
		Example: `  roundhouse previews list
  roundhouse previews list --all --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			sess, proj, err := a.resolveProject(ctx, project)
			if err != nil {
				return err
			}
			previews, err := sess.client.ListPreviews(ctx, proj.ID, all)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(previews)
			}
			if len(previews) == 0 {
				if all {
					fmt.Fprintf(a.IO.Out, "%s has no previews\n", proj.Name)
				} else {
					fmt.Fprintf(a.IO.Out, "%s has no open previews\n", proj.Name)
				}
				return nil
			}
			a.printPreviews(previews)
			return nil
		},
	}
	registerProjectFlag(cmd, &project)
	cmd.Flags().BoolVar(&all, "all", false, "include closed and expired previews")
	return cmd
}

func (a *App) printPreviews(previews []api.Preview) {
	now := a.Now()
	multiRepo := slices.ContainsFunc(previews, func(p api.Preview) bool { return p.RepoFullName != previews[0].RepoFullName })
	tb := a.newTable("pr", "title", "author", "status", "head", "secrets", "expires", "urls")
	for _, p := range previews {
		pr := "#" + strconv.Itoa(p.PRNumber)
		if multiRepo {
			pr = previewLabel(&p)
		}
		author := sanitizeCell(p.AuthorLogin, maxPreviewText)
		if p.IsFork {
			author += " (fork)"
		}
		status := p.Status
		if p.Draft {
			status += " (draft)"
		}
		secrets := "-"
		if p.Withheld {
			secrets = "withheld"
		}
		expires := "-"
		if p.ExpiresAt != nil {
			if millis(*p.ExpiresAt).After(now) {
				expires = "in " + untilShort(now, *p.ExpiresAt)
			} else {
				expires = ago(now, *p.ExpiresAt)
			}
		}
		var urls []string
		for _, s := range p.Services {
			if s.URL != nil {
				urls = append(urls, sanitizeCell(*s.URL, maxPreviewText))
			}
		}
		tb.row(pr, sanitizeCell(p.Title, maxPreviewTitle), author, status, shortSHA(sanitizeCell(p.HeadSHA, 64)),
			secrets, expires, orDash(strings.Join(urls, ", ")))
	}
	tb.flush()
}

// -----------------------------------------------------------------------------
// previews approve
// -----------------------------------------------------------------------------

func (a *App) previewsApproveCmd() *cobra.Command {
	var project string
	var yes bool
	cmd := &cobra.Command{
		Use:   "approve PREVIEW",
		Short: "Approve a fork pull request's head commit for a preview",
		Long: `Approve the head commit of a fork's pull request, so its preview is built
and deployed. The pull request, its author and the exact commit are shown
first; only that commit is approved, and a later push needs a new approval.
Approving runs the pull request's code on your servers: read it first.

PREVIEW is a preview ID or a pull request number. Asks for confirmation
unless --yes is given; in scripts --yes is required. If the pull request
moves to a new commit before the approval lands, nothing is approved and
the command exits 6.`,
		Example: `  roundhouse previews approve 12
  roundhouse previews approve acme/shop#12 --yes`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if !yes && !a.IO.Interactive() {
				return exitcode.New(exitcode.Usage, "approving a preview needs confirmation; review it with `roundhouse previews list`, then pass --yes to approve %s without asking", args[0])
			}
			sess, p, err := a.findPreview(ctx, project, args[0])
			if err != nil {
				return err
			}
			label := previewLabel(p)
			if p.Status != api.PreviewPendingApproval {
				return exitcode.New(exitcode.Conflict, "the preview of %s is %s; only a preview pending approval can be approved", label, p.Status)
			}
			headSHA := p.HeadSHA
			a.printApprovalSummary(p)
			if !yes {
				ok, err := a.IO.Confirm(fmt.Sprintf("Approve %s of %s?", shortSHA(sanitizeCell(headSHA, 64)), label), false, "pass --yes")
				if err != nil {
					return err
				}
				if !ok {
					return exitcode.New(exitcode.Error, "approve aborted; nothing was approved")
				}
			}
			out, err := sess.client.ApprovePreview(ctx, p.ID, headSHA)
			if err != nil {
				var apiErr *api.Error
				if errors.As(err, &apiErr) && apiErr.Code == "head_moved" {
					return exitcode.New(exitcode.Conflict,
						"%s has new commits since %s was shown; nothing was approved. Review the new head and run `roundhouse previews approve %s` again",
						label, shortSHA(sanitizeCell(headSHA, 64)), args[0])
				}
				return err
			}
			if a.jsonOut {
				return a.printJSON(out)
			}
			fmt.Fprintf(a.IO.Out, "%s Approved %s of %s; the preview is %s\n", a.IO.OutColor().Green("✓"),
				shortSHA(sanitizeCell(headSHA, 64)), label, out.Status)
			return nil
		},
	}
	registerProjectFlag(cmd, &project)
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	return cmd
}

// printApprovalSummary shows, on stderr so --json output stays clean, what
// an approval lets run.
func (a *App) printApprovalSummary(p *api.Preview) {
	c := a.IO.ErrColor()
	w := a.IO.Err
	fmt.Fprintf(w, "Approve the preview of %s: %s\n", c.Bold(previewLabel(p)), sanitizeCell(p.Title, maxPreviewText))
	row := func(k, v string) { fmt.Fprintf(w, "  %-8s %s\n", k, v) }
	author := sanitizeCell(p.AuthorLogin, maxPreviewText)
	if p.IsFork {
		author += " " + c.Yellow("(fork)")
	}
	row("Author", author)
	branch := sanitizeCell(p.HeadRef, maxPreviewText)
	if p.HeadRepoFullName != nil {
		branch = sanitizeCell(*p.HeadRepoFullName, maxPreviewText) + ":" + branch
	} else if p.IsFork {
		branch += " (fork deleted)"
	}
	row("Branch", branch)
	row("Commit", sanitizeCell(p.HeadSHA, 64))
	if p.Withheld {
		row("Secrets", "withheld: the preview gets empty placeholders")
	} else {
		row("Secrets", c.Yellow("copied from the base environment"))
	}
	row("PR", sanitizeCell(p.PRURL, maxPreviewText*2))
	fmt.Fprintf(w, "%s\n", c.Yellow("Approving builds and runs this commit's code on your servers."))
}

// -----------------------------------------------------------------------------
// previews redeploy | destroy
// -----------------------------------------------------------------------------

func (a *App) previewsRedeployCmd() *cobra.Command {
	var project string
	cmd := &cobra.Command{
		Use:   "redeploy PREVIEW",
		Short: "Deploy an active preview again at its pull request's head",
		Example: `  roundhouse previews redeploy 12
  roundhouse previews redeploy prv_01J9Z6Y4M0V8 --json`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sess, p, err := a.findPreview(ctx, project, args[0])
			if err != nil {
				return err
			}
			out, err := sess.client.RedeployPreview(ctx, p.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(out)
			}
			fmt.Fprintf(a.IO.Out, "%s Redeploying the preview of %s at %s\n", a.IO.OutColor().Green("✓"),
				previewLabel(out), shortSHA(sanitizeCell(out.HeadSHA, 64)))
			return nil
		},
	}
	registerProjectFlag(cmd, &project)
	return cmd
}

func (a *App) previewsDestroyCmd() *cobra.Command {
	var project string
	var yes bool
	cmd := &cobra.Command{
		Use:     "destroy PREVIEW",
		Aliases: []string{"rm", "delete"},
		Short:   "Tear a preview down",
		Long: `Tear a preview down: its deployments stop, its volumes are scheduled for
deletion and its domains are removed. A later push to the pull request, or
reopening it, creates the preview again.

Asks for confirmation unless --yes is given; in scripts --yes is required.`,
		Example: `  roundhouse previews destroy 12
  roundhouse previews destroy prv_01J9Z6Y4M0V8 --yes`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if !yes && !a.IO.Interactive() {
				return exitcode.New(exitcode.Usage, "tearing down a preview needs confirmation; pass --yes to destroy %s without asking", args[0])
			}
			sess, p, err := a.findPreview(ctx, project, args[0])
			if err != nil {
				return err
			}
			label := previewLabel(p)
			if p.Status == api.PreviewClosed {
				if a.jsonOut {
					return a.printJSON(p)
				}
				fmt.Fprintf(a.IO.Out, "The preview of %s is already torn down\n", label)
				return nil
			}
			if !yes {
				question := fmt.Sprintf("Tear down the preview of %s? Its deployments stop and its volumes are deleted.", label)
				ok, err := a.IO.Confirm(question, false, "pass --yes")
				if err != nil {
					return err
				}
				if !ok {
					return exitcode.New(exitcode.Error, "destroy aborted; nothing was changed")
				}
			}
			out, err := sess.client.DeletePreview(ctx, p.ID)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(out)
			}
			fmt.Fprintf(a.IO.Out, "%s Tore down the preview of %s\n", a.IO.OutColor().Green("✓"), label)
			return nil
		},
	}
	registerProjectFlag(cmd, &project)
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	return cmd
}
