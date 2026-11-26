#!/usr/bin/env node
// Self-contained on purpose: Node 24 runs this file as is, with no dependency and no other file.
// The scale and procedure: skills/machine-memory-reclaim/SKILL.md in this repo.
import { execFile, execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Category =
  | 'orphans'
  | 'dev-servers'
  | 'idb-companion'
  | 'simulators'
  | 'emulators'
  | 'agent-sessions'
  | 'apps'
  | 'docker';
export type Kind = 'candidate' | 'needsApproval' | 'protected';
export type Proc = {
  pid: number;
  ppid: number;
  rssKb: number;
  started: string;
  comm: string;
  args: string;
};
export type Item = {
  id: string;
  category: Category;
  kind: Kind;
  label: string;
  rssBytes: number;
  pids: number[];
  rootPid?: number | undefined;
  rootStarted?: string | undefined;
  udid?: string | undefined;
  cwd?: string | undefined;
  startedAt?: string | undefined;
  reason: string;
  /** 1-10, how likely the item is still needed; 10 is never stopped. */
  score?: number | undefined;
  scoreWhy?: string | undefined;
  /** The live agent session whose process tree holds the item (aggressive mode splits these out). */
  ownerSessionPid?: number | undefined;
  ownerSessionCwd?: string | undefined;
};
/** CPU seconds each process had used, keyed `pid@started`. */
export type CpuSample = { at: number; cpu: Record<string, number> };
/** A CPU-heavy job (a render, a transcription, a native build): work, reported and never stopped. */
export type WorkItem = {
  pid: number;
  label: string;
  cpuPct: number;
  rssBytes: number;
  ownerSessionPid?: number | undefined;
  ownerSessionCwd?: string | undefined;
};
export type Snapshot = {
  procs: Proc[];
  bootedSims: { udid: string; name: string }[] | null;
  cwds: Map<number, string>;
  launchdJobPids: Set<number>;
  liveWorktreeSlugs: Set<string> | null;
  isPathGone: (path: string) => boolean;
  selfPids: Set<number>;
  cpuPct?: Map<number, number> | null | undefined;
  /** When the checkout holding this path last changed its index or HEAD log (ms); undefined outside any checkout, null when unreadable. */
  checkoutTouchedAt?: ((path: string) => number | null | undefined) | undefined;
  /** Each live worktree's slug and path; for a control-app simulator's checkout. */
  worktreePaths?: Map<string, string> | undefined;
  /** Pids holding a listening TCP socket; null when lsof could not be read. */
  listeningPids?: Set<number> | null | undefined;
  /** Ports each pid listens on. */
  listenPorts?: Map<number, Set<number>> | undefined;
  /** Remote ports each pid holds an established TCP connection to; null when lsof could not be read. */
  connectedPorts?: Map<number, Set<number>> | null | undefined;
  /** CPU seconds used so far, keyed `pid@started`; null when ps could not be read. */
  cpuSeconds?: Map<string, number> | null | undefined;
  /** Earlier CPU samples from the machine-wide ledger, oldest first. */
  cpuHistory?: CpuSample[] | undefined;
};
export type MemoryState = {
  pressureLevel: number | null;
  totalBytes: number;
  usedBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
};
export type Report = {
  mode: 'report';
  generatedAt: string;
  /** Scored with session-owned devices and dev servers split out of their session (`--aggressive`). */
  aggressive?: boolean | undefined;
  memory: MemoryState;
  items: Item[];
  work?: WorkItem[] | undefined;
  notes: string[];
};
export type ClassifyOptions = { aggressive?: boolean | undefined };

export const APPLY_CATEGORIES: readonly Category[] = [
  'orphans',
  'dev-servers',
  'idb-companion',
  'simulators',
  'emulators',
];
const DEV_COMMANDS = new Set([
  'node',
  'npm',
  'npx',
  'pnpm',
  'tsx',
  'bun',
  'deno',
  'java',
  'python',
  'python3',
  'Python',
  'esbuild',
  'ruby',
]);
const AGENT_COMMANDS = new Set(['claude', 'codex']);
const SIM_DEVICE = /CoreSimulator\/Devices\/([0-9A-F-]{36})\//i;
const IDB_UDID = /--udid\s+([0-9A-F-]{36})/i;
const APP_BUNDLE = /\/([^/]+)\.app\//;
const CONTROL_APP_DEVICE = /^control-app-(.+)$/;
const MAX_REPORT_AGE_MS = 60 * 60 * 1000;
const TERM_GRACE_MS = 5000;
const KB = 1024;
const PRETTY_LINES_PER_CATEGORY = 15;

// The idle signal (owner, 2026-11-26): a device or dev server is unused once its tree has averaged at most
// IDLE_CPU_PCT over the window, read from the CPU ledger every run and every session's Stop hook feeds.
export const IDLE_WINDOW_MS = 20 * 60_000;
export const ORPHAN_IDLE_WINDOW_MS = 10 * 60_000;
export const IDLE_CPU_PCT: Partial<Record<Category, number>> = {
  orphans: 2,
  'dev-servers': 2,
  simulators: 12,
  emulators: 12,
};
// Machine-wide, so every account, session and repo copy of this tool reads and feeds the same history.
export const CPU_LEDGER_PATH = join(homedir(), 'Library/Caches/memory-reclaim/cpu-samples.json');
export const CPU_SAMPLE_SPACING_MS = 2 * 60_000;
export const CPU_LEDGER_KEEP_MS = 90 * 60_000;
// The Stop hook's own limit is 15 s; a ps that slow under load gives up and records nothing.
const HOOK_PS_TIMEOUT_MS = 8000;
export const STOP_LOG_PATH = join(homedir(), 'Library/Logs/memory-reclaim.log');
const STOP_LOG_MAX_LINES = 2000;
// A dev server or device a session runs as its own child; only --aggressive splits these out of the session.
export const DEV_SERVER_ARGS =
  /(?:\bexpo(?:\/bin\/cli)?\s+start\b|\breact-native\s+start\b|\bmetro\s+serve\b|\bnext\s+dev\b|\bvite\b|\bwebpack\s+serve\b|\btsx\s+watch\b|\bnodemon\b|\bGradleDaemon\b|\bremotion\s+studio\b)/;
const EMULATOR_COMMAND = /^(?:qemu-system|emulator$)/;
// Work, not idleness: never stopped, always reported. Remotion Studio is a dev server, not a render. This
// repo's pipeline (tools/*.py, tools/build.sh, motion|hyperframes render.mjs) transcribes and renders in
// process, so its entry points name the work where "whisper" or "ffmpeg" may not appear.
export const HEAVY_JOB_ARGS =
  /(?:\bffmpeg\b|whisper|parakeet|\bremotion\b(?!\s+studio\b)|\bxcodebuild\b|GradleWorkerMain|\bgradlew\b|\bpod\s+install\b|\beas\s+build\b|\brender\.mjs\b|\btools\/(?:build\.sh|\w+\.py)\b)/;

function commName(proc: Proc): string {
  return basename(proc.comm);
}

/** The executable name, also when npm or a runner set a process title such as `npm exec expo start`. */
function commandName(proc: Proc): string {
  return commName(proc).split(' ')[0] ?? '';
}

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash']);

/** A shell's command line names whatever it runs, so a shell is never the server, the job or (once old) the client. */
function isShell(proc: Proc): boolean {
  return SHELLS.has(commandName(proc).replace(/^-/, ''));
}

export function isDevServer(proc: Proc): boolean {
  return (
    !isShell(proc) &&
    !AGENT_COMMANDS.has(commName(proc)) &&
    DEV_SERVER_ARGS.test(proc.args) &&
    !HEAVY_JOB_ARGS.test(proc.args)
  );
}

function isHeavyJob(proc: Proc): boolean {
  return !isShell(proc) && HEAVY_JOB_ARGS.test(proc.args);
}

/** The nearest ancestor that is not a shell: a server or job counts once, at the top of its own chain. */
function parentSkippingShells(proc: Proc, byPid: Map<number, Proc>): Proc | undefined {
  const seen = new Set<number>();
  let cur = byPid.get(proc.ppid);
  while (cur && isShell(cur) && !seen.has(cur.pid)) {
    seen.add(cur.pid);
    cur = byPid.get(cur.ppid);
  }
  return cur;
}

export function isEmulatorProcess(proc: Proc): boolean {
  return EMULATOR_COMMAND.test(commName(proc));
}

/** `ps -axo pid=,lstart=,time=` → CPU seconds keyed `pid@started` (the same key an item id uses). */
export function parseCpuSeconds(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const [, pid, started, time] =
      line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+([\d:.]+)\s*$/) ?? [];
    if (pid === undefined || started === undefined || time === undefined) continue;
    const seconds = time.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
    if (Number.isFinite(seconds)) out.set(`${pid}@${started.replace(/\s+/g, ' ')}`, seconds);
  }
  return out;
}

/** Appends `sample` unless the newest is under CPU_SAMPLE_SPACING_MS old, and drops samples past CPU_LEDGER_KEEP_MS. */
export function addCpuSample(ledger: CpuSample[], sample: CpuSample): CpuSample[] {
  const kept = ledger.filter((s) => sample.at - s.at <= CPU_LEDGER_KEEP_MS && s.at <= sample.at);
  const newest = kept.at(-1);
  if (newest !== undefined && sample.at - newest.at < CPU_SAMPLE_SPACING_MS) return kept;
  return [...kept, sample];
}

export type IdleEvidence =
  | { state: 'idle'; windowMs: number; avgPct: number }
  | { state: 'active'; windowMs: number; avgPct: number }
  | { state: 'unknown'; why: string };

/**
 * How much CPU the item's tree used since the newest ledger sample at least `windowMs` old. A process
 * missing from that sample started since, so its whole CPU time counts as activity in the window.
 */
export function idleEvidence(
  item: Pick<Item, 'pids' | 'rootPid' | 'rootStarted' | 'category'>,
  procs: Map<number, Proc>,
  snap: Pick<Snapshot, 'cpuSeconds' | 'cpuHistory'>,
  opts: { now: number; windowMs: number },
): IdleEvidence {
  if (!snap.cpuSeconds) return { state: 'unknown', why: 'CPU time unreadable' };
  const base = [...(snap.cpuHistory ?? [])].reverse().find((s) => opts.now - s.at >= opts.windowMs);
  if (base === undefined)
    return {
      state: 'unknown',
      why: `no CPU sample ${Math.round(opts.windowMs / 60_000)}+ minutes old yet`,
    };
  const rootKey = `${item.rootPid}@${item.rootStarted}`;
  if (base.cpu[rootKey] === undefined)
    return { state: 'unknown', why: 'not running at the oldest usable CPU sample' };
  let used = 0;
  for (const pid of item.pids) {
    const proc = procs.get(pid);
    if (!proc) continue;
    const key = `${pid}@${proc.started}`;
    const nowSeconds = snap.cpuSeconds.get(key);
    if (nowSeconds === undefined) continue;
    used += nowSeconds - (base.cpu[key] ?? 0);
  }
  const elapsedMs = opts.now - base.at;
  const avgPct = (used * 1000 * 100) / elapsedMs;
  const limit = IDLE_CPU_PCT[item.category] ?? 1;
  return { state: avgPct <= limit ? 'idle' : 'active', windowMs: elapsedMs, avgPct };
}

function idleText(evidence: { windowMs: number; avgPct: number }): string {
  return `idle ${Math.round(evidence.windowMs / 60_000)}m at ${evidence.avgPct.toFixed(1)}% average CPU`;
}

/**
 * A process outside the device's own tree that names it right now: a capture, an install, a test drive. A
 * shell counts only while young, since a background shell that once launched the device lives on idle.
 */
export function deviceClientOf(item: Item, procs: Proc[], now: number): Proc | undefined {
  const own = new Set(item.pids);
  const isClient = (p: Proc) =>
    !own.has(p.pid) &&
    !isDevServer(p) &&
    (!isShell(p) || now - Date.parse(p.started) < IDLE_WINDOW_MS);
  if (item.category === 'simulators' && item.udid) {
    const udid = item.udid.toUpperCase();
    return procs.find(
      (p) => isClient(p) && commName(p) !== 'idb_companion' && p.args.toUpperCase().includes(udid),
    );
  }
  if (item.category === 'emulators') {
    const port = item.label.match(/ port (\d+)/)?.[1];
    return procs.find(
      (p) =>
        isClient(p) &&
        commandName(p) === 'adb' &&
        !p.args.includes('fork-server') &&
        (port === undefined || !/\s-s\s/.test(p.args) || p.args.includes(`emulator-${port}`)),
    );
  }
  return undefined;
}

/** One line of the machine-wide stop log, so the session that owned an item can see who stopped it and why. */
export function formatStopLogLine(
  item: Item,
  opts: { at: string; outcome: string; actor: string },
): string {
  const id = item.udid && item.category === 'simulators' ? item.udid : `pid ${item.rootPid}`;
  const owner =
    item.ownerSessionPid === undefined
      ? 'no live owner session'
      : `owner session pid ${item.ownerSessionPid}${item.ownerSessionCwd ? ` in ${item.ownerSessionCwd}` : ''}`;
  return `${opts.at}\t${opts.outcome}\t[${item.category}] ${item.label} (${id})\tscore ${item.score ?? '?'}/10: ${item.scoreWhy ?? item.reason}\t${owner}\tby ${opts.actor}`;
}

export function parsePs(pidLines: string, commLines: string): Proc[] {
  const comms = new Map<number, string>();
  for (const line of commLines.split('\n')) {
    const [, pid, comm] = line.match(/^\s*(\d+)\s+(.*)$/) ?? [];
    if (pid !== undefined && comm !== undefined) comms.set(Number(pid), comm.trim());
  }
  const procs: Proc[] = [];
  for (const line of pidLines.split('\n')) {
    const [, pidText, ppid, rss, started, args] =
      line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/) ??
      [];
    if (pidText === undefined || started === undefined || args === undefined) continue;
    const pid = Number(pidText);
    procs.push({
      pid,
      ppid: Number(ppid),
      rssKb: Number(rss),
      started: started.replace(/\s+/g, ' '),
      comm: comms.get(pid) ?? '',
      args: args.trim(),
    });
  }
  return procs;
}

export function parseVmStat(text: string): { pageSize: number; pages: Record<string, number> } {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const pages: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const [, key, value] = line.match(/^"?([^:"]+)"?:\s+(\d+)\.?$/) ?? [];
    if (key !== undefined) pages[key.trim()] = Number(value);
  }
  return { pageSize, pages };
}

export function parseSwapUsage(text: string): { totalBytes: number; usedBytes: number } {
  const mb = (key: string) =>
    Number(text.match(new RegExp(`${key} = ([\\d.]+)M`))?.[1] ?? 0) * KB * KB;
  return { totalBytes: mb('total'), usedBytes: mb('used') };
}

export function memoryUsedBytes(vm: { pageSize: number; pages: Record<string, number> }): number {
  const p = (k: string) => vm.pages[k] ?? 0;
  return (
    (p('Anonymous pages') + p('Pages wired down') + p('Pages occupied by compressor')) * vm.pageSize
  );
}

/** The nearest agent session above `proc`, if it runs inside one. */
function ownerSessionOf(proc: Proc, byPid: Map<number, Proc>): Proc | undefined {
  const seen = new Set<number>();
  for (let cur = byPid.get(proc.ppid); cur && !seen.has(cur.pid); cur = byPid.get(cur.ppid)) {
    seen.add(cur.pid);
    if (AGENT_COMMANDS.has(commName(cur))) return cur;
  }
  return undefined;
}

function rootKindOf(
  proc: Proc,
  snap: Snapshot,
  context: { simRoots: Map<number, string>; byPid: Map<number, Proc>; aggressive: boolean },
): Category | null {
  const name = commName(proc);
  if (AGENT_COMMANDS.has(name)) return 'agent-sessions';
  if (context.simRoots.has(proc.pid)) return 'simulators';
  if (proc.ppid !== 1) {
    // --aggressive: a live session's own device or dev server is scored on its own, by the idle signal.
    if (!context.aggressive || snap.selfPids.has(proc.pid)) return null;
    if (ownerSessionOf(proc, context.byPid) === undefined) return null;
    const parent = parentSkippingShells(proc, context.byPid);
    if (isEmulatorProcess(proc) && !(parent && isEmulatorProcess(parent))) return 'emulators';
    if (isDevServer(proc) && !(parent && isDevServer(parent))) return 'dev-servers';
    return null;
  }
  if (name.startsWith('qemu-system')) return 'emulators';
  if (name === 'idb_companion') return 'idb-companion';
  if (DEV_COMMANDS.has(commandName(proc)) && !snap.launchdJobPids.has(proc.pid)) return 'orphans';
  if (APP_BUNDLE.test(proc.comm)) return 'apps';
  return null;
}

const TEST_RUNNER_SCRIPT = /^(?:vitest|jest)(?:\.[cm]?js)?$/;
// Past every gate's own test timeout, an orphaned run is hung, never mid-run.
const HUNG_TEST_RUNNER_MS = 30 * 60 * 1000;

// Identity only, never a substring: a path or an app flag naming vitest, jest or --test is not a runner.
function isTestRunner(args: string): boolean {
  const [, ...rest] = args.split(/\s+/).filter(Boolean);
  const scriptAt = rest.findIndex((token) => !token.startsWith('-'));
  const nodeOptions = scriptAt === -1 ? rest : rest.slice(0, scriptAt);
  if (nodeOptions.some((token) => /^--test(?:$|=|-)/.test(token))) return true;
  const script = scriptAt === -1 ? undefined : rest[scriptAt];
  return script !== undefined && TEST_RUNNER_SCRIPT.test(script.split('/').at(-1) ?? '');
}

function isHungTestRunner(proc: Proc, now: number): boolean {
  return isTestRunner(proc.args) && now - Date.parse(proc.started) > HUNG_TEST_RUNNER_MS;
}

function ageText(started: string, now: number): string {
  const ms = now - Date.parse(started);
  if (!Number.isFinite(ms)) return 'age unknown';
  const h = ms / 3_600_000;
  return h < 1
    ? `${Math.round(h * 60)}m old`
    : h < 48
      ? `${Math.round(h)}h old`
      : `${Math.round(h / 24)}d old`;
}

function worktreeOf(cwd: string | undefined): string | undefined {
  return cwd?.match(/\.claude\/worktrees\/(.+?)(?:\/apps\/|\/packages\/|\/scripts\/|$)/)?.[1];
}

export function classify(snap: Snapshot, now: number, opts: ClassifyOptions = {}): Item[] {
  const aggressive = opts.aggressive === true;
  const byPid = new Map(snap.procs.map((p) => [p.pid, p]));
  const booted = new Map((snap.bootedSims ?? []).map((s) => [s.udid.toUpperCase(), s.name]));
  const simRoots = new Map<number, string>();
  for (const p of snap.procs) {
    if (commName(p) !== 'launchd_sim') continue;
    const udid = p.args.match(SIM_DEVICE)?.[1]?.toUpperCase();
    if (udid) simRoots.set(p.pid, udid);
  }

  const roots = new Map<number, Category>();
  for (const p of snap.procs) {
    const kind = rootKindOf(p, snap, { simRoots, byPid, aggressive });
    if (kind) roots.set(p.pid, kind);
  }
  const members = new Map<number, number[]>();
  for (const p of snap.procs) {
    let cur: Proc | undefined = p;
    const seen = new Set<number>();
    while (cur && !roots.has(cur.pid) && cur.ppid > 1 && !seen.has(cur.pid)) {
      seen.add(cur.pid);
      cur = byPid.get(cur.ppid);
    }
    if (cur && roots.has(cur.pid)) members.set(cur.pid, [...(members.get(cur.pid) ?? []), p.pid]);
  }

  const appNameOf = (proc: Proc) => proc.comm.match(APP_BUNDLE)?.[1] ?? commName(proc);
  const hostedSessions = new Map<string, number>();
  for (const [pid, category] of roots) {
    if (category !== 'agent-sessions') continue;
    const seen = new Set<number>();
    for (
      let cur = byPid.get(byPid.get(pid)?.ppid ?? 0);
      cur && !seen.has(cur.pid);
      cur = byPid.get(cur.ppid)
    ) {
      seen.add(cur.pid);
      if (roots.get(cur.pid) === 'apps') {
        const app = appNameOf(cur);
        hostedSessions.set(app, (hostedSessions.get(app) ?? 0) + 1);
        break;
      }
    }
  }

  const items: Item[] = [];
  const appTotals = new Map<string, { rss: number; pids: number[] }>();
  for (const [pid, category] of roots) {
    const root = byPid.get(pid);
    if (!root) continue;
    const pids = members.get(pid) ?? [pid];
    const rssBytes = pids.reduce((sum, id) => sum + (byPid.get(id)?.rssKb ?? 0) * KB, 0);
    const ownerSession =
      category === 'agent-sessions' || category === 'apps' ? undefined : ownerSessionOf(root, byPid);
    const base = {
      id: `${pid}@${root.started}`,
      category,
      rssBytes,
      pids,
      rootPid: pid,
      rootStarted: root.started,
      startedAt: root.started,
      ownerSessionPid: ownerSession?.pid,
      ownerSessionCwd: ownerSession ? snap.cwds.get(ownerSession.pid) : undefined,
    };
    const age = ageText(root.started, now);
    const cwd = snap.cwds.get(pid);
    const isSelf = pids.some((id) => snap.selfPids.has(id));
    const ownedBy = ownerSession ? `run by live session pid ${ownerSession.pid}` : '';

    if (category === 'apps') {
      const app = appNameOf(root);
      const t = appTotals.get(app) ?? { rss: 0, pids: [] };
      appTotals.set(app, { rss: t.rss + rssBytes, pids: [...t.pids, ...pids] });
      continue;
    }
    if (category === 'agent-sessions') {
      const where = cwd ? ` in ${cwd}` : '';
      items.push({
        ...base,
        kind: 'protected',
        label: `${commName(root)} pid ${pid}`,
        cwd,
        reason: `${isSelf ? 'THIS session' : 'agent session'}, ${age}${where}, ${pids.length} process(es) incl. its MCP servers — close it in its own terminal; this tool never stops a session`,
      });
      continue;
    }
    if (category === 'simulators') {
      const udid = simRoots.get(pid) ?? '';
      const name = booted.get(udid) ?? 'unknown device';
      const slug = name.match(CONTROL_APP_DEVICE)?.[1];
      const owner =
        slug === undefined
          ? 'shared or unnamed device — another session may be driving it'
          : snap.liveWorktreeSlugs === null
            ? 'control-app device; worktree list unreadable'
            : snap.liveWorktreeSlugs.has(slug)
              ? `control-app device; worktree "${slug}" still exists — its session may be using it`
              : `control-app device; no worktree "${slug}" here (the sister project shares the machine, so a hint, not proof)`;
      items.push({
        ...base,
        id: `${udid}@${root.started}`,
        udid,
        kind: 'needsApproval',
        label: name,
        reason: `Booted, ${age}; ${owner} — shut down only by approved UDID`,
      });
      continue;
    }
    if (category === 'emulators') {
      const avd = root.args.match(/-avd\s+(\S+)/)?.[1] ?? 'unknown AVD';
      const port = root.args.match(/-port\s+(\d+)/)?.[1];
      items.push({
        ...base,
        kind: 'needsApproval',
        label: `Android emulator ${avd}${port ? ` port ${port}` : ''}`,
        reason: `${age}; ${ownedBy || 'the shared AVD other sessions boot'} — stop only by approved pid when no session is on it`,
      });
      continue;
    }
    if (category === 'dev-servers') {
      items.push({
        ...base,
        kind: 'needsApproval',
        label: `${commName(root)} pid ${pid}: ${root.args.slice(0, 90)}`,
        cwd,
        reason: `dev server ${ownedBy}, ${age}${cwd ? `, in ${cwd}` : ''} — stopped only when idle by the idle signal (--aggressive)`,
      });
      continue;
    }
    if (category === 'idb-companion') {
      const udid = root.args.match(IDB_UDID)?.[1]?.toUpperCase();
      if (snap.bootedSims === null) {
        items.push({
          ...base,
          kind: 'protected',
          label: `idb_companion ${udid?.slice(0, 8) ?? '?'}`,
          udid,
          reason: 'simctl unreadable, cannot tell whether its simulator is booted',
        });
      } else if (udid && !booted.has(udid)) {
        items.push({
          ...base,
          kind: 'candidate',
          label: `idb_companion ${udid.slice(0, 8)}`,
          udid,
          reason: `reparented to launchd and its simulator ${udid} is not booted — it serves nothing`,
        });
      } else {
        items.push({
          ...base,
          kind: 'protected',
          label: `idb_companion ${udid?.slice(0, 8) ?? '?'}`,
          udid,
          reason: udid ? `its simulator ${booted.get(udid)} is booted` : 'no --udid argument',
        });
      }
      continue;
    }
    const label = `${commName(root)} pid ${pid}: ${root.args.slice(0, 90)}`;
    if (isSelf) {
      items.push({
        ...base,
        kind: 'protected',
        label,
        cwd,
        reason: 'this tool or its own session',
      });
    } else if (isHungTestRunner(root, now)) {
      items.push({
        ...base,
        kind: 'candidate',
        label,
        cwd,
        reason: `orphaned test runner (reparented to launchd), ${age}; a test run never detaches, so its session is gone`,
      });
    } else if (cwd !== undefined && snap.isPathGone(cwd)) {
      items.push({
        ...base,
        kind: 'candidate',
        label,
        cwd,
        reason: `orphan (reparented to launchd), ${age}; its working directory ${cwd} no longer exists`,
      });
    } else {
      const wt = worktreeOf(cwd);
      const where = wt ? `worktree ${wt}` : (cwd ?? 'cwd unreadable');
      items.push({
        ...base,
        kind: 'needsApproval',
        label,
        cwd,
        reason: `orphan (reparented to launchd), ${age}, in ${where}; a live session may have detached it — stop only by approved pid`,
      });
    }
  }
  for (const [app, t] of appTotals) {
    items.push({
      id: `app:${app}`,
      category: 'apps',
      kind: 'protected',
      label: app,
      rssBytes: t.rss,
      pids: t.pids,
      reason: hostedSessions.has(app)
        ? `a desktop app hosting ${hostedSessions.get(app)} live agent session(s) — quitting it ends them; this tool never stops apps`
        : 'a desktop app — quit it (or close tabs) yourself; this tool never stops apps',
    });
  }
  const sessionWorktrees = new Set(
    items
      .filter((i) => i.category === 'agent-sessions')
      .map((i) => worktreeSlugOf(i.cwd))
      .filter((slug): slug is string => slug !== undefined),
  );
  for (const item of items)
    Object.assign(item, scoreItem(item, snap, { sessionWorktrees, byPid, now, aggressive }));
  for (const item of items) {
    const family = deviceFamily(item);
    if (family === undefined || (item.score ?? 10) > 5) continue;
    const busy = items.find(
      (other) => other !== item && deviceFamily(other) === family && (other.score ?? 0) >= 6,
    );
    if (busy)
      Object.assign(item, { score: 6, scoreWhy: `same run as ${busy.label}, which is in use` });
  }
  for (const server of items) {
    if (server.category !== 'orphans' && server.category !== 'dev-servers') continue;
    if ((server.score ?? 10) > 5) continue;
    const device = deviceServedBy(server, items, snap);
    if (device) Object.assign(server, { score: 6, scoreWhy: device });
  }
  return items.sort((a, b) => b.rssBytes - a.rssBytes);
}

/**
 * Why a low-scored server must stay: a device scoring 6+ holds a TCP connection to one of its ports (an
 * emulator's through the adb server), or is named for the worktree it runs in. A Metro looks idle while
 * the app it serves is being driven.
 */
export function deviceServedBy(server: Item, items: Item[], snap: Snapshot): string | undefined {
  const ports = new Set<number>();
  for (const pid of server.pids) for (const port of snap.listenPorts?.get(pid) ?? []) ports.add(port);
  if (ports.size === 0 && !server.pids.some((pid) => snap.listeningPids?.has(pid))) return undefined;
  const adbServerPids = snap.procs
    .filter((p) => commandName(p) === 'adb' && p.args.includes('fork-server'))
    .map((p) => p.pid);
  for (const device of items) {
    if (device.category !== 'simulators' && device.category !== 'emulators') continue;
    if ((device.score ?? 10) < 6) continue;
    if (snap.connectedPorts === null)
      return `TCP connections unreadable, and ${device.label} is in use`;
    // An Android app reaches Metro through `adb reverse`, so the shared adb server holds that connection.
    const viaPids =
      device.category === 'emulators' ? [...device.pids, ...adbServerPids] : device.pids;
    const isConnected = viaPids.some((pid) =>
      [...(snap.connectedPorts?.get(pid) ?? [])].some((port) => ports.has(port)),
    );
    const slug = device.label.match(CONTROL_APP_DEVICE)?.[1];
    const checkout = slug === undefined ? undefined : snap.worktreePaths?.get(slug);
    const isSameWorktree =
      device.category === 'simulators' &&
      checkout !== undefined &&
      (server.cwd === checkout || server.cwd?.startsWith(`${checkout}/`) === true);
    if (isConnected || isSameWorktree)
      return `serves ${device.label}, which is in use (${isConnected ? 'connected to its port' : 'same worktree'})`;
  }
  return undefined;
}

/** `lsof -nP -iTCP -Fpn`: each pid's local ports (listen) and the remote ports it is connected to. */
export function parseTcpPorts(lsofOutput: string): {
  local: Map<number, Set<number>>;
  remote: Map<number, Set<number>>;
} {
  const local = new Map<number, Set<number>>();
  const remote = new Map<number, Set<number>>();
  const add = (map: Map<number, Set<number>>, pid: number, port: number) =>
    map.set(pid, (map.get(pid) ?? new Set()).add(port));
  let pid = 0;
  for (const line of lsofOutput.split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    if (!line.startsWith('n') || !pid) continue;
    const [here, there] = line.slice(1).split('->');
    const localPort = Number(here?.match(/:(\d+)$/)?.[1]);
    const remotePort = Number(there?.match(/:(\d+)$/)?.[1]);
    if (Number.isInteger(localPort) && localPort > 0) add(local, pid, localPort);
    if (Number.isInteger(remotePort) && remotePort > 0) add(remote, pid, remotePort);
  }
  return { local, remote };
}

const WORKTREE_GROUPS = new Set([
  'feat',
  'fix',
  'docs',
  'chore',
  'experiment',
  'refactor',
  'test',
  'perf',
]);

/** The worktree a path sits in, as the slug `control-app-<slug>` devices use (`feat/x` → `feat-x`). */
export function worktreeSlugOf(path: string | undefined): string | undefined {
  const parts = path?.split('/.claude/worktrees/')[1]?.split('/');
  const first = parts?.[0];
  if (!parts || !first) return undefined;
  const second = parts[1];
  return WORKTREE_GROUPS.has(first) && second ? `${first}-${second}` : first;
}

// A tree using this much CPU is doing work for someone; a simulator or emulator idles higher than a process.
const BUSY_CPU_PCT: Partial<Record<Category, number>> = {
  orphans: 5,
  'dev-servers': 5,
  simulators: 25,
  emulators: 30,
};
const YOUNG_MS = 30 * 60 * 1000;
// Sessions drive worktrees by absolute path, so a git index or HEAD-log write is the activity tell, not a cwd.
const ACTIVE_CHECKOUT_MS = 60 * 60 * 1000;

/** Devices one run boots together share a name stem (snc-qa-iphone17pro, snc_qa_phone). */
function deviceFamily(item: Item): string | undefined {
  if (item.category !== 'simulators' && item.category !== 'emulators') return undefined;
  const name = item.label
    .replace(/^Android emulator /, '')
    .toLowerCase()
    .replace(/_/g, '-');
  const stem = name.split('-').slice(0, 2);
  return stem.length === 2 && !name.startsWith('control-app-') ? stem.join('-') : undefined;
}

/**
 * How the idle signal may lower a score: `firm` never (busy, or an input it needs is unreadable), `soft` in
 * every mode, `claim` (a session or its worktree still holds the item) only under --aggressive.
 */
type Hold = 'firm' | 'soft' | 'claim';
type Scored = { score: number; scoreWhy: string; hold: Hold };

function scoreByOwnership(
  item: Item,
  snap: Snapshot,
  sessionWorktrees: Set<string>,
  byPid: Map<number, Proc>,
  now: number,
): Scored {
  if (item.ownerSessionPid !== undefined) {
    if (snap.cpuPct === null)
      return { score: 6, scoreWhy: 'CPU use unreadable, so it may be busy', hold: 'firm' };
    const cpu = item.pids.reduce((sum, pid) => sum + (snap.cpuPct?.get(pid) ?? 0), 0);
    if (cpu >= (BUSY_CPU_PCT[item.category] ?? 5))
      return { score: 7, scoreWhy: `busy: ${Math.round(cpu)}% CPU`, hold: 'firm' };
    return { score: 8, scoreWhy: `run by live session pid ${item.ownerSessionPid}`, hold: 'claim' };
  }
  const slug =
    item.category === 'simulators'
      ? item.label.match(CONTROL_APP_DEVICE)?.[1]
      : worktreeSlugOf(item.cwd);
  if (slug !== undefined && sessionWorktrees.has(slug))
    return { score: 8, scoreWhy: `an agent session is open in worktree ${slug}`, hold: 'claim' };
  const simCheckout =
    item.category === 'simulators' && slug !== undefined
      ? snap.worktreePaths?.get(slug)
      : undefined;
  const listeners = simCheckout === undefined ? [] : listenersIn(simCheckout, snap);
  const attended = listeners.find((pid) => byPid.get(pid)?.ppid !== 1);
  if (attended !== undefined)
    return {
      score: 8,
      scoreWhy: `its worktree still serves it: pid ${attended} listens from ${slug}`,
      hold: 'claim',
    };
  if (listeners.length > 0)
    return {
      score: 6,
      scoreWhy: `only an orphaned listener (pid ${listeners[0]}) in ${slug} serves it; both go once the checkout is gone`,
      hold: 'claim',
    };
  if (snap.cpuPct === null)
    return { score: 6, scoreWhy: 'CPU use unreadable, so it may be busy', hold: 'firm' };
  const cpu = item.pids.reduce((sum, pid) => sum + (snap.cpuPct?.get(pid) ?? 0), 0);
  if (cpu >= (BUSY_CPU_PCT[item.category] ?? 5))
    return { score: 7, scoreWhy: `busy: ${Math.round(cpu)}% CPU`, hold: 'firm' };
  const ageMs = now - Date.parse(item.startedAt ?? '');
  if (!(ageMs >= YOUNG_MS))
    return { score: 6, scoreWhy: 'started under 30 minutes ago', hold: 'soft' };
  if (simCheckout !== undefined && snap.listeningPids === null)
    return {
      score: 6,
      scoreWhy: 'listening sockets unreadable, so its worktree may still serve it',
      hold: 'firm',
    };
  if (item.category === 'orphans') {
    if (item.cwd === undefined)
      return {
        score: 6,
        scoreWhy: 'working directory unreadable, so its owner is unknown',
        hold: 'firm',
      };
    if (snap.listeningPids === null)
      return { score: 6, scoreWhy: 'listening sockets unreadable, so it may be serving', hold: 'firm' };
    if (item.pids.some((pid) => snap.listeningPids?.has(pid)))
      return {
        score: 6,
        scoreWhy: 'serves on a port and has not been idle long enough to go',
        hold: 'soft',
      };
  }
  const checkout =
    item.category === 'simulators' && slug !== undefined ? snap.worktreePaths?.get(slug) : item.cwd;
  const touchedAt = checkout === undefined ? undefined : snap.checkoutTouchedAt?.(checkout);
  if (touchedAt === null)
    return { score: 6, scoreWhy: 'its checkout is unreadable, so its activity is unknown', hold: 'firm' };
  if (touchedAt !== undefined && now - touchedAt < ACTIVE_CHECKOUT_MS)
    return {
      score: 6,
      scoreWhy: `its checkout's git state changed ${Math.round((now - touchedAt) / 60_000)}m ago`,
      hold: 'claim',
    };
  if (
    item.category === 'simulators' &&
    slug !== undefined &&
    snap.liveWorktreeSlugs !== null &&
    !snap.liveWorktreeSlugs.has(slug)
  )
    return { score: 2, scoreWhy: `idle, and worktree ${slug} is gone`, hold: 'soft' };
  if (slug !== undefined)
    return {
      score: 3,
      scoreWhy: `idle, and nothing has touched worktree ${slug} for an hour`,
      hold: 'soft',
    };
  return item.category === 'orphans'
    ? { score: 4, scoreWhy: 'idle orphan outside any worktree; restarts on demand', hold: 'soft' }
    : { score: 5, scoreWhy: 'idle for 30+ minutes and no session claims it', hold: 'soft' };
}

function scoreItem(
  item: Item,
  snap: Snapshot,
  context: { sessionWorktrees: Set<string>; byPid: Map<number, Proc>; now: number; aggressive: boolean },
): { score: number; scoreWhy: string } {
  const { byPid, now } = context;
  if (item.kind === 'protected') return { score: 10, scoreWhy: 'never stopped by this tool' };
  const root = item.rootPid === undefined ? undefined : byPid.get(item.rootPid);
  if (item.kind === 'candidate') {
    if (item.category === 'idb-companion')
      return { score: 1, scoreWhy: 'its simulator is not booted' };
    if (root && isHungTestRunner(root, now))
      return { score: 2, scoreWhy: 'a test run past 30 minutes with no parent' };
    return { score: 1, scoreWhy: 'its worktree is gone' };
  }
  const job = item.pids
    .map((pid) => byPid.get(pid))
    .find((p): p is Proc => p !== undefined && isHeavyJob(p));
  if (job)
    return { score: 7, scoreWhy: `runs work, never idle: pid ${job.pid} ${job.args.slice(0, 60)}` };
  const client = deviceClientOf(item, snap.procs, now);
  if (client)
    return {
      score: 7,
      scoreWhy: `driven right now by pid ${client.pid}: ${client.args.slice(0, 60)}`,
    };
  const held = scoreByOwnership(item, snap, context.sessionWorktrees, byPid, now);
  if (held.hold === 'firm' || held.score <= 2 || (held.hold === 'claim' && !context.aggressive))
    return held;
  // A claim returns before scoreByOwnership's own CPU checks, so an old idle average never outvotes busy-now.
  if (snap.cpuPct === null) return held;
  const cpuNow = item.pids.reduce((sum, pid) => sum + (snap.cpuPct?.get(pid) ?? 0), 0);
  if (cpuNow >= (BUSY_CPU_PCT[item.category] ?? 5))
    return held.score >= 7 ? held : { score: 7, scoreWhy: `busy: ${Math.round(cpuNow)}% CPU` };
  const isOrphan = item.category === 'orphans' && item.ownerSessionPid === undefined;
  // The ios-simulator MCP drives a simulator through its idb_companion, so that CPU is the device's too.
  const companions =
    item.category === 'simulators' && item.udid
      ? snap.procs
          .filter((p) => commName(p) === 'idb_companion' && p.args.toUpperCase().includes(item.udid ?? ''))
          .map((p) => p.pid)
      : [];
  const evidence = idleEvidence({ ...item, pids: [...item.pids, ...companions] }, byPid, snap, {
    now,
    windowMs: isOrphan ? ORPHAN_IDLE_WINDOW_MS : IDLE_WINDOW_MS,
  });
  if (evidence.state === 'unknown') return held;
  if (evidence.state === 'active')
    return { ...held, scoreWhy: `${held.scoreWhy}; ${evidence.avgPct.toFixed(1)}% average CPU over ${Math.round(evidence.windowMs / 60_000)}m` };
  if (isOrphan) return { score: 2, scoreWhy: `orphaned and ${idleText(evidence)}` };
  if (held.hold === 'claim')
    return { score: 5, scoreWhy: `${idleText(evidence)}, though ${held.scoreWhy}` };
  return { score: 4, scoreWhy: `${idleText(evidence)}; no session claims it` };
}

// Idle CPU and an untouched checkout are not unused: hand testing leaves both quiet while Metro runs.
function listenersIn(checkout: string, snap: Snapshot): number[] {
  return [...(snap.listeningPids ?? [])].filter((pid) => {
    const cwd = snap.cwds.get(pid);
    return cwd === checkout || cwd?.startsWith(`${checkout}/`) === true;
  });
}

export function isPathGone(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  }
}

type RunResult = { code: number | null; stdout: string };

function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * KB * KB }, (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}

async function readMemory(): Promise<MemoryState> {
  const [pressure, swap, total, vmstat] = await Promise.all([
    run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
    run('sysctl', ['-n', 'vm.swapusage']),
    run('sysctl', ['-n', 'hw.memsize']),
    run('vm_stat', []),
  ]);
  const level = Number(pressure.stdout.trim());
  const swapUsage = parseSwapUsage(swap.stdout);
  return {
    pressureLevel: Number.isFinite(level) && pressure.stdout.trim() !== '' ? level : null,
    totalBytes: Number(total.stdout.trim()) || 0,
    usedBytes: memoryUsedBytes(parseVmStat(vmstat.stdout)),
    swapUsedBytes: swapUsage.usedBytes,
    swapTotalBytes: swapUsage.totalBytes,
  };
}

async function readCwds(pids: number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>();
  if (pids.length === 0) return cwds;
  const res = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]);
  let pid = 0;
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

// Machine-wide: the worktrees of this repo and of every repo an agent session is working in, since a
// simulator may belong to any project on the machine.
async function readLiveWorktrees(dirs: string[]): Promise<Map<string, string> | null> {
  const commons = await Promise.all(
    dirs.map((dir) =>
      run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
    ),
  );
  const repos = new Set(commons.filter((c) => c.code === 0).map((c) => dirname(c.stdout.trim())));
  if (repos.size === 0) return null;
  const worktrees = new Map<string, string>();
  for (const repo of repos) {
    const list = await run('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
    if (list.code !== 0) return null;
    for (const line of list.stdout.split('\n')) {
      const path = line.startsWith('worktree ') ? line.slice('worktree '.length) : undefined;
      const wt = path?.match(/\.claude\/worktrees\/(.+)$/)?.[1];
      if (path && wt) worktrees.set(wt.replace(/[/_]/g, '-'), path);
    }
  }
  return worktrees;
}

function ancestorsOf(pid: number, procs: Proc[]): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set<number>();
  for (let cur = byPid.get(pid); cur && !out.has(cur.pid); cur = byPid.get(cur.ppid))
    out.add(cur.pid);
  return out;
}

export function checkoutTouchedAt(path: string): number | null | undefined {
  for (let dir = path; dir !== dirname(dir); dir = dirname(dir)) {
    let gitDir: string;
    try {
      const dotGit = join(dir, '.git');
      gitDir = statSync(dotGit).isDirectory()
        ? dotGit
        : resolve(
            dir,
            readFileSync(dotGit, 'utf8')
              .replace(/^gitdir:\s*/, '')
              .trim(),
          );
    } catch {
      continue;
    }
    const times = ['index', 'logs/HEAD'].flatMap((f) => {
      try {
        return [statSync(join(gitDir, f)).mtimeMs];
      } catch {
        return [];
      }
    });
    return times.length > 0 ? Math.max(...times) : null;
  }
  return undefined;
}

export function parseListeningPids(lsofOutput: string): Set<number> {
  const pids = new Set<number>();
  for (const line of lsofOutput.split('\n'))
    if (/^p\d+$/.test(line)) pids.add(Number(line.slice(1)));
  return pids;
}

export function parseCpu(text: string): Map<number, number> {
  const cpu = new Map<number, number>();
  for (const line of text.split('\n')) {
    const [, pid, pct] = line.match(/^\s*(\d+)\s+([\d.]+)/) ?? [];
    if (pid !== undefined && pct !== undefined) cpu.set(Number(pid), Number(pct));
  }
  return cpu;
}

function readCpuLedger(): CpuSample[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CPU_LEDGER_PATH, 'utf8'));
    return Array.isArray(parsed)
      ? parsed.filter(
          (s): s is CpuSample =>
            typeof s === 'object' && s !== null && typeof s.at === 'number' && typeof s.cpu === 'object',
        )
      : [];
  } catch {
    return [];
  }
}

/** Adds this moment's CPU times to the machine-wide ledger (a rename, so a concurrent reader never sees half a file). */
export function writeCpuSample(cpuSeconds: Map<string, number>, at: number): CpuSample[] {
  const history = readCpuLedger();
  const next = addCpuSample(history, { at, cpu: Object.fromEntries(cpuSeconds) });
  if (next.at(-1)?.at === at) {
    try {
      mkdirSync(dirname(CPU_LEDGER_PATH), { recursive: true });
      const partial = `${CPU_LEDGER_PATH}.${process.pid}.tmp`;
      writeFileSync(partial, JSON.stringify(next));
      renameSync(partial, CPU_LEDGER_PATH);
    } catch {
      // A missed sample only delays the idle signal; it never makes anything look idle.
    }
  }
  return history;
}

/** Feeds the ledger cheaply from a hook: one `ps`, and nothing at all while the newest sample is recent. */
export async function recordCpuSampleIfDue(now = Date.now()): Promise<void> {
  try {
    if (now - statSync(CPU_LEDGER_PATH).mtimeMs < CPU_SAMPLE_SPACING_MS) return;
  } catch {
    // no ledger yet
  }
  const res = await run('ps', ['-axo', 'pid=,lstart=,time='], HOOK_PS_TIMEOUT_MS);
  if (res.code === 0) writeCpuSample(parseCpuSeconds(res.stdout), now);
}

export async function collectSnapshot(): Promise<Snapshot> {
  const [pidRes, commRes, cpuRes, listenRes, simRes, launchdRes, timeRes, connectedRes] =
    await Promise.all([
    run('ps', ['-axo', 'pid=,ppid=,rss=,lstart=,args=']),
    run('ps', ['-axo', 'pid=,comm=']),
    run('ps', ['-axo', 'pid=,%cpu=']),
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']),
    run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']),
    run('launchctl', ['list']),
    run('ps', ['-axo', 'pid=,lstart=,time=']),
    run('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-Fpn']),
  ]);
  const procs = parsePs(pidRes.stdout, commRes.stdout);
  const cpuSeconds = timeRes.code === 0 ? parseCpuSeconds(timeRes.stdout) : null;
  const cpuHistory = cpuSeconds ? writeCpuSample(cpuSeconds, Date.now()) : [];
  let bootedSims: { udid: string; name: string }[] | null = null;
  try {
    const devices = (
      JSON.parse(simRes.stdout) as {
        devices?: Record<string, { udid: string; name: string; state: string }[]>;
      }
    ).devices;
    if (simRes.code === 0 && devices) {
      bootedSims = Object.values(devices).flatMap((list) =>
        list
          .filter((d) => d.state === 'Booted')
          .map((d) => ({ udid: d.udid.toUpperCase(), name: d.name })),
      );
    }
  } catch {
    bootedSims = null;
  }
  const launchdJobPids = new Set<number>();
  for (const line of launchdRes.stdout.split('\n')) {
    const pid = Number(line.split('\t')[0]);
    if (Number.isInteger(pid) && pid > 0) launchdJobPids.add(pid);
  }
  const rootish = procs
    .filter(
      (p) =>
        p.ppid === 1 || AGENT_COMMANDS.has(commName(p)) || isDevServer(p) || isEmulatorProcess(p),
    )
    .map((p) => p.pid);
  const listeningPids =
    listenRes.code === 0 || listenRes.stdout !== '' ? parseListeningPids(listenRes.stdout) : null;
  const cwds = await readCwds([...new Set([...rootish, ...(listeningPids ?? [])])]);
  const sessionDirs = procs
    .filter((p) => AGENT_COMMANDS.has(commName(p)))
    .map((p) => cwds.get(p.pid))
    .filter((dir): dir is string => dir !== undefined && !isPathGone(dir));
  const slugs = await readLiveWorktrees([dirname(fileURLToPath(import.meta.url)), ...sessionDirs]);
  return {
    procs,
    bootedSims,
    cwds,
    launchdJobPids,
    liveWorktreeSlugs: slugs === null ? null : new Set(slugs.keys()),
    worktreePaths: slugs ?? undefined,
    listeningPids,
    isPathGone,
    selfPids: ancestorsOf(process.pid, procs),
    cpuPct: cpuRes.code === 0 ? parseCpu(cpuRes.stdout) : null,
    checkoutTouchedAt,
    cpuSeconds,
    cpuHistory,
    listenPorts: parseTcpPorts(listenRes.stdout).local,
    // A timed-out or failed lsof leaves a partial list that would read as "nothing connected".
    connectedPorts: connectedRes.code === 0 ? parseTcpPorts(connectedRes.stdout).remote : null,
  };
}

/** Every CPU-heavy job on the machine, topmost per chain, with the session it runs under. */
export function findWork(snap: Snapshot): WorkItem[] {
  const byPid = new Map(snap.procs.map((p) => [p.pid, p]));
  const work: WorkItem[] = [];
  for (const p of snap.procs) {
    if (!isHeavyJob(p)) continue;
    const parent = parentSkippingShells(p, byPid);
    if (parent && isHeavyJob(parent)) continue;
    const owner = ownerSessionOf(p, byPid);
    work.push({
      pid: p.pid,
      label: `${commandName(p)}: ${p.args.slice(0, 90)}`,
      cpuPct: snap.cpuPct?.get(p.pid) ?? 0,
      rssBytes: p.rssKb * KB,
      ownerSessionPid: owner?.pid,
      ownerSessionCwd: owner ? snap.cwds.get(owner.pid) : undefined,
    });
  }
  return work.sort((a, b) => b.cpuPct - a.cpuPct);
}

export async function buildReport(opts: ClassifyOptions = {}): Promise<Report> {
  const [memory, snap] = await Promise.all([readMemory(), collectSnapshot()]);
  const notes: string[] = [];
  if (snap.bootedSims === null)
    notes.push('xcrun simctl failed — every idb_companion is kept this run');
  if (snap.liveWorktreeSlugs === null)
    notes.push('git worktree list failed — simulator owners unknown');
  if ((snap.cpuHistory ?? []).every((s) => Date.now() - s.at < ORPHAN_IDLE_WINDOW_MS))
    notes.push(
      `no CPU sample ${ORPHAN_IDLE_WINDOW_MS / 60_000}+ minutes old in ${CPU_LEDGER_PATH} yet — nothing can be proven idle this run`,
    );
  const items = classify(snap, Date.now(), opts);
  const docker = await run(
    'docker',
    ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}'],
    20_000,
  );
  if (docker.code !== 0) notes.push('docker stats unreadable (Docker not running?)');
  for (const line of docker.stdout.trim().split('\n').filter(Boolean)) {
    const [name = '?', usage = ''] = line.split('\t');
    items.push({
      id: `docker:${name}`,
      category: 'docker',
      kind: 'protected',
      label: name,
      rssBytes: parseDockerBytes(usage),
      pids: [],
      reason: 'docker container — never stopped by this tool (local databases run in Docker)',
      score: 10,
      scoreWhy: 'never stopped by this tool',
    });
  }
  return {
    mode: 'report',
    generatedAt: new Date().toISOString(),
    aggressive: opts.aggressive === true,
    memory,
    items,
    work: findWork(snap),
    notes,
  };
}

export function parseDockerBytes(usage: string): number {
  const [, amount, unitName] = usage.match(/([\d.]+)\s*([KMGT]?i?B)/) ?? [];
  if (amount === undefined || unitName === undefined) return 0;
  const units: Record<string, number> = {
    B: 1,
    KiB: KB,
    MiB: KB ** 2,
    GiB: KB ** 3,
    TiB: KB ** 4,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
  };
  return Number(amount) * (units[unitName] ?? 1);
}

const gb = (b: number) => (b / KB ** 3).toFixed(1);

function printReport(r: Report): void {
  const m = r.memory;
  console.log(
    `Memory: ${gb(m.usedBytes)} / ${gb(m.totalBytes)} GB in use · swap ${gb(m.swapUsedBytes)} / ${gb(m.swapTotalBytes)} GB · pressure level ${m.pressureLevel ?? '?'} (1 normal, 2 warn, 4 critical)`,
  );
  for (const category of [
    'orphans',
    'dev-servers',
    'idb-companion',
    'simulators',
    'emulators',
    'agent-sessions',
    'docker',
    'apps',
  ] as const) {
    const items = r.items.filter((i) => i.category === category);
    if (items.length === 0) continue;
    const total = items.reduce((s, i) => s + i.rssBytes, 0);
    console.log(`\n## ${category} — ${items.length} item(s), ${gb(total)} GB resident`);
    for (const i of items.slice(0, PRETTY_LINES_PER_CATEGORY)) {
      const tag =
        i.kind === 'candidate' ? 'candidate' : i.kind === 'needsApproval' ? 'approve?' : 'kept';
      const id =
        i.udid && i.category === 'simulators'
          ? ` [${i.udid}]`
          : i.rootPid
            ? ` [pid ${i.rootPid}]`
            : '';
      console.log(
        `  ${tag.padEnd(10)} ${String(i.score ?? '?').padStart(2)}/10 ${gb(i.rssBytes).padStart(6)} GB  ${i.label}${id} — ${i.reason}${i.scoreWhy ? ` · score: ${i.scoreWhy}` : ''}`,
      );
    }
    const rest = items.slice(PRETTY_LINES_PER_CATEGORY);
    if (rest.length > 0) {
      const count = (k: Kind) => rest.filter((i) => i.kind === k).length;
      console.log(
        `  … ${rest.length} more (${count('candidate')} candidate, ${count('needsApproval')} approve?, ${count('protected')} kept) — full list in the JSON report`,
      );
    }
  }
  const work = r.work ?? [];
  if (work.length > 0) {
    console.log(`\n## work in progress — ${work.length} job(s), never stopped`);
    for (const w of work.slice(0, PRETTY_LINES_PER_CATEGORY)) {
      const owner = w.ownerSessionPid === undefined ? 'no live session' : `session pid ${w.ownerSessionPid}`;
      console.log(
        `  work       ${String(Math.round(w.cpuPct)).padStart(4)}% CPU ${gb(w.rssBytes).padStart(6)} GB  ${w.label} [pid ${w.pid}] — ${owner}`,
      );
    }
  }
  for (const n of r.notes) console.log(`note: ${n}`);
  console.log(
    '\nRSS double-counts shared pages and ignores compressed/swapped memory: treat sizes as a ranking, and the before/after delta as the real number.',
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

async function waitForExit(pids: number[]): Promise<number[]> {
  const deadline = Date.now() + TERM_GRACE_MS;
  while (Date.now() < deadline && pids.some(isAlive)) await new Promise((r) => setTimeout(r, 250));
  return pids.filter(isAlive);
}

async function terminate(
  pids: number[],
  sigkill: boolean,
): Promise<{ survivors: number[]; killed: boolean }> {
  signalAll(pids, 'SIGTERM');
  const survivors = await waitForExit(pids);
  if (survivors.length === 0 || !sigkill) return { survivors, killed: false };
  signalAll(survivors, 'SIGKILL');
  return { survivors: await waitForExit(survivors), killed: true };
}

export function selectApproved(
  saved: Item[],
  fresh: Item[],
  opts: { categories: Set<Category>; pids: Set<number>; udids: Set<string>; maxScore?: number },
): { act: Item[]; skipped: { item: Item; why: string }[] } {
  const freshById = new Map(fresh.map((i) => [i.id, i]));
  const act: Item[] = [];
  const skipped: { item: Item; why: string }[] = [];
  for (const item of saved) {
    if (!opts.categories.has(item.category) || item.kind === 'protected') continue;
    const approvedById =
      (item.rootPid !== undefined && opts.pids.has(item.rootPid)) ||
      (item.udid !== undefined && item.category === 'simulators' && opts.udids.has(item.udid));
    const lowScore = (i: Item) => opts.maxScore !== undefined && (i.score ?? 10) <= opts.maxScore;
    if (item.kind === 'needsApproval' && !approvedById && !lowScore(item)) continue;
    const now = freshById.get(item.id);
    if (!now)
      skipped.push({
        item,
        why: 'gone or restarted since the report (pid/start time no longer match)',
      });
    else if (now.kind === 'protected') skipped.push({ item, why: `now protected: ${now.reason}` });
    else if (now.kind === 'needsApproval' && !approvedById && !lowScore(now))
      skipped.push({
        item,
        why: `now scores ${now.score ?? '?'}/10: ${now.scoreWhy ?? now.reason}`,
      });
    else act.push(now);
  }
  return { act, skipped };
}

/** The agent session this run belongs to: the nearest `claude`/`codex` above it, else its parent. */
export function sessionPidOf(psPidPpidComm: string, pid: number): number | undefined {
  const parents = new Map<number, { ppid: number; comm: string }>();
  for (const line of psPidPpidComm.split(/\r?\n/)) {
    const [, p, pp, comm] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/) ?? [];
    if (p !== undefined && pp !== undefined && comm !== undefined)
      parents.set(Number(p), { ppid: Number(pp), comm: comm.trim() });
  }
  const seen = new Set<number>();
  for (let cur = parents.get(pid)?.ppid; cur !== undefined && cur > 1 && !seen.has(cur); cur = parents.get(cur)?.ppid) {
    seen.add(cur);
    if (AGENT_COMMANDS.has(basename(parents.get(cur)?.comm ?? ''))) return cur;
  }
  return undefined;
}

function getActor(): string {
  const account = process.env.CLAUDE_CONFIG_DIR ? basename(process.env.CLAUDE_CONFIG_DIR) : 'default account';
  let session: number | undefined;
  try {
    session = sessionPidOf(execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', maxBuffer: 64 * KB * KB }), process.pid);
  } catch {
    session = undefined;
  }
  return `memory-reclaim pid ${process.pid} (${session === undefined ? `parent ${process.ppid}` : `session pid ${session}`}, ${account}) in ${process.cwd()}`;
}

/** Appends to the machine-wide stop log, keeping its newest STOP_LOG_MAX_LINES lines. */
export function appendStopLog(lines: string[]): void {
  if (lines.length === 0) return;
  try {
    mkdirSync(dirname(STOP_LOG_PATH), { recursive: true });
    appendFileSync(STOP_LOG_PATH, `${lines.join('\n')}\n`);
    const all = readFileSync(STOP_LOG_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
    if (all.length > STOP_LOG_MAX_LINES)
      writeFileSync(STOP_LOG_PATH, `${all.slice(-STOP_LOG_MAX_LINES).join('\n')}\n`);
  } catch (error) {
    console.error(`could not write the stop log ${STOP_LOG_PATH}: ${String(error)}`);
  }
}

async function apply(
  saved: Report,
  categories: Set<Category>,
  pids: Set<number>,
  udids: Set<string>,
  sigkill: boolean,
  maxScore?: number,
): Promise<void> {
  const ageMs = Date.now() - Date.parse(saved.generatedAt);
  if (!(ageMs >= 0 && ageMs <= MAX_REPORT_AGE_MS))
    throw new Error(
      'report is over an hour old, undated or from the future — run the report again; processes change fast',
    );
  const before = await readMemory();
  const fresh = await buildReport({ aggressive: saved.aggressive === true });
  const { act, skipped } = selectApproved(saved.items, fresh.items, {
    categories,
    pids,
    udids,
    ...(maxScore === undefined ? {} : { maxScore }),
  });
  const lines: string[] = [];
  const logLines: string[] = [];
  const actor = getActor();
  const log = (item: Item, outcome: string) =>
    logLines.push(formatStopLogLine(item, { at: new Date().toISOString(), outcome, actor }));
  for (const item of act) {
    if (item.category === 'simulators' && item.udid) {
      const res = await run('xcrun', ['simctl', 'shutdown', item.udid], 120_000);
      log(item, res.code === 0 ? 'shut down' : `shutdown failed (simctl exit ${res.code})`);
      lines.push(
        `${res.code === 0 ? 'ok  ' : 'FAIL'} [simulators] ${item.label} ${gb(item.rssBytes)} GB — ${res.code === 0 ? 'shut down (not deleted)' : `simctl exit ${res.code}`} · ${item.scoreWhy ?? item.reason}`,
      );
      continue;
    }
    const { survivors, killed } = await terminate(item.pids, sigkill);
    log(item, survivors.length === 0 ? 'stopped' : `partly stopped, alive: ${survivors.join(',')}`);
    const how = killed ? 'SIGTERM then SIGKILL' : 'SIGTERM';
    const outcome =
      survivors.length === 0
        ? `${how}, ${item.pids.length} process(es) exited`
        : `still alive after ${how}: ${survivors.join(',')}${sigkill ? '' : ' (re-run with --sigkill)'}`;
    lines.push(
      `${survivors.length === 0 ? 'ok  ' : 'PART'} [${item.category}] ${item.label} ${gb(item.rssBytes)} GB — ${outcome} · ${item.scoreWhy ?? item.reason}`,
    );
  }
  appendStopLog(logLines);
  for (const s of skipped) lines.push(`skip [${s.item.category}] ${s.item.label} — ${s.why}`);
  await new Promise((r) => setTimeout(r, 3000));
  const after = await readMemory();
  console.log(
    `Memory in use: ${gb(before.usedBytes)} → ${gb(after.usedBytes)} GB (freed ${gb(before.usedBytes - after.usedBytes)}) · swap ${gb(before.swapUsedBytes)} → ${gb(after.swapUsedBytes)} GB · pressure ${before.pressureLevel} → ${after.pressureLevel}`,
  );
  console.log(
    'Other sessions allocate concurrently, and swap drains lazily, so the delta is approximate.',
  );
  for (const l of lines) console.log(`  ${l}`);
  if (lines.length === 0) console.log('  nothing approved matched the saved report');
  else if (logLines.length > 0) console.log(`Logged to ${STOP_LOG_PATH} for the sessions that owned them.`);
}

export const STALE_MAX_SCORE = 5;

/** What a --stale or --aggressive run stops, before it re-scores each item. */
export function selectStale(items: Item[]): Item[] {
  return items.filter(
    (i) => APPLY_CATEGORIES.includes(i.category) && i.kind !== 'protected' && (i.score ?? 10) <= STALE_MAX_SCORE,
  );
}

const USAGE = `Usage:
  node memory-reclaim.mts --aggressive   the pre-hold run: --stale plus idle devices and dev servers live sessions own
  node memory-reclaim.mts --stale        report, then stop everything scored ${STALE_MAX_SCORE} or lower (no approval needed)
  add --dry-run to either to print what it would stop and stop nothing; --save <report.json> keeps its report
  node memory-reclaim.mts [--pretty] [--save <report.json>]
  node memory-reclaim.mts --apply --from <report.json> --category a,b [--pid <pid,...>] [--udid <udid,...>] [--max-score <1-9>] [--sigkill]
  --max-score N also stops every item scored N or lower (1-10, how likely it is still needed)
Apply categories: ${APPLY_CATEGORIES.join(', ')} (agent-sessions, apps and docker are report-only)`;

export function parseArgs(
  argv: string[],
  known: Set<string>,
  valued: Set<string>,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    if (!known.has(key)) throw new Error(`unknown flag --${key}`);
    if (valued.has(key)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
      out[key] = value;
      i++;
    } else out[key] = true;
  }
  return out;
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
  const flags = new Set([
    'stale',
    'aggressive',
    'dry-run',
    'apply',
    'from',
    'category',
    'pid',
    'udid',
    'sigkill',
    'max-score',
    'pretty',
    'save',
    'help',
  ]);
  const valued = new Set(['from', 'category', 'pid', 'udid', 'save', 'max-score']);
  const list = (v: string | boolean | undefined) =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  try {
    const args = parseArgs(process.argv.slice(2), flags, valued);
    if (args.help) {
      console.log(USAGE);
    } else if (args.stale || args.aggressive) {
      const report = await buildReport({ aggressive: args.aggressive === true });
      const saved =
        typeof args.save === 'string' ? args.save : join(tmpdir(), 'memory-reclaim-stale.json');
      writeFileSync(saved, `${JSON.stringify(report, null, 2)}\n`);
      printReport(report);
      const stale = selectStale(report.items);
      if (args['dry-run']) {
        console.log(`\nWould stop ${stale.length} item(s) scored ${STALE_MAX_SCORE} or lower (report: ${saved}):`);
        for (const i of stale)
          console.log(`  ${i.score}/10 ${gb(i.rssBytes).padStart(6)} GB [${i.category}] ${i.label} — ${i.scoreWhy}`);
      } else {
        console.log(`\nStopping everything scored ${STALE_MAX_SCORE} or lower (report: ${saved}):`);
        await apply(report, new Set(APPLY_CATEGORIES), new Set(), new Set(), true, STALE_MAX_SCORE);
      }
    } else if (args.apply) {
      const categories = list(args.category);
      const bad = categories.filter((c) => !APPLY_CATEGORIES.includes(c as Category));
      if (typeof args.from !== 'string' || categories.length === 0 || bad.length > 0)
        throw new Error(
          bad.length
            ? `not an apply category: ${bad.join(', ')}`
            : '--apply needs --from and --category',
        );
      const pids = new Set(list(args.pid).map(Number));
      const udids = new Set(list(args.udid).map((u) => u.toUpperCase()));
      if (udids.size > 0 && !categories.includes('simulators'))
        throw new Error('--udid needs --category simulators');
      const maxScore =
        typeof args['max-score'] === 'string' ? Number(args['max-score']) : undefined;
      if (maxScore !== undefined && !(Number.isInteger(maxScore) && maxScore >= 1 && maxScore <= 9))
        throw new Error('--max-score takes a whole number from 1 to 9');
      await apply(
        JSON.parse(readFileSync(args.from, 'utf8')) as Report,
        new Set(categories as Category[]),
        pids,
        udids,
        args.sigkill === true,
        maxScore,
      );
    } else {
      if (args['dry-run']) throw new Error('--dry-run goes with --stale or --aggressive');
      const report = await buildReport();
      if (typeof args.save === 'string')
        writeFileSync(args.save, `${JSON.stringify(report, null, 2)}\n`);
      if (args.pretty) printReport(report);
      else console.log(JSON.stringify(report, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exit(2);
  }
}
