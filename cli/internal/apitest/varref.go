package apitest

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// This file mirrors parseReferences and resolveVariables in
// packages/shared/src/variables.ts closely enough for the fake to validate
// `${{…}}` syntax on writes and to answer the resolved route, and
// secretDerivedVariables in packages/shared/src/variable-taint.ts to keep
// secrets out of its answer. The CLI itself never resolves references: the
// control plane does.

const sharedNamespace = "shared"

// maxResolvedValueBytes caps a resolved value, as the control plane does.
const maxResolvedValueBytes = 32 * 1024

var refBodyPattern = regexp.MustCompile(`^(?:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.)?([A-Za-z_][A-Za-z0-9_]*)$`)

// reference is one `${{…}}` in a value; start and end are byte offsets.
type reference struct {
	namespace string
	name      string
	start     int
	end       int
}

// segment is literal text or a reference.
type segment struct {
	text string
	ref  *reference
}

// syntaxError is a malformed or unclosed reference.
type syntaxError struct {
	code    string
	message string
	start   int
	end     int
}

func parseValue(value string) ([]segment, []syntaxError) {
	var segs []segment
	var errs []syntaxError
	var text strings.Builder
	flush := func() {
		if text.Len() > 0 {
			segs = append(segs, segment{text: text.String()})
			text.Reset()
		}
	}
	for i := 0; i < len(value); {
		if strings.HasPrefix(value[i:], "$${{") {
			text.WriteString("${{")
			i += 4
			continue
		}
		if !strings.HasPrefix(value[i:], "${{") {
			text.WriteByte(value[i])
			i++
			continue
		}
		closing := strings.Index(value[i+3:], "}}")
		if closing < 0 {
			errs = append(errs, syntaxError{code: "unclosed_reference", message: "Reference is missing its closing }}", start: i, end: len(value)})
			text.WriteString(value[i:])
			break
		}
		end := i + 3 + closing + 2
		m := refBodyPattern.FindStringSubmatch(strings.TrimSpace(value[i+3 : end-2]))
		if m == nil {
			errs = append(errs, syntaxError{
				code:    "malformed_reference",
				message: fmt.Sprintf("Invalid reference %s; expected ${{service.NAME}}, ${{shared.NAME}} or ${{NAME}}", value[i:end]),
				start:   i, end: end,
			})
			text.WriteString(value[i:end])
		} else {
			flush()
			segs = append(segs, segment{ref: &reference{namespace: m[1], name: m[2], start: i, end: end}})
		}
		i = end
	}
	flush()
	return segs, errs
}

// resolveInput is everything needed to build one service's environment.
type resolveInput struct {
	service  string
	services map[string]map[string]string
	shared   map[string]string
	builtins map[string]map[string]string
	// secrets holds every secret variable as "ns.NAME".
	secrets map[string]bool
}

// resolveError is a resolution problem in the value of variable ("ns.NAME").
type resolveError struct {
	code     string
	message  string
	variable string
}

// resolveEnv builds a service's environment: its built-ins overlaid by its
// own variables with every reference substituted. Variables that are secret
// or reference a secret, directly or through other variables, are left out
// and returned, sorted, in local instead.
func resolveEnv(in resolveInput) (env map[string]string, local []string, errs []resolveError) {
	r := &resolver{in: in, memo: map[string]*string{}, tainted: map[string]bool{}}
	env = map[string]string{}
	for k, v := range in.builtins[in.service] {
		env[k] = v
	}
	keys := make([]string, 0, len(in.services[in.service]))
	for k := range in.services[in.service] {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		v := r.resolve(in.service, k)
		switch {
		case r.tainted[in.service+"."+k]:
			delete(env, k)
			local = append(local, k)
		case v != nil:
			env[k] = *v
		}
	}
	if len(r.errs) > 0 {
		return nil, nil, r.errs
	}
	return env, local, nil
}

type resolver struct {
	in    resolveInput
	memo  map[string]*string
	stack []string
	errs  []resolveError
	// tainted marks resolved variables ("ns.NAME") that are secret or
	// derive from one.
	tainted map[string]bool
}

func (r *resolver) known(ns string) bool {
	if ns == sharedNamespace {
		return true
	}
	_, svc := r.in.services[ns]
	_, b := r.in.builtins[ns]
	return svc || b
}

func (r *resolver) lookup(ns, name string) (raw string, literal, ok bool) {
	if ns == sharedNamespace {
		v, ok := r.in.shared[name]
		return v, false, ok
	}
	if v, ok := r.in.services[ns][name]; ok {
		return v, false, true
	}
	if v, ok := r.in.builtins[ns][name]; ok {
		return v, true, true
	}
	return "", false, false
}

func (r *resolver) resolve(ns, name string) *string {
	key := ns + "." + name
	if v, done := r.memo[key]; done {
		return v
	}
	raw, literal, _ := r.lookup(ns, name)
	if literal {
		r.memo[key] = &raw
		return &raw
	}
	if r.in.secrets[key] {
		r.tainted[key] = true
	}
	r.stack = append(r.stack, key)
	defer func() { r.stack = r.stack[:len(r.stack)-1] }()

	segs, synErrs := parseValue(raw)
	failed := len(synErrs) > 0
	for _, e := range synErrs {
		r.errs = append(r.errs, resolveError{code: e.code, message: e.message, variable: key})
	}
	var out strings.Builder
	for _, s := range segs {
		if s.ref == nil {
			out.WriteString(s.text)
			continue
		}
		target := s.ref.namespace
		if target == "" {
			target = ns
		}
		targetKey := target + "." + s.ref.name
		_, _, defined := r.lookup(target, s.ref.name)
		switch {
		case !r.known(target):
			r.errs = append(r.errs, resolveError{code: "unknown_service", message: fmt.Sprintf("No service %q in this environment", target), variable: key})
			failed = true
		case !defined:
			r.errs = append(r.errs, resolveError{code: "unknown_variable", message: targetKey + " is not defined", variable: key})
			failed = true
		case slices.Contains(r.stack, targetKey):
			cycle := append(slices.Clone(r.stack[slices.Index(r.stack, targetKey):]), targetKey)
			r.errs = append(r.errs, resolveError{code: "cycle", message: "Variables reference each other in a loop: " + strings.Join(cycle, " → "), variable: key})
			failed = true
		default:
			v := r.resolve(target, s.ref.name)
			if r.tainted[targetKey] {
				r.tainted[key] = true
			}
			if v == nil {
				failed = true
			} else {
				out.WriteString(*v)
			}
		}
	}
	if !failed && out.Len() > maxResolvedValueBytes {
		r.errs = append(r.errs, resolveError{code: "value_too_large", message: fmt.Sprintf("%s resolves to more than %d bytes", key, maxResolvedValueBytes), variable: key})
		failed = true
	}
	if failed {
		r.memo[key] = nil
		return nil
	}
	v := out.String()
	r.memo[key] = &v
	return &v
}
