# Agent rules

**Before the first edit of any multi-part or 20+ minute task, parallelise: see "Move fast" below.**

## Move fast: parallelise

This is a step that always happens, not an option. For every task with two or more independent pieces or
more than about 20 minutes of work, before the first edit, split it and launch the pieces in one message:
sub-agents for pieces that need this session's context, and separate sessions for self-contained pieces,
one worktree per piece. Say in the first reply who runs each piece. The memory gate in "Room on the
machine" still applies to every launch.

## This repo is public

Everything pushed here is public. Show the owner each change and push only when they say so. Some editing
styles are closed source and live in the owner's private fork; never add them here. After a push, the fork
merges this repo in by the steps in its own `CLAUDE.md`.

Commit as `Marcel Moraru <31319366+marcel925@users.noreply.github.com>` on the owner's machine;
collaborators use their own GitHub identity. Never put a personal email in a commit.

## Every memory lives in this repo

A correction, preference or lesson goes into this file or the skill or tool that owns it, in the same
change, so every developer's agents share it. Never into an assistant's local memory: auto memory is off
in `.claude/settings.json`.

## Fix the pipeline, not only the video

When a rendered video shows a defect (a hidden retake, a stutter at a join, a leaked word), fix the video
and change the tools so every future edit catches or prevents that defect class, then make the check a
required step in the skill. Don't silently change a video the owner already approved: report the finding
and ask.

## Room on the machine

On a Mac, before launching a sub-agent, a render, a transcription or a simulator, read
`sysctl -n kern.memorystatus_vm_pressure_level kern.memorystatus_level hw.ncpu vm.loadavg`. Launch while
memory has room and the 1-minute load is under 6x the core count. **Room** = pressure level `1` (normal), or
`2` (warn) with `kern.memorystatus_level` (system-wide free-memory %, the number `memory_pressure` prints)
≥ 20. **No room** at `4` (critical), at any level with free < 20%, or at `2` with the free % unreadable.
After a no-room reading, launch again only once room has held for a sustained minute. Otherwise run
`node tools/memory-reclaim.mts --stale` first: it stops leftovers that are unlikely to still be needed,
never a session, an app or Docker ([`machine-memory-reclaim`](skills/machine-memory-reclaim/SKILL.md)
has the scale). Then re-check, and hold only if there is still no room.

**Decide at task start whether it can run unattended in the cloud** (an `Agent` with
`isolation: "remote"`). Only a change to code or docs qualifies, and only when proving it needs no video
file, render, transcription, simulator or other tool on this Mac: its own tests or a dry run must be
enough. Most work here edits local footage and stays on the Mac. Give it a self-contained brief with a
stop condition, and let the session that sent it end.

## Where videos live

The owner's own YouTube videos and shorts are edited here, in `videos/<project>/` (gitignored, so
footage is never pushed). Look for a personal project here first and create new ones here.
