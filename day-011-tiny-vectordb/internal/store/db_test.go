package store

import (
	"errors"
	"testing"
)

func TestDBCollections(t *testing.T) {
	db := NewDB()
	if _, err := db.Create(Config{Name: "beta", Dim: 4}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Create(Config{Name: "alpha", Dim: 8, Metric: "dot"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Create(Config{Name: "alpha", Dim: 8}); !errors.Is(err, ErrExists) {
		t.Errorf("duplicate create: %v", err)
	}
	if _, err := db.Create(Config{Name: "bad name", Dim: 8}); !errors.Is(err, ErrInvalid) {
		t.Errorf("invalid create: %v", err)
	}
	list := db.List()
	if len(list) != 2 || list[0].Name() != "alpha" || list[1].Name() != "beta" {
		t.Errorf("List = %v", list)
	}
	c, err := db.Get("alpha")
	if err != nil || c.Config().Metric != "dot" || c.Config().Dim != 8 {
		t.Errorf("Get(alpha) = %+v, %v", c, err)
	}
	if _, err := db.Get("gamma"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get(gamma): %v", err)
	}
	if err := db.Drop("alpha"); err != nil {
		t.Fatal(err)
	}
	if err := db.Drop("alpha"); !errors.Is(err, ErrNotFound) {
		t.Errorf("second drop: %v", err)
	}
	if len(db.List()) != 1 {
		t.Errorf("List after drop = %d", len(db.List()))
	}
}
