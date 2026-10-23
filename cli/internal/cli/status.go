package cli

import (
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
)

// ref is a resource's identity in --json output.
type ref struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

// statusResult is the --json output of status.
type statusResult struct {
	URL              string          `json:"url"`
	Project          ref             `json:"project"`
	Environment      ref             `json:"environment"`
	Service          *api.Service    `json:"service"`
	Services         []api.Service   `json:"services"`
	LatestDeployment *api.Deployment `json:"latest_deployment"`
	Domains          []api.Domain    `json:"domains"`
	DashboardURL     string          `json:"dashboard_url"`
}

func (a *App) statusCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show the linked project, service, latest deployment and domain",
		Example: `  roundhouse status
  roundhouse status --service web --environment staging
  roundhouse status --json | jq -r .latest_deployment.status`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			t, err := a.resolve(ctx, f, serviceOptional)
			if err != nil {
				return err
			}
			res := statusResult{
				URL:          t.sess.url,
				Project:      ref{t.project.ID, t.project.Name, t.project.Slug},
				Environment:  ref{t.env.ID, t.env.Name, t.env.Slug},
				Service:      t.service,
				Services:     t.project.Services,
				Domains:      []api.Domain{},
				DashboardURL: dashboardURL(t.sess.url, t.project.WorkspaceID, t.project.ID, ""),
			}
			if t.service != nil {
				res.DashboardURL = dashboardURL(t.sess.url, t.project.WorkspaceID, t.project.ID, t.service.ID)
				if res.LatestDeployment, err = latestDeployment(ctx, t); err != nil {
					return err
				}
				if res.Domains, err = t.sess.client.ListDomains(ctx, t.service.ID, t.env.ID); err != nil {
					return err
				}
			}
			if a.jsonOut {
				return a.printJSON(res)
			}
			a.printStatus(&res)
			return nil
		},
	}
	f.register(cmd, true)
	return cmd
}

func (a *App) printStatus(r *statusResult) {
	c := a.IO.OutColor()
	t := a.newTable()
	t.row("Project:", r.Project.Name+" "+c.Dim("("+r.Project.ID+")"))
	t.row("Environment:", r.Environment.Name)
	if r.Service == nil {
		names := make([]string, len(r.Services))
		for i, s := range r.Services {
			names[i] = s.Slug
		}
		t.row("Service:", "none linked "+c.Dim("("+plural(len(r.Services), "service", "services")+": "+strings.Join(names, ", ")+")"))
	} else {
		t.row("Service:", r.Service.Name+" "+c.Dim("("+r.Service.ID+")"))
		if d := r.LatestDeployment; d != nil {
			line := c.Status(d.Status) + "  " + d.ID + "  " + ago(a.Now(), d.CreatedAt) + "  " + d.Trigger
			if d.FailureReason != nil {
				line += "  " + c.Red(*d.FailureReason)
			}
			t.row("Deployment:", line)
		} else {
			t.row("Deployment:", c.Dim("none yet; run `roundhouse deploy`"))
		}
		if len(r.Domains) == 0 {
			t.row("Domain:", c.Dim("none"))
		}
		for i, d := range r.Domains {
			label := ""
			if i == 0 {
				label = "Domain:"
			}
			t.row(label, d.URL)
		}
	}
	t.row("Dashboard:", r.DashboardURL)
	t.flush()
}
