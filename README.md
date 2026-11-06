# commit-to-curiosity

One small, interesting project a day.

I'm learning AI, and I'm building alongside it. Some days the project uses AI, some days it doesn't. Each one starts with a question I wanted answered. The rule is to ship something small every day rather than something perfect once in a while.

## Projects

<!-- PROJECTS-START -->
| Day | Project | Tech | AI? | Summary |
|-----|---------|------|-----|---------|
| 001 | [weather-bot](day-001-weather-bot/) | Python, Open-Meteo, Claude API | Yes | Ask weather questions in plain English; Claude gives practical advice, or a clean emoji forecast without an API key. |
| 002 | [ask-my-repo](day-002-ask-my-repo/) | | | |
<!-- PROJECTS-END -->

## How it works

Every project lives in its own folder at the repo root:

```
day-001-weather-bot/
day-002-some-other-idea/
...
```

- **Naming:** `day-NNN-project-name`. The day number is 3-digit zero padded, and the project name is lowercase kebab-case.
- **README:** each folder gets a README copied from [`_template/README.md`](_template/README.md), covering what it does, why I built it, the tech used, how to run it, what I learned, and ideas to extend it.
- **Index:** every project gets a row in the table above.

To start a new day:

```bash
./new-day.sh weather-bot
```

This creates the next `day-NNN-weather-bot/` folder, fills the template with the day number, project name and today's date, and adds a row to the index. Afterwards, fill in the Tech, AI? and Summary columns.
