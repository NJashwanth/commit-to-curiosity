package main

import (
	"errors"
	"io"
)

// stubDB is a placeholder until the storage engine and executor exist.
type stubDB struct{}

func openDatabase(path string) (Database, error) { return stubDB{}, nil }

func (stubDB) Run(string, io.Writer) error   { return errors.New("SQL engine not built yet") }
func (stubDB) Tables() []string              { return nil }
func (stubDB) Schema(string) (string, error) { return "", nil }
func (stubDB) BTree(string, io.Writer) error { return errors.New("no such table") }
func (stubDB) Stats() string                 { return "no storage engine yet\n" }
func (stubDB) Close() error                  { return nil }
