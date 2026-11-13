# CLAUDE.md

## Git rules
- Never add "Co-Authored-By: Claude" or any Claude/Anthropic trailer to commit messages.
- Never add "Generated with Claude Code" or any similar watermark, emoji, or link to commit messages, PR titles, or PR descriptions.
- Commit messages follow the format "Day XXX: project-name" for daily projects, or a short imperative summary for other changes.

## Tests
- Do not add GitHub Actions workflows or GitHub Pages deploys. Tests and coverage run locally and must pass before every commit.
