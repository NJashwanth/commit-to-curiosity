package exec

import (
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

// Format prints a result the way the REPL shows it: a message for statements
// that change things, an aligned table for queries.
func Format(w io.Writer, r *Result) error {
	if !r.IsQuery {
		if r.Message == "" {
			return nil
		}
		_, err := fmt.Fprintln(w, r.Message)
		return err
	}
	widths := make([]int, len(r.Columns))
	cells := make([][]string, len(r.Rows))
	for i, c := range r.Columns {
		widths[i] = utf8.RuneCountInString(c)
	}
	for ri, row := range r.Rows {
		cells[ri] = make([]string, len(row))
		for i, v := range row {
			s := strings.NewReplacer("\n", `\n`, "\r", `\r`).Replace(v.String())
			cells[ri][i] = s
			if n := utf8.RuneCountInString(s); n > widths[i] {
				widths[i] = n
			}
		}
	}
	line := func(cols []string) string {
		parts := make([]string, len(cols))
		for i, c := range cols {
			if i < len(cols)-1 {
				c += strings.Repeat(" ", widths[i]-utf8.RuneCountInString(c))
			}
			parts[i] = c
		}
		return strings.Join(parts, " | ")
	}
	var sb strings.Builder
	sb.WriteString(line(r.Columns) + "\n")
	dashes := make([]string, len(widths))
	for i, wd := range widths {
		dashes[i] = strings.Repeat("-", wd)
	}
	sb.WriteString(strings.Join(dashes, "-+-") + "\n")
	for _, row := range cells {
		sb.WriteString(line(row) + "\n")
	}
	sb.WriteString("(" + plural(len(r.Rows), "row") + ")\n")
	_, err := io.WriteString(w, sb.String())
	return err
}

// FormatRaw prints rows with values joined by '|' and no header or footer,
// the same shape as `sqlite3` list mode (NULL prints as an empty field).
func FormatRaw(r *Result) string {
	var sb strings.Builder
	for _, row := range r.Rows {
		for i, v := range row {
			if i > 0 {
				sb.WriteByte('|')
			}
			if !v.IsNull() {
				sb.WriteString(v.String())
			}
		}
		sb.WriteByte('\n')
	}
	return sb.String()
}
