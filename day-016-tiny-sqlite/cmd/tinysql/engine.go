package main

import "github.com/NJashwanth/commit-to-curiosity/day-016-tiny-sqlite/internal/exec"

func openDatabase(path string) (Database, error) {
	db, err := exec.Open(path, exec.Options{})
	if err != nil {
		return nil, err
	}
	return db, nil
}
