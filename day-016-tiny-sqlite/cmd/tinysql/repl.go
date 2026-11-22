package main

import (
	"bufio"
	"fmt"
	"io"
	"strings"
	"time"
)

// Database is what the REPL needs from the engine.
type Database interface {
	// Run executes every statement in src and writes results to w.
	Run(src string, w io.Writer) error
	Tables() []string
	// Schema returns CREATE TABLE text for one table, or for all when name is "".
	Schema(name string) (string, error)
	BTree(name string, w io.Writer) error
	Stats() string
	Close() error
}

// REPL is the interactive loop: meta commands start with a dot, everything
// else is SQL accumulated until a terminating semicolon.
type REPL struct {
	db     Database
	out    io.Writer
	prompt bool // print prompts (interactive terminal)
	echo   bool // echo each input line after the prompt (transcripts)
	timer  bool
}

const (
	primaryPrompt = "tinysql> "
	contPrompt    = "     ...> "
)

// Loop reads lines from in until EOF or .exit.
func (r *REPL) Loop(in io.Reader) {
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	var buf strings.Builder
	r.showPrompt(primaryPrompt)
	for sc.Scan() {
		line := sc.Text()
		if r.echo {
			fmt.Fprintln(r.out, line)
		}
		trimmed := strings.TrimSpace(line)
		if buf.Len() == 0 {
			if trimmed == "" {
				r.showPrompt(primaryPrompt)
				continue
			}
			if strings.HasPrefix(trimmed, ".") {
				if r.meta(trimmed) {
					return
				}
				r.showPrompt(primaryPrompt)
				continue
			}
		}
		buf.WriteString(line)
		buf.WriteByte('\n')
		if Complete(buf.String()) {
			r.execSQL(buf.String())
			buf.Reset()
			r.showPrompt(primaryPrompt)
		} else {
			r.showPrompt(contPrompt)
		}
	}
	if strings.TrimSpace(buf.String()) != "" {
		fmt.Fprintln(r.out, "Error: incomplete statement (missing ';')")
	}
}

func (r *REPL) showPrompt(p string) {
	if r.prompt || r.echo {
		fmt.Fprint(r.out, p)
	}
}

func (r *REPL) execSQL(src string) {
	start := time.Now()
	if err := r.db.Run(src, r.out); err != nil {
		fmt.Fprintf(r.out, "Error: %v\n", err)
	}
	if r.timer {
		fmt.Fprintf(r.out, "Run time: %.3f ms\n", float64(time.Since(start).Microseconds())/1000)
	}
}

// meta runs a dot command; it returns true when the REPL should exit.
func (r *REPL) meta(line string) bool {
	fields := strings.Fields(line)
	cmd := strings.ToLower(fields[0])
	args := fields[1:]
	switch cmd {
	case ".exit", ".quit":
		return true
	case ".help":
		fmt.Fprint(r.out, helpText)
	case ".tables":
		names := r.db.Tables()
		if len(names) == 0 {
			fmt.Fprintln(r.out, "(no tables)")
		} else {
			fmt.Fprintln(r.out, strings.Join(names, "  "))
		}
	case ".schema":
		name := ""
		if len(args) > 0 {
			name = args[0]
		}
		s, err := r.db.Schema(name)
		if err != nil {
			fmt.Fprintf(r.out, "Error: %v\n", err)
		} else if s == "" {
			fmt.Fprintln(r.out, "(no tables)")
		} else {
			fmt.Fprintln(r.out, s)
		}
	case ".btree":
		if len(args) != 1 {
			fmt.Fprintln(r.out, "usage: .btree <table>")
			break
		}
		if err := r.db.BTree(args[0], r.out); err != nil {
			fmt.Fprintf(r.out, "Error: %v\n", err)
		}
	case ".stats":
		fmt.Fprint(r.out, r.db.Stats())
	case ".timer":
		if len(args) != 1 || (args[0] != "on" && args[0] != "off") {
			fmt.Fprintln(r.out, "usage: .timer on|off")
			break
		}
		r.timer = args[0] == "on"
	default:
		fmt.Fprintf(r.out, "unknown command %s (try .help)\n", fields[0])
	}
	return false
}

const helpText = `.tables            list tables
.schema [table]    show CREATE TABLE statements
.btree <table>     print the B+tree structure of a table
.stats             show pager and cache statistics
.timer on|off      print run time after each statement
.help              show this help
.exit              quit
SQL statements end with ';' and may span several lines.
`

// Complete reports whether src ends with a semicolon that is outside any
// single-quoted string, i.e. whether the REPL should stop reading lines.
func Complete(src string) bool {
	inStr := false
	last := byte(0)
	for i := 0; i < len(src); i++ {
		c := src[i]
		if inStr {
			if c == '\'' {
				if i+1 < len(src) && src[i+1] == '\'' {
					i++ // escaped quote
				} else {
					inStr = false
					last = c
				}
			}
			continue
		}
		switch c {
		case '\'':
			inStr = true
		case ' ', '\t', '\n', '\r':
		default:
			last = c
		}
	}
	return !inStr && last == ';'
}
