package cli

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// -----------------------------------------------------------------------------
// domain list | add | remove | verify
// -----------------------------------------------------------------------------

// domainCheckInterval is the least time between two checks of one domain;
// the API answers 429 sooner. A variable so tests can shorten it.
var domainCheckInterval = 30 * time.Second

func (a *App) runDomainList(ctx context.Context, f targetFlags, all bool) error {
	t, err := a.resolve(ctx, f, serviceRequired)
	if err != nil {
		return err
	}
	envID := t.env.ID
	if all {
		envID = ""
	}
	domains, err := t.sess.client.ListDomains(ctx, t.service.ID, envID)
	if err != nil {
		return err
	}
	if a.jsonOut {
		return a.printJSON(domains)
	}
	if len(domains) == 0 {
		fmt.Fprintf(a.IO.Out, "%s has no domains in %s\n", t.service.Name, t.env.Name)
		return nil
	}
	envName := map[string]string{}
	for _, e := range t.project.Environments {
		envName[e.ID] = e.Name
	}
	tb := a.newTable("url", "environment", "type", "port", "tls", "status")
	for _, d := range domains {
		tb.row(d.URL, orDash(envName[d.EnvironmentID]), d.Type, fmt.Sprint(d.TargetPort), d.TLSStatus, orDash(d.Status))
	}
	tb.flush()
	return nil
}

func (a *App) domainListCmd() *cobra.Command {
	var f targetFlags
	var all bool
	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the service's domains",
		Example: `  roundhouse domain list
  roundhouse domain list --all --json`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.runDomainList(cmd.Context(), f, all)
		},
	}
	f.register(cmd, true)
	cmd.Flags().BoolVar(&all, "all", false, "list domains in every environment")
	return cmd
}

// printDomainRecords prints a custom domain's status and the records to create.
func (a *App) printDomainRecords(d *api.Domain) {
	c := a.IO.OutColor()
	status := d.Status
	switch d.Status {
	case "active":
		status = c.Green(status)
	case "failed":
		status = c.Red(status)
	default:
		status = c.Yellow(status)
	}
	fmt.Fprintf(a.IO.Out, "%s  %s\n", d.Hostname, status)
	if d.Error != nil && *d.Error != "" {
		fmt.Fprintf(a.IO.Out, "%s\n", c.Dim(*d.Error))
	}
	if len(d.Records) == 0 || d.Status == "active" {
		return
	}
	fmt.Fprintf(a.IO.Out, "\nCreate these DNS records:\n\n")
	tb := a.newTable("type", "name", "value", "found")
	for _, r := range d.Records {
		tb.row(r.Type, r.Name, r.Value, r.State)
	}
	tb.flush()
	for _, r := range d.Records {
		if r.Note != nil && *r.Note != "" {
			fmt.Fprintf(a.IO.Out, "\n%s\n", c.Dim(*r.Note))
			break
		}
	}
}

func (a *App) domainAddCmd() *cobra.Command {
	var f targetFlags
	cmd := &cobra.Command{
		Use:   "add HOSTNAME",
		Short: "Add a custom domain to the service",
		Long: `Add a hostname you own to the linked service in its environment, and print
the DNS records to create: a CNAME (or A/AAAA at a zone apex) that routes it
here, and a TXT record that proves you own it. Nothing is routed until both
are found; the control plane keeps checking for 72 hours. Check sooner with
` + "`roundhouse domain verify`" + `.`,
		Example: `  roundhouse domain add shop.example.com
  roundhouse domain add shop.example.com --environment staging --json`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			t, err := a.resolve(ctx, f, serviceRequired)
			if err != nil {
				return err
			}
			d, err := t.sess.client.AddDomain(ctx, t.service.ID, api.AddDomainInput{EnvironmentID: t.env.ID, Hostname: args[0]})
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(d)
			}
			fmt.Fprintf(a.IO.Out, "%s Added %s to %s in %s\n\n", a.IO.OutColor().Green("✓"), d.Hostname, t.service.Name, t.env.Name)
			a.printDomainRecords(d)
			return nil
		},
	}
	f.register(cmd, true)
	return cmd
}

// findDomain looks a domain up by hostname or ID among the service's domains
// in the target environment.
func (a *App) findDomain(ctx context.Context, t *target, ref string) (*api.Domain, error) {
	domains, err := t.sess.client.ListDomains(ctx, t.service.ID, t.env.ID)
	if err != nil {
		return nil, err
	}
	host := strings.TrimSuffix(strings.ToLower(ref), ".")
	for i, d := range domains {
		if d.ID == ref || d.Hostname == host {
			return &domains[i], nil
		}
	}
	return nil, exitcode.New(exitcode.NotFound, "%s has no domain %q in %s; list them with `roundhouse domain list`", t.service.Name, ref, t.env.Name)
}

func (a *App) domainRemoveCmd() *cobra.Command {
	var f targetFlags
	var yes bool
	cmd := &cobra.Command{
		Use:     "remove HOSTNAME",
		Aliases: []string{"rm"},
		Short:   "Remove a custom domain from the service",
		Long: `Remove a custom domain by hostname or ID. It stops routing right away;
adding it again needs a new TXT record. Generated domains follow the
service's networking settings instead.

Asks for confirmation unless --yes is given; in scripts --yes is required.`,
		Example: `  roundhouse domain remove shop.example.com
  roundhouse domain remove shop.example.com --yes`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if !yes && !a.IO.Interactive() {
				return exitcode.New(exitcode.Usage, "removing a domain needs confirmation; pass --yes to remove %s without asking", args[0])
			}
			t, err := a.resolve(ctx, f, serviceRequired)
			if err != nil {
				return err
			}
			d, err := a.findDomain(ctx, t, args[0])
			if err != nil {
				return err
			}
			if d.Type != "custom" {
				return exitcode.New(exitcode.Conflict, "%s is the generated domain; turn it off in the service's networking settings instead", d.Hostname)
			}
			if !yes {
				ok, err := a.IO.Confirm(fmt.Sprintf("Remove %s from %s in %s?", d.Hostname, t.service.Name, t.env.Name), false, "pass --yes")
				if err != nil {
					return err
				}
				if !ok {
					return exitcode.New(exitcode.Error, "remove aborted; nothing was changed")
				}
			}
			if err := t.sess.client.RemoveDomain(ctx, d.ID); err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(map[string]string{"removed": d.ID, "hostname": d.Hostname})
			}
			fmt.Fprintf(a.IO.Out, "%s Removed %s\n", a.IO.OutColor().Green("✓"), d.Hostname)
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for confirmation")
	return cmd
}

func (a *App) domainVerifyCmd() *cobra.Command {
	var f targetFlags
	var wait bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:     "verify HOSTNAME",
		Aliases: []string{"check"},
		Short:   "Check a custom domain's DNS now",
		Long: `Check a custom domain's DNS records now instead of waiting for the next
scheduled check, and print what was found. A failed domain gets a fresh
72-hour window.

With --wait, keep checking until the domain is verified (exit 0) or the
timeout passes (exit 1).`,
		Example: `  roundhouse domain verify shop.example.com
  roundhouse domain verify shop.example.com --wait --timeout 15m`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			t, err := a.resolve(ctx, f, serviceRequired)
			if err != nil {
				return err
			}
			found, err := a.findDomain(ctx, t, args[0])
			if err != nil {
				return err
			}
			if found.Type != "custom" {
				return exitcode.New(exitcode.Conflict, "%s is a generated domain; it is always verified", found.Hostname)
			}
			d, err := a.verifyDomain(ctx, t.sess.client, found, wait, timeout)
			if err != nil {
				return err
			}
			if a.jsonOut {
				if err := a.printJSON(d); err != nil {
					return err
				}
			} else {
				a.printDomainRecords(d)
			}
			if wait && d.VerificationStatus != "verified" {
				return exitcode.New(exitcode.Error, "%s was not verified within %s", d.Hostname, timeout)
			}
			return nil
		},
	}
	f.register(cmd, true)
	cmd.Flags().BoolVar(&wait, "wait", false, "keep checking until the domain is verified")
	cmd.Flags().DurationVar(&timeout, "timeout", 10*time.Minute, "with --wait, how long to keep checking")
	return cmd
}

// verifyDomain checks once, or with wait until verified or timeout. A 429
// (checked moments ago) counts as "not yet" rather than an error.
func (a *App) verifyDomain(ctx context.Context, client *api.Client, d *api.Domain, wait bool, timeout time.Duration) (*api.Domain, error) {
	deadline := time.Now().Add(timeout)
	current := d
	for {
		next, err := client.CheckDomain(ctx, d.ID)
		switch {
		case err == nil:
			current = next
		case api.IsStatus(err, http.StatusTooManyRequests):
			if !wait {
				var apiErr *api.Error
				if errors.As(err, &apiErr) {
					return nil, exitcode.New(exitcode.Error, "%s", apiErr.Message)
				}
				return nil, err
			}
		default:
			return nil, err
		}
		if !wait || current.VerificationStatus == "verified" || time.Now().After(deadline) {
			return current, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(min(domainCheckInterval, time.Until(deadline))):
		}
	}
}
