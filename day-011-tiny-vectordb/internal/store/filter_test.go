package store

import (
	"errors"
	"testing"
)

func TestFilterSemantics(t *testing.T) {
	doc := map[string]any{
		"lang":  "go",
		"year":  float64(2021),
		"tags":  []any{"db", "fast"},
		"draft": false,
		"owner": map[string]any{"team": "core"},
		"note":  nil,
	}
	cases := []struct {
		filter map[string]any
		want   bool
	}{
		{nil, true},
		{map[string]any{}, true},
		{map[string]any{"lang": "go"}, true},
		{map[string]any{"lang": "rust"}, false},
		{map[string]any{"missing": "x"}, false},
		{map[string]any{"year": 2021}, true}, // int is normalized to float64
		{map[string]any{"year": "2021"}, false},
		{map[string]any{"draft": false}, true},
		{map[string]any{"tags": "db"}, true}, // array contains
		{map[string]any{"tags": "slow"}, false},
		{map[string]any{"tags": []any{"db", "fast"}}, true}, // whole array
		{map[string]any{"owner": map[string]any{"team": "core"}}, true},
		{map[string]any{"note": nil}, true},
		{map[string]any{"lang": "go", "year": 2021}, true}, // AND
		{map[string]any{"lang": "go", "year": 2020}, false},
		{map[string]any{"lang": map[string]any{"$eq": "go"}}, true},
		{map[string]any{"lang": map[string]any{"$ne": "go"}}, false},
		{map[string]any{"missing": map[string]any{"$ne": "go"}}, true},
		{map[string]any{"lang": map[string]any{"$in": []any{"rust", "go"}}}, true},
		{map[string]any{"lang": map[string]any{"$in": []any{"rust"}}}, false},
		{map[string]any{"missing": map[string]any{"$in": []any{"rust"}}}, false},
		{map[string]any{"lang": map[string]any{"$nin": []any{"rust"}}}, true},
		{map[string]any{"tags": map[string]any{"$in": []any{"fast"}}}, true},
		{map[string]any{"year": map[string]any{"$gt": 2020}}, true},
		{map[string]any{"year": map[string]any{"$gt": 2021}}, false},
		{map[string]any{"year": map[string]any{"$gte": 2021, "$lte": 2021}}, true},
		{map[string]any{"year": map[string]any{"$lt": 2021}}, false},
		{map[string]any{"lang": map[string]any{"$lt": 5}}, false}, // not a number
		{map[string]any{"draft": map[string]any{"$exists": true}}, true},
		{map[string]any{"missing": map[string]any{"$exists": false}}, true},
		{map[string]any{"lang": map[string]any{"$exists": false}}, false},
	}
	for _, c := range cases {
		f, err := CompileFilter(c.filter)
		if err != nil {
			t.Fatalf("CompileFilter(%v): %v", c.filter, err)
		}
		got := f == nil || f(doc)
		if got != c.want {
			t.Errorf("filter %v on doc = %v, want %v", c.filter, got, c.want)
		}
	}
	// A filter on a document with no metadata only matches absence checks.
	f, _ := CompileFilter(map[string]any{"lang": "go"})
	if f(nil) {
		t.Error("filter matched nil metadata")
	}
	f, _ = CompileFilter(map[string]any{"lang": map[string]any{"$exists": false}})
	if !f(nil) {
		t.Error("$exists:false should match nil metadata")
	}
}

func TestFilterErrors(t *testing.T) {
	bad := []map[string]any{
		{"x": map[string]any{"$regex": "a"}},
		{"x": map[string]any{"$in": "not-a-list"}},
		{"x": map[string]any{"$nin": 3}},
		{"x": map[string]any{"$gt": "a"}},
		{"x": map[string]any{"$exists": "yes"}},
		{"x": map[string]any{"$eq": 1, "plain": 2}},
		{"x": func() {}},
	}
	for _, spec := range bad {
		if _, err := CompileFilter(spec); !errors.Is(err, ErrInvalid) {
			t.Errorf("CompileFilter(%v) err = %v, want ErrInvalid", spec, err)
		}
	}
}
