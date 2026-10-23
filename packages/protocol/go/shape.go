package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
)

// checkShape enforces, before encoding/json fills v's type from data, the
// structural rules the zod schemas imply but encoding/json does not:
//
//   - a field without `omitempty` is required: its key must be present, and
//     non-null unless the field is a pointer (zod `.nullable()`);
//   - a field with `omitempty` is optional and may be absent or null;
//   - no key may differ from a known field name only by case.
//
// It recurses through nested structs, slices and map values, so a WorkloadSpec
// inside desired_state gets the same treatment as the top-level frame. Map
// keys are user data (env names) and are not case-checked.
func checkShape(data []byte, t reflect.Type) error {
	return checkValue(data, t, "")
}

func checkValue(data []byte, t reflect.Type, path string) error {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	switch t.Kind() {
	case reflect.Struct:
		return checkStruct(data, t, path)
	case reflect.Slice:
		if t.Elem().Kind() == reflect.Uint8 {
			return nil
		}
		var items []json.RawMessage
		if err := json.Unmarshal(data, &items); err != nil {
			return fieldErr(path, err)
		}
		for i, item := range items {
			if err := checkElem(item, t.Elem(), fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	case reflect.Map:
		var items map[string]json.RawMessage
		if err := json.Unmarshal(data, &items); err != nil {
			return fieldErr(path, err)
		}
		for k, item := range items {
			if err := checkElem(item, t.Elem(), joinPath(path, k)); err != nil {
				return err
			}
		}
	}
	return nil
}

func checkElem(data []byte, t reflect.Type, path string) error {
	if isNull(data) {
		// An interface element (a db_query_result cell) is any JSON value,
		// null included, as zod unknown is.
		if t.Kind() == reflect.Pointer || t.Kind() == reflect.Interface {
			return nil
		}
		return fmt.Errorf("%s: must not be null", path)
	}
	return checkValue(data, t, path)
}

func checkStruct(data []byte, t reflect.Type, path string) error {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return fieldErr(path, err)
	}
	if obj == nil {
		return fmt.Errorf("%s: expected a JSON object", orRoot(path))
	}
	fields := fieldsOf(t)
	for _, f := range fields {
		raw, ok := obj[f.name]
		fp := joinPath(path, f.name)
		switch {
		case !ok || isNull(raw):
			if f.optional || (ok && f.nullable) {
				continue
			}
			return fmt.Errorf("missing field %q", fp)
		default:
			if err := checkValue(raw, f.typ, fp); err != nil {
				return err
			}
		}
	}
	// SECURITY: encoding/json matches object keys case-insensitively while
	// JavaScript does not, so {"node_id":"a","NODE_ID":"b"} would mean
	// different things to the signer and to this decoder. Reject any key
	// that differs from a known field only by case.
	for got := range obj {
		for _, f := range fields {
			if got != f.name && strings.EqualFold(got, f.name) {
				return fmt.Errorf("field %q differs from %q only by case", joinPath(path, got), f.name)
			}
		}
	}
	return nil
}

type shapeField struct {
	name     string
	typ      reflect.Type
	optional bool
	nullable bool
}

// PERF: field lists are derived by reflection once per type, not per frame.
var fieldCache sync.Map

// fieldsOf lists the JSON fields of struct type t, flattening embedded
// structs the way encoding/json does.
func fieldsOf(t reflect.Type) []shapeField {
	if cached, ok := fieldCache.Load(t); ok {
		return cached.([]shapeField)
	}
	var out []shapeField
	for i := range t.NumField() {
		sf := t.Field(i)
		tag := sf.Tag.Get("json")
		if tag == "-" {
			continue
		}
		if sf.Anonymous && tag == "" && sf.Type.Kind() == reflect.Struct {
			out = append(out, fieldsOf(sf.Type)...)
			continue
		}
		if !sf.IsExported() {
			continue
		}
		name, opts, _ := strings.Cut(tag, ",")
		if name == "" {
			name = sf.Name
		}
		out = append(out, shapeField{
			name:     name,
			typ:      sf.Type,
			optional: strings.Contains(","+opts+",", ",omitempty,"),
			nullable: sf.Type.Kind() == reflect.Pointer || sf.Type.Kind() == reflect.Interface,
		})
	}
	fieldCache.Store(t, out)
	return out
}

// decodeStrict checks data's shape against v's type, then decodes it. With
// disallowUnknown, keys that match no field are errors too.
func decodeStrict(data []byte, v any, disallowUnknown bool) error {
	if err := checkShape(data, reflect.TypeOf(v)); err != nil {
		return err
	}
	if !disallowUnknown {
		return json.Unmarshal(data, v)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("unexpected data after JSON value")
	}
	return nil
}

func isNull(raw []byte) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }

func joinPath(path, name string) string {
	if path == "" {
		return name
	}
	return path + "." + name
}

func orRoot(path string) string {
	if path == "" {
		return "value"
	}
	return path
}

func fieldErr(path string, err error) error {
	if path == "" {
		return err
	}
	return fmt.Errorf("%s: %w", path, err)
}
