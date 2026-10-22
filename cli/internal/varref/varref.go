// Package varref parses and resolves `${{…}}` variable references.
//
// It mirrors parseReferences and resolveVariables in
// packages/shared/src/variables.ts, which the control plane runs at deploy
// time. `roundhouse run` needs the same result locally because the API has
// no route returning a service's resolved environment.
//
// Syntax, inside any value:
//   - `${{api.DATABASE_URL}}`: variable DATABASE_URL of service `api`, or one
//     of its built-ins;
//   - `${{shared.REGION}}`: shared variable REGION;
//   - `${{PORT}}`: a variable of the same scope, then its built-ins;
//   - `$${{` is a literal `${{`.
package varref

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// SharedNamespace is the reference namespace of shared variables.
const SharedNamespace = "shared"

// MaxResolvedValueBytes caps a resolved value, as the control plane does.
const MaxResolvedValueBytes = 32 * 1024

var bodyPattern = regexp.MustCompile(`^(?:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.)?([A-Za-z_][A-Za-z0-9_]*)$`)

// Reference is one `${{…}}` found in a value. Start and End are byte offsets.
type Reference struct {
	// Namespace is a service slug or "shared"; empty for `${{NAME}}`.
	Namespace string
	Name      string
	Start     int
	End       int
}

// segment is literal text or a reference.
type segment struct {
	text string
	ref  *Reference
}

// SyntaxError is a malformed or unclosed reference.
type SyntaxError struct {
	Code    string
	Message string
	Start   int
	End     int
}

// Parse splits a value into text and references.
func Parse(value string) (refs []Reference, errs []SyntaxError) {
	segs, errs := parse(value)
	for _, s := range segs {
		if s.ref != nil {
			refs = append(refs, *s.ref)
		}
	}
	return refs, errs
}

func parse(value string) ([]segment, []SyntaxError) {
	var segs []segment
	var errs []SyntaxError
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
			errs = append(errs, SyntaxError{Code: "unclosed_reference", Message: "Reference is missing its closing }}", Start: i, End: len(value)})
			text.WriteString(value[i:])
			break
		}
		end := i + 3 + closing + 2
		m := bodyPattern.FindStringSubmatch(strings.TrimSpace(value[i+3 : end-2]))
		if m == nil {
			errs = append(errs, SyntaxError{
				Code:    "malformed_reference",
				Message: fmt.Sprintf("Invalid reference %s; expected ${{service.NAME}}, ${{shared.NAME}} or ${{NAME}}", value[i:end]),
				Start:   i, End: end,
			})
			text.WriteString(value[i:end])
		} else {
			flush()
			segs = append(segs, segment{ref: &Reference{Namespace: m[1], Name: m[2], Start: i, End: end}})
		}
		i = end
	}
	flush()
	return segs, errs
}

// Input is everything needed to build one service's environment.
type Input struct {
	// Service is the slug whose environment is built.
	Service string
	// Services holds raw variables of every service that may be referenced.
	Services map[string]map[string]string
	// Shared holds raw shared variables.
	Shared map[string]string
	// Builtins holds built-in values per service slug, used verbatim.
	Builtins map[string]map[string]string
}

// Error is a resolution problem in one variable.
type Error struct {
	Code    string
	Message string
	// Variable is "namespace.NAME" of the value containing the problem.
	Variable string
}

// Error formats the problem as "namespace.NAME: message".
func (e Error) Error() string { return e.Variable + ": " + e.Message }

// Resolve builds a service's environment: its built-ins overlaid by its own
// variables with every reference substituted. It returns every error found.
//
// Algorithm: depth-first substitution with memoisation; a reference to a
// variable on the stack is a cycle. O(total size of reachable values).
func Resolve(in Input) (map[string]string, []Error) {
	r := &resolver{in: in, memo: map[string]*string{}}
	env := map[string]string{}
	for k, v := range in.Builtins[in.Service] {
		env[k] = v
	}
	keys := make([]string, 0, len(in.Services[in.Service]))
	for k := range in.Services[in.Service] {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		if v := r.resolve(in.Service, k); v != nil {
			env[k] = *v
		}
	}
	if len(r.errs) > 0 {
		return nil, r.errs
	}
	return env, nil
}

type resolver struct {
	in    Input
	memo  map[string]*string
	stack []string
	errs  []Error
}

func (r *resolver) known(ns string) bool {
	if ns == SharedNamespace {
		return true
	}
	_, svc := r.in.Services[ns]
	_, b := r.in.Builtins[ns]
	return svc || b
}

// lookup returns a raw value and whether it is a literal built-in.
func (r *resolver) lookup(ns, name string) (raw string, literal, ok bool) {
	if ns == SharedNamespace {
		v, ok := r.in.Shared[name]
		return v, false, ok
	}
	if v, ok := r.in.Services[ns][name]; ok {
		return v, false, true
	}
	if v, ok := r.in.Builtins[ns][name]; ok {
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
	r.stack = append(r.stack, key)
	defer func() { r.stack = r.stack[:len(r.stack)-1] }()

	segs, synErrs := parse(raw)
	failed := len(synErrs) > 0
	for _, e := range synErrs {
		r.errs = append(r.errs, Error{Code: e.Code, Message: e.Message, Variable: key})
	}
	var out strings.Builder
	for _, s := range segs {
		if s.ref == nil {
			out.WriteString(s.text)
			continue
		}
		target := s.ref.Namespace
		if target == "" {
			target = ns
		}
		targetKey := target + "." + s.ref.Name
		switch {
		case !r.known(target):
			r.errs = append(r.errs, Error{Code: "unknown_service", Message: fmt.Sprintf("No service %q in this environment", target), Variable: key})
			failed = true
		case !r.has(target, s.ref.Name):
			r.errs = append(r.errs, Error{Code: "unknown_variable", Message: targetKey + " is not defined", Variable: key})
			failed = true
		case slices.Contains(r.stack, targetKey):
			cycle := append(slices.Clone(r.stack[slices.Index(r.stack, targetKey):]), targetKey)
			r.errs = append(r.errs, Error{Code: "cycle", Message: "Variables reference each other in a loop: " + strings.Join(cycle, " → "), Variable: key})
			failed = true
		default:
			if v := r.resolve(target, s.ref.Name); v == nil {
				failed = true
			} else {
				out.WriteString(*v)
			}
		}
		if !failed && out.Len() > MaxResolvedValueBytes {
			break
		}
	}
	if !failed && out.Len() > MaxResolvedValueBytes {
		r.errs = append(r.errs, Error{Code: "value_too_large", Message: fmt.Sprintf("%s resolves to more than %d bytes", key, MaxResolvedValueBytes), Variable: key})
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

func (r *resolver) has(ns, name string) bool {
	_, _, ok := r.lookup(ns, name)
	return ok
}

// Namespaces returns the namespaces referenced by values, other than self,
// sorted. An unqualified reference belongs to self.
func Namespaces(values map[string]string, self string) []string {
	seen := map[string]bool{}
	for _, v := range values {
		refs, _ := Parse(v)
		for _, ref := range refs {
			if ref.Namespace != "" && ref.Namespace != self {
				seen[ref.Namespace] = true
			}
		}
	}
	out := make([]string, 0, len(seen))
	for ns := range seen {
		out = append(out, ns)
	}
	slices.Sort(out)
	return out
}
