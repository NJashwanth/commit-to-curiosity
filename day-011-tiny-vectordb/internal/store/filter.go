package store

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
)

// Filter is a compiled metadata filter. A nil Filter matches everything.
//
// Filters are JSON objects. Every key is a condition on the metadata field
// of the same name, and all conditions must hold:
//
//	{"lang": "go"}                       field equals "go", or is an array containing "go"
//	{"lang": {"$in": ["go", "rust"]}}    field equals (or contains) any of these
//	{"lang": {"$ne": "go"}}              field is missing or not "go"
//	{"year": {"$gte": 2020, "$lt": 2025}} numeric range
//	{"draft": {"$exists": false}}        field is absent
type Filter func(meta map[string]any) bool

// CompileFilter validates a filter and turns it into a predicate.
func CompileFilter(spec map[string]any) (Filter, error) {
	if len(spec) == 0 {
		return nil, nil
	}
	norm, _, err := normalizeJSON(spec)
	if err != nil {
		return nil, fmt.Errorf("%w: filter: %v", ErrInvalid, err)
	}
	keys := make([]string, 0, len(norm))
	for k := range norm {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	conds := make([]Filter, 0, len(keys))
	for _, key := range keys {
		c, err := compileCondition(key, norm[key])
		if err != nil {
			return nil, err
		}
		conds = append(conds, c)
	}
	return func(meta map[string]any) bool {
		for _, c := range conds {
			if !c(meta) {
				return false
			}
		}
		return true
	}, nil
}

func compileCondition(key string, want any) (Filter, error) {
	ops, isObj := want.(map[string]any)
	if !isObj || !hasOperator(ops) {
		return func(meta map[string]any) bool {
			v, ok := meta[key]
			return ok && matchValue(v, want)
		}, nil
	}

	var preds []func(v any, present bool) bool
	for op, arg := range ops {
		if !strings.HasPrefix(op, "$") {
			return nil, fmt.Errorf("%w: filter %q: can't mix operators and plain keys (%q)", ErrInvalid, key, op)
		}
		switch op {
		case "$eq":
			preds = append(preds, func(v any, ok bool) bool { return ok && matchValue(v, arg) })
		case "$ne":
			preds = append(preds, func(v any, ok bool) bool { return !ok || !matchValue(v, arg) })
		case "$in", "$nin":
			list, isList := arg.([]any)
			if !isList {
				return nil, fmt.Errorf("%w: filter %q: %s needs an array", ErrInvalid, key, op)
			}
			in := func(v any, ok bool) bool {
				if !ok {
					return false
				}
				for _, w := range list {
					if matchValue(v, w) {
						return true
					}
				}
				return false
			}
			if op == "$in" {
				preds = append(preds, in)
			} else {
				preds = append(preds, func(v any, ok bool) bool { return !in(v, ok) })
			}
		case "$gt", "$gte", "$lt", "$lte":
			bound, isNum := arg.(float64)
			if !isNum {
				return nil, fmt.Errorf("%w: filter %q: %s needs a number", ErrInvalid, key, op)
			}
			cmp := map[string]func(x float64) bool{
				"$gt":  func(x float64) bool { return x > bound },
				"$gte": func(x float64) bool { return x >= bound },
				"$lt":  func(x float64) bool { return x < bound },
				"$lte": func(x float64) bool { return x <= bound },
			}[op]
			preds = append(preds, func(v any, ok bool) bool {
				x, isNum := v.(float64)
				return ok && isNum && cmp(x)
			})
		case "$exists":
			want, isBool := arg.(bool)
			if !isBool {
				return nil, fmt.Errorf("%w: filter %q: $exists needs true or false", ErrInvalid, key)
			}
			preds = append(preds, func(_ any, ok bool) bool { return ok == want })
		default:
			return nil, fmt.Errorf("%w: filter %q: unknown operator %s", ErrInvalid, key, op)
		}
	}
	return func(meta map[string]any) bool {
		v, ok := meta[key]
		for _, p := range preds {
			if !p(v, ok) {
				return false
			}
		}
		return true
	}, nil
}

func hasOperator(m map[string]any) bool {
	for k := range m {
		if strings.HasPrefix(k, "$") {
			return true
		}
	}
	return false
}

// matchValue is equality, except that an array field matches any of its
// elements, so {"tags": "db"} finds {"tags": ["db", "go"]}.
func matchValue(have, want any) bool {
	if equalJSON(have, want) {
		return true
	}
	if arr, ok := have.([]any); ok {
		for _, el := range arr {
			if equalJSON(el, want) {
				return true
			}
		}
	}
	return false
}

// equalJSON compares values decoded from JSON (string, float64, bool, nil,
// []any, map[string]any).
func equalJSON(a, b any) bool {
	switch x := a.(type) {
	case string:
		y, ok := b.(string)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case nil:
		return b == nil
	}
	return reflect.DeepEqual(a, b)
}

// normalizeJSON round-trips a value through JSON so Go callers passing
// ints or structs get the same types an HTTP client would (float64,
// []any, map[string]any). It also returns the encoded size.
func normalizeJSON(m map[string]any) (map[string]any, int, error) {
	b, err := json.Marshal(m)
	if err != nil {
		return nil, 0, err
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, 0, err
	}
	return out, len(b), nil
}
