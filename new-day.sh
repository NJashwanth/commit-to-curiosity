#!/usr/bin/env bash
# Scaffold the next day's project folder and add it to the index.
# Usage: ./new-day.sh <project-name>
set -euo pipefail

cd "$(dirname "$0")"

if [ $# -lt 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 <project-name>" >&2
  echo "Example: $0 weather-bot" >&2
  exit 1
fi

# Normalise to kebab-case: lowercase, spaces/underscores to hyphens, drop anything else.
name=$(printf '%s' "$*" \
  | tr '[:upper:]' '[:lower:]' \
  | tr ' _' '--' \
  | sed -E 's/[^a-z0-9-]//g; s/-+/-/g; s/^-//; s/-$//')

if [ -z "$name" ]; then
  echo "Error: project name must contain letters or numbers." >&2
  exit 1
fi

# Next day = highest existing day number + 1.
last=0
for dir in day-[0-9][0-9][0-9]-*/; do
  [ -d "$dir" ] || continue
  n=$((10#${dir:4:3}))
  [ "$n" -gt "$last" ] && last=$n
done
day=$(printf '%03d' $((last + 1)))

folder="day-${day}-${name}"
today=$(date +%Y-%m-%d)

if [ -e "$folder" ]; then
  echo "Error: $folder already exists." >&2
  exit 1
fi

mkdir "$folder"
sed -e "s/{{DAY}}/${day}/g" \
    -e "s/{{PROJECT}}/${name}/g" \
    -e "s/{{DATE}}/${today}/g" \
    _template/README.md > "$folder/README.md"

# Insert the new row just above the end marker of the index table.
row="| ${day} | [${name}](${folder}/) | | | |"
tmp=$(mktemp)
awk -v row="$row" '/<!-- PROJECTS-END -->/ { print row } { print }' README.md > "$tmp"
mv "$tmp" README.md

echo "Created $folder/ (Day $day, $today)"
echo "Next: build it, fill in $folder/README.md, and add Tech / AI? / Summary to the index row."
