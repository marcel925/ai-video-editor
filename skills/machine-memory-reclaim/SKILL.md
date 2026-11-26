---
name: machine-memory-reclaim
description: Free RAM on a Mac shared by several agent sessions: score every orphaned dev process, simulator, emulator and idb_companion 1-10 for how likely it is still needed and stop 5 and below, never a session. Use for "free up RAM", "memory pressure", "what is eating memory".
---

# machine-memory-reclaim

When several agent sessions share one Mac, often across several projects, memory fills with leftovers:
dev servers whose session ended, renders and test runs that hung, simulators nobody drives. This skill
frees them without touching anything a session still uses. All the logic is in
[`tools/memory-reclaim.mts`](../../tools/memory-reclaim.mts), which needs only Node 24 on macOS and
works machine-wide from any folder.
Never `kill` or `pkill` by hand beside it: a `pkill -f` pattern hits every session's processes.

## When

Before holding any launch (a sub-agent, a render, a transcription, a simulator or emulator) because
memory has no room (see `CLAUDE.md`: critical `4`, or under 20% free), or the 1-minute load is over 6x the core count:

```bash
node tools/memory-reclaim.mts --stale
```

It reports, then stops everything scored 5 or lower without asking (owner, 2026-11-18). Re-read
`sysctl -n kern.memorystatus_vm_pressure_level kern.memorystatus_level vm.loadavg` and hold only if there is still no room.

## How likely it is still needed

Each process tree is attributed to its root: an orphan reparented to launchd, an `idb_companion`, a
booted simulator, an emulator, an agent session, a desktop app or a Docker container. Each root is scored
from its activity, not its kind, and the first matching row wins:

| Score | When | Stopped by `--stale` |
|---|---|---|
| 10 | an agent session (`claude`, `codex`) and its children, a desktop app, Docker, this tool's own session | never |
| 8 | an agent session is open in the item's worktree; a simulator whose worktree still serves it: a process started there (Metro, a dev server) that is not an orphan holds a listening TCP port, since a person testing by hand leaves the device idle and the checkout untouched | no |
| 7 | busy: over 5% CPU for a process, 25% for a simulator, 30% for an emulator | no |
| 6 | started under 30 minutes ago; its checkout's git index or HEAD log changed in the last hour; a device in the same named group as a device in use (`qa-a-…`, `qa_a_…`); an orphan holding a listening TCP port; a simulator whose worktree only an orphaned listener serves (both go once the checkout is gone); or anything whose working directory, checkout or sockets could not be read, since an unknown fails closed | no |
| 5 | an idle simulator or emulator no session claims | yes |
| 4 | an idle orphan outside any worktree (a Gradle or language-server daemon restarts on demand) | yes |
| 3 | idle, in a worktree nothing has touched for an hour | yes |
| 2 | a test runner past 30 minutes with no parent; a `control-app-<slug>` simulator whose worktree is gone | yes |
| 1 | an orphan whose working directory is gone; an `idb_companion` whose simulator is not booted | yes |

Simulators are shut down, never deleted. Everything else gets SIGTERM, then SIGKILL after 5 seconds.

## Above 5: ask first

To stop something scored 6 to 9, report and save, show the user the item with its score and reason, and
apply only what they name, by pid (orphans, emulators) or UDID (simulators):

```bash
node tools/memory-reclaim.mts --pretty --save <report-folder>/memory-report.json
node tools/memory-reclaim.mts --apply --from <report-folder>/memory-report.json --category orphans,simulators --pid <pid> --udid <udid>
```

`--apply` refuses a report over an hour old and re-scores everything first, so a restarted process or
a device that became busy is skipped. A session, app or Docker container is never stopped: name the
biggest ones so the user can close them.

## Report

Give the `Memory in use` before and after line and every stopped or skipped item with its reason. Other
sessions allocate at the same time and swap drains slowly, so the delta is approximate.
