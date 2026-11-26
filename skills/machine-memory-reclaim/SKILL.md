---
name: machine-memory-reclaim
description: Free RAM on a Mac shared by several agent sessions: score every orphan, idle simulator, emulator, Metro, Gradle daemon and dev server 1-10 for how likely it is still needed and stop 5 and below, another session's included once idle; never a session or a running job. Use for "free up RAM", "memory pressure", "what is eating memory".
---

# machine-memory-reclaim

When several agent sessions share one Mac, often across several projects, memory fills with leftovers:
dev servers whose session ended, renders and test runs that hung, simulators and emulators nobody drives.
This skill frees them without touching anything a session is still using. All the logic is in
[`tools/memory-reclaim.mts`](../../tools/memory-reclaim.mts), which needs only Node 24 on macOS and
works machine-wide from any folder.
Never `kill` or `pkill` by hand beside it: a `pkill -f` pattern hits every session's processes.

## When

Before holding any launch (a sub-agent, a render, a transcription, a simulator or emulator) because
memory has no room (see `CLAUDE.md`: critical `4`, or under 20% free), or the 1-minute load is over 6x the core count:

```bash
node tools/memory-reclaim.mts --aggressive
```

It reports, then stops everything scored 5 or lower without asking, other sessions' idle devices and
dev servers included (owner, 2026-11-18 and 2026-11-26). Re-read
`sysctl -n kern.memorystatus_vm_pressure_level kern.memorystatus_level vm.loadavg` and hold only if there is still no room.

`--stale` is the narrower run: the same scale, but a device or dev server that a live session or its
worktree still claims keeps its claim however idle it is. Add `--dry-run` to either to print what it
would stop and stop nothing; `--save <path>` keeps the report.

## The idle signal

A device or dev server counts as unused when its whole process tree has averaged at most this much CPU
since the newest ledger sample older than the window:

| Owner | Window | Idle at or under |
|---|---|---|
| none: an orphan reparented to launchd (its session is gone or detached it) | 10 min | 2% |
| a live session, its worktree, or nobody (a simulator or emulator) | 20 min | simulator 12%, emulator 12%, dev server 2% |

The thresholds sit between what idle and driven devices measured under a load of 900 on 2026-11-26:
idle simulators 7–9%, driven ones 44–128%; an emulator taking `adb` input 22%; idle Metro 0–0.5%, an
active one 3.3%; an idle Gradle daemon tree 0.4–1.8%. A simulator's CPU includes its `idb_companion`'s,
because the `ios-simulator` MCP drives it through that. The constants are `IDLE_WINDOW_MS`,
`ORPHAN_IDLE_WINDOW_MS` and `IDLE_CPU_PCT` in the tool.

The history comes from one machine-wide CPU ledger, `~/Library/Caches/memory-reclaim/cpu-samples.json`,
shared with the copies of this tool in the owner's other repos: every run and every session's Stop hook
([`tools/own-devices-reminder.mts`](../../tools/own-devices-reminder.mts)) adds a sample, at most one per
2 minutes, kept 90 minutes. With no sample old enough, nothing can be proven idle and the run says so in
a note; it never guesses.

Whatever the ledger says, these keep an item at 7, a claim included: over its busy CPU right now (5% for
a process, 25% for a simulator, 30% for an emulator); a client naming the device right now
(`simctl … <UDID>`, `xcodebuild`, idb, an `adb -s emulator-<port>` aimed at that emulator, or a shell
under 20 minutes old naming it); or a job in its tree. A job is work, never idle: `ffmpeg`, whisper or
Parakeet, a Remotion render, this repo's pipeline (`tools/*.py`, `tools/build.sh`, `render.mjs`),
`xcodebuild`, a Gradle build, `pod install`, `eas build`. The report lists every one under "work in
progress" with its CPU and session, and nothing stops it.

## How likely it is still needed

Each process tree is attributed to its root: an orphan reparented to launchd, an `idb_companion`, a
booted simulator, an emulator, an agent session, a desktop app or a Docker container. Under
`--aggressive` a dev server (Metro, `expo start`, `next dev`, Vite, `tsx watch`, Remotion Studio, a
Gradle daemon) or an emulator running inside a live session, this session included, is its own root,
scored like the rest. Each root is scored from its activity, not its kind, and the first matching row wins:

| Score | When | Stopped by `--aggressive` / `--stale` |
|---|---|---|
| 10 | an agent session (`claude`, `codex`) and its other children, a desktop app, Docker, this tool's own process chain | never |
| 8 | claimed: a live session runs it, an agent session is open in its worktree, or a simulator's worktree still serves it (a process started there that is not an orphan holds a listening TCP port, since a person testing by hand leaves the device idle and the checkout untouched) | if idle → 5 / no |
| 7 | busy now, driven by a client now, or running a job (above) | no |
| 6 | a server a device in use is connected to (an established TCP connection to its port; an emulator's runs through the shared adb server), mapped to (an in-use emulator's `adb reverse --list`, which outlives a reinstall's dropped connection) or named for (its worktree); while a device is in use, listening sockets, connections, an in-use emulator's `adb reverse`, the server's working directory or the worktree list unreadable, since Metro idles while the app it serves is driven; started under 30 minutes ago; its checkout's git state changed in the last hour; a device in the same named group as a device in use (`qa-a-…`, `qa_a_…`); an orphan holding a listening TCP port; a simulator whose worktree only an orphaned listener serves; or anything whose CPU, working directory, checkout or sockets could not be read, since an unknown fails closed | if idle → 5 or lower, except the served-device, same-group and unknown cases / only the young and the orphan ones, if idle |
| 5 | an idle device or dev server a session still claims (`--aggressive`); an idle-looking simulator or emulator with no 20-minute history | yes |
| 4 | an unclaimed simulator or emulator idle for 20 minutes; an idle orphan outside any worktree | yes |
| 3 | idle, in a worktree nothing has touched for an hour | yes |
| 2 | an orphan idle for 10 minutes; a test runner past 30 minutes with no parent; a `control-app-<slug>` simulator whose worktree is gone | yes |
| 1 | an orphan whose working directory is gone; an `idb_companion` whose simulator is not booted | yes |

Simulators are shut down, never deleted. Everything else gets SIGTERM, then SIGKILL after 5 seconds.

## Every stop is logged

Each stop appends one line to `~/Library/Logs/memory-reclaim.log`, shared by every repo's copy (the newest
2000 lines are kept): when, what (pid or UDID), its score and reason, the session that owned it (pid and
folder) and which session ran the reclaim. A session whose simulator, emulator or dev server vanished
greps it for the UDID or pid, then starts a fresh one.

## Your own session

Stop each process you started the moment your own next steps no longer need it, mid-task included, not
only at the end (owner, 2026-11-26): an Android emulator as soon as the Android check is done while other
work carries on; Remotion Studio or Metro once the last preview or capture that needs it is taken; a
background shell, monitor or Gradle daemon once its output is read; a sub-agent once it has reported.
`TaskStop` your background shells, monitors and sub-agents, kill your own servers by pid,
`adb -s emulator-<port> emu kill`, `xcrun simctl shutdown <UDID>`. Before every final reply, check again
and name any you keep and why. Never stop another session's device or server by hand: only this tool
does, and only once it is idle.

The idle signal does not spare the session that runs it, so a device or server you forgot is reclaimed
too. That is the backstop, not the rule. The `own-devices-reminder.mts` Stop hook also names each dev
server, emulator and simulator your session still runs, once, when a turn ends.

## Above 5: ask first

To stop something scored 6 to 9, report and save, show the user the item with its score and reason, and
apply only what they name, by pid (orphans, dev servers, emulators) or UDID (simulators):

```bash
node tools/memory-reclaim.mts --pretty --save <report-folder>/memory-report.json
node tools/memory-reclaim.mts --apply --from <report-folder>/memory-report.json --category orphans,simulators --pid <pid> --udid <udid>
```

`--apply` refuses a report over an hour old and re-scores everything first, so a restarted process or
a device that became busy is skipped. A session, app or Docker container is never stopped: name the
biggest ones so the user can close them.

## Report

Give the `Memory in use` before and after line, every stopped or skipped item with its reason, and the
"work in progress" jobs left running. Other sessions allocate at the same time and swap drains slowly,
so the delta is approximate.
