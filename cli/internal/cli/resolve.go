package cli

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// targetFlags name the project, environment and service a command acts on.
// Each accepts an ID, a slug or a name; empty values fall back to the link.
type targetFlags struct {
	project     string
	environment string
	service     string
}

func (f *targetFlags) register(cmd *cobra.Command, withService bool) {
	cmd.Flags().StringVarP(&f.project, "project", "p", "", "project ID or slug (default: linked project)")
	cmd.Flags().StringVarP(&f.environment, "environment", "e", "", "environment ID, slug or name (default: linked, else production)")
	if withService {
		cmd.Flags().StringVarP(&f.service, "service", "s", "", "service ID, slug or name (default: linked service)")
	}
}

// target is what a command acts on.
type target struct {
	sess    *session
	project *api.ProjectDetail
	env     *api.Environment
	// service is nil when none is linked or named and none is required.
	service *api.Service
}

// serviceRequirement says how a command treats a missing service.
type serviceRequirement int

const (
	serviceOptional serviceRequirement = iota
	serviceRequired
)

// resolve connects and loads the target. Flags override the link; a missing
// project is a [exitcode.NotLinked] error.
func (a *App) resolve(ctx context.Context, f targetFlags, need serviceRequirement) (*target, error) {
	sess, err := a.connect()
	if err != nil {
		return nil, err
	}
	link, err := a.loadLink()
	if err != nil {
		return nil, err
	}
	t := &target{sess: sess}

	projectRef := f.project
	if projectRef == "" && link != nil {
		projectRef = link.ProjectID
	}
	if projectRef == "" {
		return nil, exitcode.New(exitcode.NotLinked, "no project linked to this directory; run `roundhouse link` or pass --project")
	}
	if t.project, err = a.findProject(ctx, sess.client, projectRef); err != nil {
		return nil, err
	}

	envRef := f.environment
	if envRef == "" && link != nil && link.ProjectID == t.project.ID {
		envRef = link.EnvironmentID
	}
	if t.env, err = pickEnvironment(t.project, envRef); err != nil {
		return nil, err
	}

	serviceRef := f.service
	if serviceRef == "" && link != nil && link.ProjectID == t.project.ID {
		serviceRef = link.ServiceID
	}
	switch {
	case serviceRef != "":
		svc := findService(t.project.Services, serviceRef)
		if svc == nil {
			return nil, exitcode.New(exitcode.NotFound, "no service %q in project %s", serviceRef, t.project.Name)
		}
		t.service = svc
	case need == serviceRequired:
		if t.service, err = a.chooseService(t.project); err != nil {
			return nil, err
		}
	}
	return t, nil
}

// chooseService picks the only service, or asks.
func (a *App) chooseService(p *api.ProjectDetail) (*api.Service, error) {
	switch len(p.Services) {
	case 0:
		return nil, exitcode.New(exitcode.NotFound, "project %s has no services; create one with `roundhouse services create`", p.Name)
	case 1:
		return &p.Services[0], nil
	}
	names := make([]string, len(p.Services))
	for i, s := range p.Services {
		names[i] = fmt.Sprintf("%s (%s)", s.Name, s.Slug)
	}
	i, err := a.IO.Select("Which service?", names, "pass --service or link one with `roundhouse link --service`")
	if err != nil {
		return nil, err
	}
	return &p.Services[i], nil
}

// findProject loads a project by ID, or by slug or name across the
// caller's workspaces.
func (a *App) findProject(ctx context.Context, c *api.Client, ref string) (*api.ProjectDetail, error) {
	if strings.HasPrefix(ref, "prj_") {
		return c.GetProject(ctx, ref)
	}
	me, err := c.Me(ctx)
	if err != nil {
		return nil, err
	}
	var matches []api.Project
	for _, ws := range me.Workspaces {
		projects, err := c.ListProjects(ctx, ws.ID)
		if err != nil {
			if api.IsStatus(err, http.StatusForbidden) {
				continue
			}
			return nil, err
		}
		for _, p := range projects {
			if matchRef(ref, p.ID, p.Slug, p.Name) {
				matches = append(matches, p)
			}
		}
	}
	switch len(matches) {
	case 0:
		return nil, exitcode.New(exitcode.NotFound, "no project %q in your workspaces", ref)
	case 1:
		return c.GetProject(ctx, matches[0].ID)
	}
	return nil, exitcode.New(exitcode.Usage, "%q matches %d projects in different workspaces; pass the project ID", ref, len(matches))
}

// pickEnvironment finds ref, or the production environment when ref is empty.
func pickEnvironment(p *api.ProjectDetail, ref string) (*api.Environment, error) {
	for i, e := range p.Environments {
		if ref == "" && e.Kind == "production" || ref != "" && matchRef(ref, e.ID, e.Slug, e.Name) {
			return &p.Environments[i], nil
		}
	}
	if ref == "" {
		if len(p.Environments) > 0 {
			return &p.Environments[0], nil
		}
		return nil, exitcode.New(exitcode.NotFound, "project %s has no environments", p.Name)
	}
	return nil, exitcode.New(exitcode.NotFound, "no environment %q in project %s", ref, p.Name)
}

func findService(services []api.Service, ref string) *api.Service {
	for i, s := range services {
		if matchRef(ref, s.ID, s.Slug, s.Name) {
			return &services[i]
		}
	}
	return nil
}

// matchRef reports whether ref names a resource by ID, slug or name (names
// compare case-insensitively).
func matchRef(ref, id, slug, name string) bool {
	return ref == id || ref == slug || strings.EqualFold(ref, name)
}

// findWorkspace picks a workspace by ID, slug or name; with an empty ref it
// uses the linked workspace, the only one, or asks.
func (a *App) findWorkspace(ctx context.Context, c *api.Client, ref string) (*api.Membership, error) {
	me, err := c.Me(ctx)
	if err != nil {
		return nil, err
	}
	if ref == "" {
		if l, _ := a.loadLink(); l != nil {
			ref = l.WorkspaceID
		}
	}
	if ref != "" {
		for i, w := range me.Workspaces {
			if matchRef(ref, w.ID, w.Slug, w.Name) {
				return &me.Workspaces[i], nil
			}
		}
		return nil, exitcode.New(exitcode.NotFound, "no workspace %q among yours", ref)
	}
	switch len(me.Workspaces) {
	case 0:
		return nil, exitcode.New(exitcode.NotFound, "you are not a member of any workspace")
	case 1:
		return &me.Workspaces[0], nil
	}
	names := make([]string, len(me.Workspaces))
	for i, w := range me.Workspaces {
		names[i] = fmt.Sprintf("%s (%s, %s)", w.Name, w.Slug, w.Role)
	}
	i, err := a.IO.Select("Which workspace?", names, "pass --workspace")
	if err != nil {
		return nil, err
	}
	return &me.Workspaces[i], nil
}

// latestDeployment returns the newest deployment of the target's service
// in its environment, or nil when there is none.
func latestDeployment(ctx context.Context, t *target) (*api.Deployment, error) {
	page, err := t.sess.client.ListDeployments(ctx, t.service.ID, t.env.ID, "", 1)
	if err != nil {
		return nil, err
	}
	if len(page.Deployments) == 0 {
		return nil, nil
	}
	return &page.Deployments[0], nil
}

// dashboardURL links to a page of the web dashboard.
func dashboardURL(base, workspaceID, projectID, serviceID string) string {
	u := strings.TrimRight(base, "/") + "/w/" + workspaceID + "/p/" + projectID
	if serviceID != "" {
		u += "/s/" + serviceID
	}
	return u
}
