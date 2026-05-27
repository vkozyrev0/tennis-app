# Archive — machine-transfer artifacts

One-off snapshots committed so the working dev environment can be
restored on another PC. **Not part of the app**; safe to delete if
you're not in the middle of a machine move.

## `claude-sessions/`

Copy of `~/.claude/projects/C--Users-vkozy-repos-{adks-tennis,tennis-app}/`
— Claude Code's per-project transcript directories. To restore on the
new PC:

```bash
# After `git pull`, copy them into place under your home directory:
mkdir -p ~/.claude/projects/
cp -r .archive/claude-sessions/adks-tennis  ~/.claude/projects/C--Users-<NEWUSER>-repos-adks-tennis
cp -r .archive/claude-sessions/tennis-app   ~/.claude/projects/C--Users-<NEWUSER>-repos-tennis-app
```

The folder name must match the *encoded absolute path* of the project
on the new PC (`\` → `-`, `:` removed). If your new username is `vk`
and the repo lives at `C:\Users\vk\repos\tennis-app`, the folder name
becomes `C--Users-vk-repos-tennis-app`.

Then run `claude` inside the repo and `/resume` — every prior session
appears in the picker.

These transcripts are ~50MB total. Once you've resumed on the new PC,
you can delete this archive directory: `git rm -r .archive/claude-sessions`.

## `../backend/snapshots/courtops-demo.sql`

`pg_dump` of the current working `courtops` database — the demo
tournaments, players, officials, etc. that have been entered through
the UI during development. Restore with:

```bash
# Create the empty DB first if it doesn't exist:
createdb courtops
# Restore:
psql courtops < backend/snapshots/courtops-demo.sql
```

Or if you'd rather start clean, skip the restore and run the normal
bootstrap: `python migrate.py && python seed.py`.
