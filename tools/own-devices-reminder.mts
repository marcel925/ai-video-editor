#!/usr/bin/env node
// `Stop` hook. Names the dev servers, emulators and simulators THIS session still runs, once per new set, so a
// session stops each one the moment its next steps no longer need it (CLAUDE.md, "Room on the machine"),
// not at the end. It also feeds the machine-wide CPU ledger the memory-reclaim idle signal reads
// (skills/machine-memory-reclaim/SKILL.md). Fails open: any error lets the turn end.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isDevServer,
  isEmulatorProcess,
  parsePs,
  type Proc,
  recordCpuSampleIfDue,
  worktreeSlugOf,
} from './memory-reclaim.mts';

export const REMINDED_DIR = join(homedir(), 'Library/Caches/memory-reclaim');
const WORKTREES_SEGMENT = '/.claude/worktrees/';
const AGENT_COMMANDS = new Set(['claude', 'codex']);
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash']);
const COMMAND_TIMEOUT_MS = 5000;

export type OwnedDevice = {
  key: string;
  kind: 'dev server' | 'emulator' | 'simulator';
  id: string;
  port?: string | undefined;
  startedAt?: string | undefined;
};

function commandName(proc: Proc): string {
  return (basename(proc.comm).split(' ')[0] ?? '').replace(/^-/, '');
}

function isAgent(proc: Proc): boolean {
  return AGENT_COMMANDS.has(basename(proc.comm)) || AGENT_COMMANDS.has(commandName(proc));
}

/** A dev server or emulator; never a shell or an agent, whose arguments may name one (`claude -p "fix the vite config"`). */
function isOwnedKind(proc: Proc): boolean {
  return (
    !SHELLS.has(commandName(proc)) && !isAgent(proc) && (isDevServer(proc) || isEmulatorProcess(proc))
  );
}

/** The `claude` (or `codex`) process at or above `startPid`, or undefined outside a session. */
export function findSessionPid(procs: readonly Proc[], startPid: number): number | undefined {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set<number>();
  for (let cur = byPid.get(startPid); cur && !seen.has(cur.pid); cur = byPid.get(cur.ppid)) {
    seen.add(cur.pid);
    if (AGENT_COMMANDS.has(basename(cur.comm))) return cur.pid;
  }
  return undefined;
}

/** The session's own dev servers and emulators (not a nested session's), one per chain: a match under a match folds into it. */
export function findOwnedProcesses(procs: readonly Proc[], sessionPid: number): Proc[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const owned: Proc[] = [];
  for (const proc of procs) {
    if (!isOwnedKind(proc)) continue;
    let underSession = false;
    let folded = false;
    const seen = new Set<number>();
    for (let cur = byPid.get(proc.ppid); cur && !seen.has(cur.pid); cur = byPid.get(cur.ppid)) {
      seen.add(cur.pid);
      if (cur.pid === sessionPid) {
        underSession = true;
        break;
      }
      // A nested `claude -p` owns what it starts, not the session that launched it.
      if (AGENT_COMMANDS.has(basename(cur.comm))) break;
      if (isOwnedKind(cur)) folded = true;
    }
    if (underSession && !folded) owned.push(proc);
  }
  return owned;
}

/** A simulator named for one of this session's worktrees, exactly: `control-app-<worktree slug>`. */
export function isSimulatorForWorktrees(simulatorName: string, worktreeSlugs: readonly string[]): boolean {
  const name = simulatorName.toLowerCase().replace(/_/g, '-');
  return worktreeSlugs.some((slug) => name === `control-app-${slug.toLowerCase().replace(/_/g, '-')}`);
}

/** `path` sits in the checkout at `root` itself, not in a worktree nested under it. */
export function isInCheckout(path: string, root: string): boolean {
  if (path !== root && !path.startsWith(`${root}/`)) return false;
  return !path.slice(root.length).includes(WORKTREES_SEGMENT);
}

/** Orphaned (ppid 1) dev servers whose working directory sits in the checkout at `root`. */
export function orphansInCheckout(
  procs: readonly Proc[],
  cwds: ReadonlyMap<number, string>,
  root: string,
): Proc[] {
  return procs.filter((p) => {
    const cwd = cwds.get(p.pid);
    return p.ppid === 1 && isOwnedKind(p) && cwd !== undefined && isInCheckout(cwd, root);
  });
}

export function toOwnedDevice(proc: Proc): OwnedDevice {
  return {
    key: `${proc.pid}@${proc.started}`,
    kind: isEmulatorProcess(proc) ? 'emulator' : 'dev server',
    id: `pid ${proc.pid}`,
    port: proc.args.match(/-{1,2}port[\s=](\d+)/)?.[1],
    startedAt: proc.started,
  };
}

/** The devices not yet reminded about; empty means stay silent. */
export function newDevices(
  devices: readonly OwnedDevice[],
  reminded: ReadonlySet<string>,
  stopHookActive: boolean,
): OwnedDevice[] {
  if (stopHookActive) return [];
  return devices.filter((d) => !reminded.has(d.key));
}

function ageText(startedAt: string | undefined, now: number): string {
  const minutes = Math.round((now - Date.parse(startedAt ?? '')) / 60_000);
  if (!Number.isFinite(minutes)) return 'age unknown';
  return minutes < 60 ? `${minutes}m old` : `${Math.round(minutes / 60)}h old`;
}

export function formatReminder(devices: readonly OwnedDevice[], now: number): string {
  const lines = devices.map((d) => {
    const port = d.port ? `, port ${d.port}` : '';
    const age = d.startedAt ? `, ${ageText(d.startedAt, now)}` : '';
    return `- ${d.kind} ${d.id}${port}${age}`;
  });
  return [
    'This session still runs:',
    ...lines,
    'Stop each one now unless your next steps still need it (CLAUDE.md, "Room on the machine"): kill its pid, `adb -s emulator-<port> emu kill` or `xcrun simctl shutdown <UDID>`; or say in one line why you keep it. You will not be reminded about these again.',
  ].join('\n');
}

export function parseCwds(lsofOutput: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of lsofOutput.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

export function parseBootedSimulators(simctlJson: string): { udid: string; name: string }[] {
  try {
    const parsed = JSON.parse(simctlJson) as {
      devices?: Record<string, { udid: string; name: string; state: string }[]>;
    };
    return Object.values(parsed.devices ?? {})
      .flat()
      .filter((d) => d.state === 'Booted')
      .map((d) => ({ udid: d.udid.toUpperCase(), name: d.name }));
  } catch {
    return [];
  }
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: COMMAND_TIMEOUT_MS },
      (_error, stdout) => resolve(String(stdout ?? '')),
    );
  });
}

function readReminded(path: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

/** The checkout root holding `dir`, or undefined outside git. */
async function readCheckoutRoot(dir: string): Promise<string | undefined> {
  const root = (await runCommand('git', ['-C', dir, 'rev-parse', '--show-toplevel'])).trim();
  return root || undefined;
}

function addDevice(devices: OwnedDevice[], device: OwnedDevice): void {
  if (!devices.some((d) => d.key === device.key)) devices.push(device);
}

type HookInput = {
  hook_event_name?: unknown;
  session_id?: unknown;
  stop_hook_active?: unknown;
  cwd?: unknown;
};

/** The reminder to block with, or undefined to let the turn end. */
async function main(input: HookInput): Promise<string | undefined> {
  if (input.hook_event_name !== 'Stop') return undefined;
  await recordCpuSampleIfDue().catch(() => {});
  if (input.stop_hook_active === true) return undefined;
  const [pidLines, commLines] = await Promise.all([
    runCommand('ps', ['-axo', 'pid=,ppid=,rss=,lstart=,args=']),
    runCommand('ps', ['-axo', 'pid=,comm=']),
  ]);
  const procs = parsePs(pidLines, commLines);
  const sessionPid = findSessionPid(procs, process.ppid);
  const owned = sessionPid === undefined ? [] : findOwnedProcesses(procs, sessionPid);
  // A server detached to launchd sits outside the session's tree; its worktree still ties it to the session.
  const root = typeof input.cwd === 'string' ? await readCheckoutRoot(input.cwd) : undefined;
  const worktree = root?.includes(WORKTREES_SEGMENT) ? root : undefined;
  const orphanCandidates = worktree ? procs.filter((p) => p.ppid === 1 && isOwnedKind(p)) : [];
  if (owned.length === 0 && worktree === undefined) return undefined;

  const lsofPids = [...new Set([...owned, ...orphanCandidates].map((p) => p.pid))];
  const cwds =
    lsofPids.length === 0
      ? new Map<number, string>()
      : parseCwds(await runCommand('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', lsofPids.join(',')]));
  const devices: OwnedDevice[] = [];
  for (const p of owned) addDevice(devices, toOwnedDevice(p));
  if (worktree) for (const p of orphansInCheckout(orphanCandidates, cwds, worktree)) addDevice(devices, toOwnedDevice(p));

  const ownedRoots = await Promise.all(
    [...new Set(owned.map((p) => cwds.get(p.pid)).filter((d): d is string => d !== undefined))].map(
      readCheckoutRoot,
    ),
  );
  const worktreeSlugs = [
    ...new Set(
      [...ownedRoots, worktree]
        .map((r) => worktreeSlugOf(r))
        .filter((s): s is string => s !== undefined),
    ),
  ];
  if (worktreeSlugs.length > 0) {
    const booted = parseBootedSimulators(
      await runCommand('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']),
    );
    for (const sim of booted)
      if (isSimulatorForWorktrees(sim.name, worktreeSlugs))
        addDevice(devices, { key: sim.udid, kind: 'simulator', id: `${sim.name} ${sim.udid}` });
  }
  if (devices.length === 0) return undefined;

  const statePath = join(REMINDED_DIR, `reminded-${String(input.session_id ?? sessionPid)}.json`);
  const reminded = readReminded(statePath);
  if (newDevices(devices, reminded, false).length === 0) return undefined;
  mkdirSync(REMINDED_DIR, { recursive: true });
  writeFileSync(statePath, JSON.stringify([...new Set([...reminded, ...devices.map((d) => d.key)])]));
  return formatReminder(devices, Date.now());
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// Both sides resolved: macOS temp dirs sit under a symlink (/var -> /private/var).
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(entry) === real(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  try {
    const message = await main(JSON.parse(await readStdin()) as HookInput);
    if (message !== undefined) {
      process.stderr.write(`${message}\n`);
      process.exitCode = 2;
    }
  } catch {
    // Fail open: a broken reminder must never trap a session.
  }
}
