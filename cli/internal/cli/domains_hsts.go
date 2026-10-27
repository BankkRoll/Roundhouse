package cli

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/BankkRoll/Roundhouse/cli/internal/api"
	"github.com/BankkRoll/Roundhouse/cli/internal/exitcode"
)

// -----------------------------------------------------------------------------
// domain hsts
// -----------------------------------------------------------------------------

// HSTS limits, mirrored from packages/shared/src/domains.ts.
const (
	// hstsPreloadMinMaxAge is one year: the default max-age and the least the
	// preload list accepts.
	hstsPreloadMinMaxAge = 31_536_000
	// maxHSTSMaxAge is two years, the most a route may carry.
	maxHSTSMaxAge = 63_072_000
)

// hstsProblems mirrors hstsProblems in packages/shared: why the API would
// refuse a policy for this domain, empty when it would accept it.
func hstsProblems(h api.DomainHSTS, d *api.Domain) []string {
	var problems []string
	if h.MaxAge < 0 || h.MaxAge > maxHSTSMaxAge {
		problems = append(problems, fmt.Sprintf("max-age must be a whole number of seconds from 0 to %d.", maxHSTSMaxAge))
	}
	if h.Preload {
		if !h.Enabled {
			problems = append(problems, "Preload needs HSTS enabled.")
		}
		if !h.IncludeSubdomains {
			problems = append(problems, "Preload needs includeSubDomains.")
		}
		if h.MaxAge < hstsPreloadMinMaxAge {
			problems = append(problems, fmt.Sprintf("Preload needs a max-age of at least %d (one year).", hstsPreloadMinMaxAge))
		}
		if d.Wildcard || strings.HasPrefix(d.Hostname, "*.") || !d.Apex {
			problems = append(problems, "Only a registered domain's apex (example.com) can be preloaded.")
		}
	}
	return problems
}

// hstsWarnings mirrors hstsWarnings in packages/shared: cautions about a
// policy the API would accept.
func hstsWarnings(h api.DomainHSTS) []string {
	if !h.Enabled {
		return nil
	}
	var warnings []string
	if h.MaxAge == 0 {
		warnings = append(warnings, "max-age 0 tells browsers to forget the policy; use it to undo HSTS.")
	} else if h.MaxAge < 86_400 {
		warnings = append(warnings, "A max-age under a day gives little protection.")
	}
	if h.IncludeSubdomains {
		warnings = append(warnings, "includeSubDomains makes browsers refuse plain HTTP on every subdomain, including ones served elsewhere.")
	}
	if h.Preload {
		warnings = append(warnings, "Preloading is effectively irreversible: removal from browsers' lists takes months after you ask.")
	}
	return warnings
}

// hstsHeader renders the Strict-Transport-Security value a policy sends.
func hstsHeader(h api.DomainHSTS) string {
	if !h.Enabled {
		return "off"
	}
	parts := []string{fmt.Sprintf("max-age=%d", h.MaxAge)}
	if h.IncludeSubdomains {
		parts = append(parts, "includeSubDomains")
	}
	if h.Preload {
		parts = append(parts, "preload")
	}
	return strings.Join(parts, "; ")
}

// parseMaxAge reads a max-age as seconds ("31536000"), days, weeks or years
// ("180d", "2w", "1y"; a year is 365 days), or a Go duration ("12h").
func parseMaxAge(s string) (int, error) {
	bad := fmt.Errorf("invalid --max-age %q: use seconds, or a duration like 1y, 180d or 12h", s)
	s = strings.TrimSpace(s)
	if n, err := strconv.Atoi(s); err == nil {
		if n < 0 {
			return 0, bad
		}
		return n, nil
	}
	for suffix, unit := range map[string]int{"y": 365 * 86_400, "w": 7 * 86_400, "d": 86_400} {
		if num, ok := strings.CutSuffix(s, suffix); ok {
			n, err := strconv.Atoi(num)
			if err != nil || n < 0 {
				return 0, bad
			}
			return n * unit, nil
		}
	}
	d, err := time.ParseDuration(s)
	if err != nil || d < 0 || d%time.Second != 0 {
		return 0, bad
	}
	return int(d / time.Second), nil
}

func (a *App) domainHSTSCmd() *cobra.Command {
	var f targetFlags
	var enable, disable, includeSubdomains, preload bool
	var maxAge, confirmPreload string
	cmd := &cobra.Command{
		Use:   "hsts HOSTNAME",
		Short: "Show or change a custom domain's HSTS policy",
		Long: `Show a custom domain's Strict-Transport-Security policy, or change it with
flags. Unset flags keep the current value. HTTPS routes send HSTS with a
one-year max-age by default; generated domains always keep that default.

--max-age takes seconds or a duration such as 1y, 180d or 12h, up to two
years. Preload needs HSTS enabled, includeSubDomains, a max-age of at least
a year, and a registered domain's apex (example.com).

Preloading is effectively irreversible, so turning it on asks you to type
the hostname. In scripts and with --json, pass --confirm-preload HOSTNAME
instead.`,
		Example: `  roundhouse domain hsts shop.example.com
  roundhouse domain hsts shop.example.com --max-age 180d
  roundhouse domain hsts example.com --include-subdomains --max-age 2y --preload
  roundhouse domain hsts example.com --preload --confirm-preload example.com --json
  roundhouse domain hsts shop.example.com --disable`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			fl := cmd.Flags()
			if enable && disable {
				return exitcode.New(exitcode.Usage, "--enable and --disable can't be used together")
			}
			var age int
			if fl.Changed("max-age") {
				var err error
				if age, err = parseMaxAge(maxAge); err != nil {
					return exitcode.Wrap(exitcode.Usage, err)
				}
			}
			t, err := a.resolve(ctx, f, serviceRequired)
			if err != nil {
				return err
			}
			d, err := a.findDomain(ctx, t, args[0])
			if err != nil {
				return err
			}
			changing := enable || disable || fl.Changed("max-age") || fl.Changed("include-subdomains") || fl.Changed("preload")
			if !changing {
				if a.jsonOut {
					return a.printJSON(d.HSTS)
				}
				fmt.Fprintf(a.IO.Out, "%s  %s\n", d.Hostname, hstsHeader(d.HSTS))
				return nil
			}
			if d.Type != "custom" {
				return exitcode.New(exitcode.Conflict, "%s is a generated domain; it keeps the default HSTS policy", d.Hostname)
			}
			next := d.HSTS
			switch {
			case enable:
				next.Enabled = true
			case disable:
				next.Enabled = false
			}
			if fl.Changed("max-age") {
				next.MaxAge = age
			}
			if fl.Changed("include-subdomains") {
				next.IncludeSubdomains = includeSubdomains
			}
			if fl.Changed("preload") {
				next.Preload = preload
			}
			if problems := hstsProblems(next, d); len(problems) > 0 {
				return exitcode.New(exitcode.Invalid, "can't set HSTS on %s: %s", d.Hostname, strings.Join(problems, " "))
			}
			if next == d.HSTS {
				if a.jsonOut {
					return a.printJSON(d)
				}
				fmt.Fprintf(a.IO.Out, "HSTS for %s is already %s\n", d.Hostname, hstsHeader(next))
				return nil
			}
			for _, w := range hstsWarnings(next) {
				a.IO.Warn("%s", w)
			}
			in := api.UpdateDomainInput{HSTS: next}
			if next.Preload && !d.HSTS.Preload {
				if err := a.confirmPreload(d.Hostname, confirmPreload); err != nil {
					return err
				}
				in.ConfirmPreload = d.Hostname
			}
			updated, err := t.sess.client.UpdateDomain(ctx, d.ID, in)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.printJSON(updated)
			}
			fmt.Fprintf(a.IO.Out, "%s HSTS for %s: %s\n", a.IO.OutColor().Green("✓"), updated.Hostname, hstsHeader(updated.HSTS))
			if updated.HSTS.Preload && !d.HSTS.Preload {
				fmt.Fprintf(a.IO.Out, "%s\n", a.IO.OutColor().Dim("Submit "+updated.Hostname+" at https://hstspreload.org to be added to browsers' lists."))
			}
			return nil
		},
	}
	f.register(cmd, true)
	fl := cmd.Flags()
	fl.BoolVar(&enable, "enable", false, "send the Strict-Transport-Security header")
	fl.BoolVar(&disable, "disable", false, "stop sending the header (browsers keep a policy they saw until it expires; send max-age 0 first to undo it)")
	fl.StringVar(&maxAge, "max-age", "", "how long browsers remember the policy: seconds or a duration like 1y, 180d")
	fl.BoolVar(&includeSubdomains, "include-subdomains", false, "apply the policy to every subdomain (--include-subdomains=false to stop)")
	fl.BoolVar(&preload, "preload", false, "mark the policy for browsers' preload lists (--preload=false to stop)")
	fl.StringVar(&confirmPreload, "confirm-preload", "", "the hostname, to turn preload on without a prompt")
	return cmd
}

// confirmPreload gets consent to preload hostname: the --confirm-preload
// value, or the hostname typed at a prompt.
func (a *App) confirmPreload(hostname, flag string) error {
	if flag != "" {
		if flag != hostname {
			return exitcode.New(exitcode.Usage, "--confirm-preload %q does not match %q", flag, hostname)
		}
		return nil
	}
	if a.jsonOut || !a.IO.Interactive() {
		return exitcode.New(exitcode.InputRequired, "turning preload on needs confirmation; pass --confirm-preload %s", hostname)
	}
	return a.IO.ConfirmTyped("Preloading "+hostname+" can't be undone quickly: browsers will refuse plain HTTP for it and every subdomain for months.", hostname, "")
}
