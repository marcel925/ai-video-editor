#!/usr/bin/env node
// Self-contained on purpose: Node 24 runs this file as is, with no dependency and no other file.
// The scale and procedure: skills/machine-memory-reclaim/SKILL.md in this repo.
import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Category =
  | 'orphans'
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
  memory: MemoryState;
  items: Item[];
  notes: string[];
};

export const APPLY_CATEGORIES: readonly Category[] = [
  'orphans',
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

function commName(proc: Proc): string {
  return basename(proc.comm);
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

function rootKindOf(proc: Proc, snap: Snapshot, simRoots: Map<number, string>): Category | null {
  const name = commName(proc);
  if (AGENT_COMMANDS.has(name)) return 'agent-sessions';
  if (simRoots.has(proc.pid)) return 'simulators';
  if (proc.ppid !== 1) return null;
  if (name.startsWith('qemu-system')) return 'emulators';
  if (name === 'idb_companion') return 'idb-companion';
  if (DEV_COMMANDS.has(name) && !snap.launchdJobPids.has(proc.pid)) return 'orphans';
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

export function classify(snap: Snapshot, now: number): Item[] {
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
    const kind = rootKindOf(p, snap, simRoots);
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
    const base = {
      id: `${pid}@${root.started}`,
      category,
      rssBytes,
      pids,
      rootPid: pid,
      rootStarted: root.started,
      startedAt: root.started,
    };
    const age = ageText(root.started, now);
    const cwd = snap.cwds.get(pid);
    const isSelf = pids.some((id) => snap.selfPids.has(id));

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
      items.push({
        ...base,
        kind: 'needsApproval',
        label: `Android emulator ${avd}`,
        reason: `${age}; the shared AVD other sessions boot — stop only by approved pid when no session is on it`,
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
    Object.assign(item, scoreItem(item, snap, sessionWorktrees, byPid, now));
  for (const item of items) {
    const family = deviceFamily(item);
    if (family === undefined || (item.score ?? 10) > 5) continue;
    const busy = items.find(
      (other) => other !== item && deviceFamily(other) === family && (other.score ?? 0) >= 6,
    );
    if (busy)
      Object.assign(item, { score: 6, scoreWhy: `same run as ${busy.label}, which is in use` });
  }
  return items.sort((a, b) => b.rssBytes - a.rssBytes);
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

function scoreItem(
  item: Item,
  snap: Snapshot,
  sessionWorktrees: Set<string>,
  byPid: Map<number, Proc>,
  now: number,
): { score: number; scoreWhy: string } {
  if (item.kind === 'protected') return { score: 10, scoreWhy: 'never stopped by this tool' };
  const root = item.rootPid === undefined ? undefined : byPid.get(item.rootPid);
  if (item.kind === 'candidate') {
    if (item.category === 'idb-companion')
      return { score: 1, scoreWhy: 'its simulator is not booted' };
    if (root && isHungTestRunner(root, now))
      return { score: 2, scoreWhy: 'a test run past 30 minutes with no parent' };
    return { score: 1, scoreWhy: 'its worktree is gone' };
  }
  const slug =
    item.category === 'simulators'
      ? item.label.match(CONTROL_APP_DEVICE)?.[1]
      : worktreeSlugOf(item.cwd);
  if (slug !== undefined && sessionWorktrees.has(slug))
    return { score: 8, scoreWhy: `an agent session is open in worktree ${slug}` };
  const simCheckout =
    item.category === 'simulators' && slug !== undefined
      ? snap.worktreePaths?.get(slug)
      : undefined;
  const server = simCheckout === undefined ? undefined : listenerIn(simCheckout, snap);
  if (server !== undefined)
    return {
      score: 8,
      scoreWhy: `its worktree still serves it: pid ${server} listens from ${slug}`,
    };
  if (snap.cpuPct === null)
    return { score: 6, scoreWhy: 'CPU use unreadable, so it may be busy' };
  const cpu = item.pids.reduce((sum, pid) => sum + (snap.cpuPct?.get(pid) ?? 0), 0);
  if (cpu >= (BUSY_CPU_PCT[item.category] ?? 5))
    return { score: 7, scoreWhy: `busy: ${Math.round(cpu)}% CPU` };
  const ageMs = now - Date.parse(item.startedAt ?? '');
  if (!(ageMs >= YOUNG_MS)) return { score: 6, scoreWhy: 'started under 30 minutes ago' };
  if (simCheckout !== undefined && snap.listeningPids === null)
    return {
      score: 6,
      scoreWhy: 'listening sockets unreadable, so its worktree may still serve it',
    };
  if (item.category === 'orphans') {
    if (item.cwd === undefined)
      return { score: 6, scoreWhy: 'working directory unreadable, so its owner is unknown' };
    if (snap.listeningPids === null)
      return { score: 6, scoreWhy: 'listening sockets unreadable, so it may be serving' };
    if (item.pids.some((pid) => snap.listeningPids?.has(pid)))
      return {
        score: 6,
        scoreWhy: 'serves on a port; a dev server goes only once its checkout is gone',
      };
  }
  const checkout =
    item.category === 'simulators' && slug !== undefined ? snap.worktreePaths?.get(slug) : item.cwd;
  const touchedAt = checkout === undefined ? undefined : snap.checkoutTouchedAt?.(checkout);
  if (touchedAt === null)
    return { score: 6, scoreWhy: 'its checkout is unreadable, so its activity is unknown' };
  if (touchedAt !== undefined && now - touchedAt < ACTIVE_CHECKOUT_MS)
    return {
      score: 6,
      scoreWhy: `its checkout's git state changed ${Math.round((now - touchedAt) / 60_000)}m ago`,
    };
  if (
    item.category === 'simulators' &&
    slug !== undefined &&
    snap.liveWorktreeSlugs !== null &&
    !snap.liveWorktreeSlugs.has(slug)
  )
    return { score: 2, scoreWhy: `idle, and worktree ${slug} is gone` };
  if (slug !== undefined)
    return { score: 3, scoreWhy: `idle, and nothing has touched worktree ${slug} for an hour` };
  return item.category === 'orphans'
    ? { score: 4, scoreWhy: 'idle orphan outside any worktree; restarts on demand' }
    : { score: 5, scoreWhy: 'idle for 30+ minutes and no session claims it' };
}

// Idle CPU and an untouched checkout are not unused: hand testing leaves both quiet while Metro runs.
function listenerIn(checkout: string, snap: Snapshot): number | undefined {
  for (const pid of snap.listeningPids ?? []) {
    const cwd = snap.cwds.get(pid);
    if (cwd === checkout || cwd?.startsWith(`${checkout}/`)) return pid;
  }
  return undefined;
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

export async function collectSnapshot(): Promise<Snapshot> {
  const [pidRes, commRes, cpuRes, listenRes, simRes, launchdRes] = await Promise.all([
    run('ps', ['-axo', 'pid=,ppid=,rss=,lstart=,args=']),
    run('ps', ['-axo', 'pid=,comm=']),
    run('ps', ['-axo', 'pid=,%cpu=']),
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fp']),
    run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']),
    run('launchctl', ['list']),
  ]);
  const procs = parsePs(pidRes.stdout, commRes.stdout);
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
    .filter((p) => p.ppid === 1 || AGENT_COMMANDS.has(commName(p)))
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
  };
}

export async function buildReport(): Promise<Report> {
  const [memory, snap] = await Promise.all([readMemory(), collectSnapshot()]);
  const notes: string[] = [];
  if (snap.bootedSims === null)
    notes.push('xcrun simctl failed — every idb_companion is kept this run');
  if (snap.liveWorktreeSlugs === null)
    notes.push('git worktree list failed — simulator owners unknown');
  const items = classify(snap, Date.now());
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
  return { mode: 'report', generatedAt: new Date().toISOString(), memory, items, notes };
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
  const fresh = await buildReport();
  const { act, skipped } = selectApproved(saved.items, fresh.items, {
    categories,
    pids,
    udids,
    ...(maxScore === undefined ? {} : { maxScore }),
  });
  const lines: string[] = [];
  for (const item of act) {
    if (item.category === 'simulators' && item.udid) {
      const res = await run('xcrun', ['simctl', 'shutdown', item.udid], 120_000);
      lines.push(
        `${res.code === 0 ? 'ok  ' : 'FAIL'} [simulators] ${item.label} ${gb(item.rssBytes)} GB — ${res.code === 0 ? 'shut down (not deleted)' : `simctl exit ${res.code}`}`,
      );
      continue;
    }
    const { survivors, killed } = await terminate(item.pids, sigkill);
    const how = killed ? 'SIGTERM then SIGKILL' : 'SIGTERM';
    const outcome =
      survivors.length === 0
        ? `${how}, ${item.pids.length} process(es) exited`
        : `still alive after ${how}: ${survivors.join(',')}${sigkill ? '' : ' (re-run with --sigkill)'}`;
    lines.push(
      `${survivors.length === 0 ? 'ok  ' : 'PART'} [${item.category}] ${item.label} ${gb(item.rssBytes)} GB — ${outcome}`,
    );
  }
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
}

export const STALE_MAX_SCORE = 5;

const USAGE = `Usage:
  node memory-reclaim.mts --stale        report, then stop everything scored ${STALE_MAX_SCORE} or lower (no approval needed)
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
    } else if (args.stale) {
      const report = await buildReport();
      const saved = join(tmpdir(), 'memory-reclaim-stale.json');
      writeFileSync(saved, `${JSON.stringify(report, null, 2)}\n`);
      printReport(report);
      console.log(`\nStopping everything scored ${STALE_MAX_SCORE} or lower (report: ${saved}):`);
      await apply(report, new Set(APPLY_CATEGORIES), new Set(), new Set(), true, STALE_MAX_SCORE);
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
