package cli

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Open-Rail/cli/internal/api"
	"github.com/BankkRoll/Open-Rail/cli/internal/exitcode"
	"github.com/BankkRoll/Open-Rail/cli/internal/ui"
)

// maxPollFailures is how many consecutive failed polls a watcher tolerates
// before giving up, so a brief network blip doesn't abort a long deploy.
const maxPollFailures = 5

func deploymentURL(base, id string) string {
	return base + "/deployments/" + id
}

func (a *App) deployCmd() *cobra.Command {
	var f targetFlags
	var wait bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:   "deploy",
		Short: "Deploy the linked service",
		Long: `Create a deployment of the service's latest config: git sources are built
from their branch head, image sources are pulled. With --wait, stream the
deployment's events until it is active or has failed; the exit code is 8
when it failed, crashed or was cancelled.

Pressing Ctrl-C while waiting stops watching; the deployment continues.`,
		Example: `  roundhouse deploy
  roundhouse deploy --wait
  roundhouse deploy --service api --environment staging --wait --timeout 15m
  roundhouse deploy --json | jq -r .id`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolve(ctx, f, serviceRequired)
			if err != nil {
				return err
			}
			d, err := t.sess.client.CreateDeployment(ctx, t.service.ID, t.env.ID)
			if err != nil {
				return err
			}
			return a.afterCreate(ctx, t.sess, d, fmt.Sprintf("Deploying %s to %s", t.service.Name, t.env.Name), wait, timeout)
		},
	}
	f.register(cmd, true)
	cmd.Flags().BoolVar(&wait, "wait", false, "stream status until the deployment is active or has failed")
	cmd.Flags().DurationVar(&timeout, "timeout", 30*time.Minute, "with --wait, give up after this long")
	return cmd
}

// afterCreate reports a new deployment and optionally watches it.
func (a *App) afterCreate(ctx context.Context, sess *session, d *api.Deployment, what string, wait bool, timeout time.Duration) error {
	c := a.IO.OutColor()
	if !a.jsonOut {
		fmt.Fprintf(a.IO.Out, "%s: %s %s\n", what, c.Bold(d.ID), c.Dim("("+d.Status+")"))
		fmt.Fprintf(a.IO.Out, "  %s %s\n", c.Dim("Dashboard:"), deploymentURL(sess.url, d.ID))
	}
	if !wait {
		if a.jsonOut {
			return a.printJSON(d)
		}
		fmt.Fprintf(a.IO.Out, "  %s roundhouse logs --deployment %s -f\n", c.Dim("Logs:     "), d.ID)
		return nil
	}
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	detail, err := a.watchDeployment(ctx, sess.client, d.ID)
	if err != nil {
		switch {
		case errors.Is(err, context.Canceled):
			a.IO.Info("Stopped watching; %s continues. Cancel it with `roundhouse cancel %s`.", d.ID, d.ID)
		case errors.Is(err, context.DeadlineExceeded):
			return exitcode.New(exitcode.Error, "timed out after %s waiting for %s; it continues on the control plane", timeout, d.ID)
		}
		return err
	}
	return a.reportSettled(ctx, sess, detail)
}

// watchDeployment polls a deployment, printing new timeline events, until
// it settles. Polling (rather than the realtime socket) keeps --wait
// working through proxies that block WebSockets, and the deployment detail
// already carries the full event timeline.
func (a *App) watchDeployment(ctx context.Context, c *api.Client, id string) (*api.DeploymentDetail, error) {
	seen := map[string]bool{}
	spin := a.IO.StartSpinner("Waiting for " + id)
	defer spin.Stop()
	pal := a.IO.OutColor()
	failures := 0
	for {
		d, err := c.GetDeployment(ctx, id)
		switch {
		case err == nil:
			failures = 0
			for _, ev := range d.Events {
				if seen[ev.ID] {
					continue
				}
				seen[ev.ID] = true
				if !a.jsonOut {
					spin.Println(a.IO.Out, fmt.Sprintf("  %s  %s", pal.Dim(millis(ev.CreatedAt).Local().Format("15:04:05")), eventText(pal, ev)))
				}
			}
			spin.Update(fmt.Sprintf("%s is %s", id, d.Status))
			if api.IsSettled(d.Status) {
				return d, nil
			}
		case ctx.Err() != nil:
			return nil, ctx.Err()
		default:
			var netErr *api.NetworkError
			if !errors.As(err, &netErr) || failures >= maxPollFailures {
				return nil, err
			}
			failures++
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(a.PollInterval):
		}
	}
}

func eventText(c ui.Palette, ev api.DeploymentEvent) string {
	if ev.Type == "error" || ev.Type == "schedule_failed" {
		return c.Red(ev.Message)
	}
	return ev.Message
}

// reportSettled prints the outcome of a watched deployment and returns
// [exitcode.DeploymentFailed] when it did not come up.
func (a *App) reportSettled(ctx context.Context, sess *session, d *api.DeploymentDetail) error {
	ok := api.IsSuccess(d.Status)
	if a.jsonOut {
		writeJSON(a.IO.Out, d)
	} else {
		c := a.IO.OutColor()
		if ok {
			fmt.Fprintf(a.IO.Out, "%s %s is %s\n", c.Green("✓"), d.ID, c.Status(d.Status))
			if domains, err := sess.client.ListDomains(ctx, d.ServiceID, d.EnvironmentID); err == nil {
				for _, dom := range domains {
					fmt.Fprintf(a.IO.Out, "  %s\n", c.Underline(dom.URL))
				}
			}
		}
	}
	if ok {
		return nil
	}
	reason := deref(d.FailureReason)
	if reason == "" {
		reason = "no reason recorded"
	}
	return exitcode.New(exitcode.DeploymentFailed, "deployment %s %s: %s", d.ID, d.Status, reason)
}

// -----------------------------------------------------------------------------
// Rollback and cancel
// -----------------------------------------------------------------------------

func (a *App) rollbackCmd() *cobra.Command {
	var f targetFlags
	var yes, wait bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:   "rollback [deployment]",
		Short: "Roll back to an earlier deployment",
		Long: `Create a new deployment from an earlier deployment's image and config,
skipping the build. Without an argument, roll back to the deployment before
the current one. Asks for confirmation unless --yes is given.`,
		Example: `  roundhouse rollback
  roundhouse rollback dep_01J9Z6Y4M0V8 --yes --wait`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			sess, src, err := a.rollbackSource(ctx, f, args)
			if err != nil {
				return err
			}
			if !yes {
				ok, err := a.IO.Confirm(fmt.Sprintf("Roll back to %s (%s, created %s)?", src.ID, src.Status, ago(a.Now(), src.CreatedAt)), false, "pass --yes")
				if err != nil {
					return err
				}
				if !ok {
					return exitcode.New(exitcode.Error, "rollback aborted")
				}
			}
			d, err := sess.client.RollbackDeployment(ctx, src.ID)
			if err != nil {
				return err
			}
			return a.afterCreate(ctx, sess, d, "Rolling back to "+src.ID, wait, timeout)
		},
	}
	f.register(cmd, true)
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	cmd.Flags().BoolVar(&wait, "wait", false, "stream status until the new deployment is active or has failed")
	cmd.Flags().DurationVar(&timeout, "timeout", 30*time.Minute, "with --wait, give up after this long")
	return cmd
}

// rollbackSource finds the deployment to roll back to: the argument, or the
// newest rollback-able deployment older than the current one.
func (a *App) rollbackSource(ctx context.Context, f targetFlags, args []string) (*session, *api.Deployment, error) {
	if len(args) == 1 {
		sess, err := a.connect()
		if err != nil {
			return nil, nil, err
		}
		d, err := sess.client.GetDeployment(ctx, args[0])
		if err != nil {
			return nil, nil, err
		}
		return sess, &d.Deployment, nil
	}
	t, err := a.resolve(ctx, f, serviceRequired)
	if err != nil {
		return nil, nil, err
	}
	page, err := t.sess.client.ListDeployments(ctx, t.service.ID, t.env.ID, "", 50)
	if err != nil {
		return nil, nil, err
	}
	current := -1
	for i, d := range page.Deployments {
		if d.Status == api.StatusActive || d.Status == api.StatusCrashed {
			current = i
			break
		}
	}
	if current >= 0 {
		for _, d := range page.Deployments[current+1:] {
			if api.IsRollbackSource(d.Status) {
				return t.sess, &d, nil
			}
		}
	}
	return nil, nil, exitcode.New(exitcode.Conflict, "no earlier deployment of %s in %s to roll back to", t.service.Name, t.env.Name)
}

func (a *App) cancelCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:   "cancel [deployment]",
		Short: "Cancel a deployment in progress",
		Long: `Cancel a queued, building or deploying deployment. Without an argument,
cancel the latest deployment of the linked service.`,
		Example: `  roundhouse cancel
  roundhouse cancel dep_01J9Z6Y4M0V8`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			var sess *session
			var id string
			if len(args) == 1 {
				s, err := a.connect()
				if err != nil {
					return err
				}
				sess, id = s, args[0]
			} else {
				t, err := a.resolve(ctx, f, serviceRequired)
				if err != nil {
					return err
				}
				latest, err := latestDeployment(ctx, t)
				if err != nil {
					return err
				}
				if latest == nil {
					return exitcode.New(exitcode.NotFound, "%s has no deployments in %s", t.service.Name, t.env.Name)
				}
				if !api.IsCancellable(latest.Status) {
					return exitcode.New(exitcode.Conflict, "the latest deployment %s is %s; nothing to cancel", latest.ID, latest.Status)
				}
				sess, id = t.sess, latest.ID
			}
			d, err := sess.client.CancelDeployment(ctx, id)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(d)
			}
			fmt.Fprintf(a.IO.Out, "Cancelled %s (%s)\n", d.ID, a.IO.OutColor().Status(d.Status))
			return nil
		},
	}
	f.register(cmd, true)
	return cmd
}
