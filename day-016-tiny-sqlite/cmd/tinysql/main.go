// Command tinysql is a small relational database with a REPL.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, in io.Reader, out, errw io.Writer) int {
	fs := flag.NewFlagSet("tinysql", flag.ContinueOnError)
	fs.SetOutput(errw)
	echo := fs.Bool("echo", false, "echo prompts and input lines (for transcripts)")
	fs.Usage = func() {
		fmt.Fprintln(errw, "usage: tinysql [-echo] <database-file>")
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return 2
	}
	db, err := openDatabase(fs.Arg(0))
	if err != nil {
		fmt.Fprintf(errw, "tinysql: %v\n", err)
		return 1
	}
	defer db.Close()

	interactive := isTerminal(in)
	if interactive {
		fmt.Fprintf(out, "tinysql, type .help for help, statements end with ';'\n")
	}
	r := &REPL{db: db, out: out, prompt: interactive, echo: *echo}
	r.Loop(in)
	return 0
}

func isTerminal(r io.Reader) bool {
	f, ok := r.(*os.File)
	if !ok {
		return false
	}
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}
