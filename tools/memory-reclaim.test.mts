import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  classify,
  isPathGone,
  type Item,
  memoryUsedBytes,
  parseDockerBytes,
  parseArgs,
  parseListeningPids,
  parsePs,
  parseSwapUsage,
  parseVmStat,
  type Proc,
  selectApproved,
  type Snapshot,
  worktreeSlugOf,
} from './memory-reclaim.mts';

const STARTED = 'Mon Nov 9 10:00:00 2026';
const NOW = Date.parse('Tue Nov 10 10:00:00 2026');
const SIM = '9BB3C5B9-DB35-4DBC-8F87-732658B4FBFC';
const OTHER_SIM = '0ADA8282-753F-4282-BB9A-CEE0699E26EF';

const proc = (pid: number, ppid: number, comm: string, args = comm, rssKb = 1024): Proc => ({
  pid,
  ppid,
  rssKb,
  started: STARTED,
  comm,
  args,
});

function snapshot(procs: Proc[], over: Partial<Snapshot> = {}): Snapshot {
  return {
    procs,
    bootedSims: [{ udid: SIM, name: 'control-app-fix-x' }],
    cwds: new Map(),
    launchdJobPids: new Set(),
    liveWorktreeSlugs: new Set(['fix-x']),
    isPathGone: () => false,
    selfPids: new Set(),
    ...over,
  };
}

const byLabel = (items: Item[], prefix: string) => items.find((i) => i.label.startsWith(prefix));

test('parsePs joins the args and comm listings and keeps a multi-space start time', () => {
  const procs = parsePs(
    '  101     1 12400 Fri Nov  6 15:43:15 2026     /opt/homebrew/bin/idb_companion --udid X\n  7 1 5 bad line\n',
    '  101 /opt/homebrew/bin/idb_companion\n',
  );
  assert.deepEqual(procs, [
    {
      pid: 101,
      ppid: 1,
      rssKb: 12400,
      started: 'Fri Nov 6 15:43:15 2026',
      comm: '/opt/homebrew/bin/idb_companion',
      args: '/opt/homebrew/bin/idb_companion --udid X',
    },
  ]);
});

test('memory parsers read vm_stat, swapusage and docker sizes', () => {
  const vm = parseVmStat(
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nAnonymous pages:  100.\nPages wired down:  50.\nPages occupied by compressor:  10.\n',
  );
  assert.equal(memoryUsedBytes(vm), 160 * 16384);
  assert.deepEqual(
    parseSwapUsage('total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)'),
    { totalBytes: 2048 * 1024 ** 2, usedBytes: 1024.5 * 1024 ** 2 },
  );
  assert.equal(parseDockerBytes('312.4MiB / 7.6GiB'), 312.4 * 1024 ** 2);
  assert.equal(parseDockerBytes('garbage'), 0);
});

test('an agent session owns its MCP servers and is never offered for stopping', () => {
  const items = classify(
    snapshot([
      proc(10, 5, '/Users/u/.local/bin/claude'),
      proc(11, 10, 'npm', 'npm exec @digitalocean/mcp', 2048),
      proc(12, 11, 'node', 'node mcp', 4096),
    ]),
    NOW,
  );
  const session = items.find((i) => i.category === 'agent-sessions');
  assert.equal(session?.kind, 'protected');
  assert.deepEqual(session?.pids.sort(), [10, 11, 12]);
  assert.equal(session?.rssBytes, (1024 + 2048 + 4096) * 1024);
  assert.equal(
    items.some((i) => i.category === 'orphans'),
    false,
  );
});

test('an orphan dev process is a candidate only when its working directory is gone', () => {
  const procs = [
    proc(20, 1, 'node', 'node expo start'),
    proc(21, 20, 'node', 'node metro worker'),
    proc(30, 1, 'node', 'node server.js'),
  ];
  const cwds = new Map([
    [20, '/repo/.claude/worktrees/fix/gone/apps/mobile'],
    [30, '/repo/.claude/worktrees/fix/live'],
  ]);
  const items = classify(snapshot(procs, { cwds, isPathGone: (p) => p.includes('/gone/') }), NOW);
  const gone = byLabel(items, 'node pid 20');
  assert.equal(gone?.kind, 'candidate');
  assert.deepEqual(gone?.pids, [20, 21]);
  const live = byLabel(items, 'node pid 30');
  assert.equal(live?.kind, 'needsApproval');
  assert.match(live?.reason ?? '', /worktree fix\/live/);
});

test('an orphaned test runner past 30 minutes is a candidate even in a live worktree', () => {
  const fresh = {
    ...proc(41, 1, 'node', 'node --test-concurrency=0 --test bash-guard.test.mjs'),
    started: 'Tue Nov 10 09:50:00 2026',
  };
  const procs = [
    proc(40, 1, 'node', 'node --test-concurrency=0 --test bash-guard.test.mjs'),
    fresh,
    proc(42, 1, 'node', 'node /repo/node_modules/.bin/vitest run'),
    proc(43, 1, 'node', 'node server.js'),
    proc(
      44,
      1,
      'node',
      'node /repo/.claude/worktrees/fix/jest-timeouts/node_modules/.bin/tsx watch src/server.ts',
    ),
    proc(45, 1, 'node', 'node /repo/node_modules/jest-worker/build/processChild.js'),
    proc(46, 1, 'node', 'node seed.mjs --test'),
    proc(47, 1, 'node', 'node /repo/node_modules/jest/bin/jest.js --runInBand'),
  ];
  const cwds = new Map(
    [40, 41, 42, 43, 44, 45, 46, 47].map((pid) => [pid, '/repo/.claude/worktrees/fix/live']),
  );
  const items = classify(snapshot(procs, { cwds }), NOW);
  assert.equal(byLabel(items, 'node pid 40')?.kind, 'candidate');
  assert.match(byLabel(items, 'node pid 40')?.reason ?? '', /test runner/);
  assert.equal(byLabel(items, 'node pid 42')?.kind, 'candidate');
  assert.equal(byLabel(items, 'node pid 41')?.kind, 'needsApproval');
  assert.equal(byLabel(items, 'node pid 47')?.kind, 'candidate');
  for (const pid of [43, 44, 45, 46]) {
    assert.equal(byLabel(items, `node pid ${pid}`)?.kind, 'needsApproval', `pid ${pid}`);
  }
});

test('a launchd job and a process of this very session are never orphans', () => {
  const items = classify(
    snapshot(
      [
        proc(40, 1, 'node', 'node triggers-cron/run.sh'),
        proc(41, 1, 'node', 'node memory-reclaim.mts'),
      ],
      { launchdJobPids: new Set([40]), selfPids: new Set([41]) },
    ),
    NOW,
  );
  assert.equal(byLabel(items, 'node pid 40'), undefined);
  assert.equal(byLabel(items, 'node pid 41')?.kind, 'protected');
});

test('an idb_companion is a candidate only when its simulator is known not to be booted', () => {
  const procs = [
    proc(50, 1, 'idb_companion', `idb_companion --udid ${OTHER_SIM} --only simulator`),
    proc(51, 1, 'idb_companion', `idb_companion --udid ${SIM} --only simulator`),
  ];
  const items = classify(snapshot(procs), NOW).filter((i) => i.category === 'idb-companion');
  assert.deepEqual(items.map((i) => [i.rootPid, i.kind]).sort(), [
    [50, 'candidate'],
    [51, 'protected'],
  ]);
  const unreadable = classify(snapshot(procs, { bootedSims: null }), NOW).filter(
    (i) => i.category === 'idb-companion',
  );
  assert.ok(unreadable.every((i) => i.kind === 'protected'));
});

test('a booted simulator is grouped under its launchd_sim and only offered by UDID', () => {
  const procs = [
    proc(
      60,
      1,
      'launchd_sim',
      `launchd_sim /Users/u/Library/Developer/CoreSimulator/Devices/${SIM}/data/var/run/launchd_bootstrap.plist`,
    ),
    proc(61, 60, '/RuntimeRoot/SpringBoard', 'SpringBoard', 4096),
  ];
  const sim = classify(snapshot(procs), NOW).find((i) => i.category === 'simulators');
  assert.equal(sim?.kind, 'needsApproval');
  assert.equal(sim?.id, `${SIM}@${STARTED}`);
  assert.equal(sim?.rssBytes, (1024 + 4096) * 1024);
  assert.match(sim?.reason ?? '', /worktree "fix-x" still exists/);
});

test('an app that hosts an agent session says quitting it ends the session', () => {
  const procs = [
    proc(72, 1, '/Applications/Claude.app/Contents/MacOS/Claude'),
    proc(73, 72, '/Applications/Claude.app/Contents/Frameworks/Claude Helper', 'helper'),
    proc(74, 72, '/Users/u/.local/bin/claude', 'claude', 2048),
  ];
  const items = classify(snapshot(procs), NOW);
  const app = items.find((i) => i.category === 'apps');
  assert.deepEqual(app?.pids.sort(), [72, 73]);
  assert.match(app?.reason ?? '', /hosting 1 live agent session/);
  assert.equal(items.find((i) => i.category === 'agent-sessions')?.rootPid, 74);
});

test('desktop apps are summed per bundle and only reported', () => {
  const procs = [
    proc(70, 1, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    proc(71, 70, '/Applications/Google Chrome.app/Contents/Frameworks/Helper', 'helper', 3072),
  ];
  const app = classify(snapshot(procs), NOW).find((i) => i.category === 'apps');
  assert.equal(app?.label, 'Google Chrome');
  assert.equal(app?.kind, 'protected');
  assert.equal(app?.rssBytes, 4096 * 1024);
});

const SIM_ITEM_ID = `${SIM}@${STARTED}`;

const item = (over: Partial<Item>): Item => ({
  id: '80@x',
  category: 'orphans',
  kind: 'candidate',
  label: 'l',
  rssBytes: 0,
  pids: [80],
  rootPid: 80,
  reason: '',
  ...over,
});

test('apply acts on a named candidate, and on an approval item only when its pid or UDID is passed', () => {
  const saved = [
    item({}),
    item({ id: '81@x', rootPid: 81, pids: [81], kind: 'needsApproval' }),
    item({ id: '82@x', rootPid: 82, pids: [82], kind: 'needsApproval' }),
    item({
      id: SIM_ITEM_ID,
      category: 'simulators',
      kind: 'needsApproval',
      udid: SIM,
      rootPid: 60,
    }),
  ];
  const { act, skipped } = selectApproved(saved, saved, {
    categories: new Set(['orphans', 'simulators']),
    pids: new Set([81]),
    udids: new Set(),
  });
  assert.deepEqual(
    act.map((i) => i.id),
    ['80@x', '81@x'],
  );
  assert.deepEqual(skipped, []);
  const withUdid = selectApproved(saved, saved, {
    categories: new Set(['simulators']),
    pids: new Set(),
    udids: new Set([SIM]),
  });
  assert.deepEqual(
    withUdid.act.map((i) => i.id),
    [SIM_ITEM_ID],
  );
});

test('apply skips an item that restarted or became protected since the report, and ignores unnamed categories', () => {
  const saved = [
    item({}),
    item({ id: '81@x', rootPid: 81 }),
    item({ id: '90@x', category: 'idb-companion', rootPid: 90 }),
  ];
  const fresh = [
    item({ id: '81@x', rootPid: 81, kind: 'protected', reason: 'its simulator is booted' }),
  ];
  const { act, skipped } = selectApproved(saved, fresh, {
    categories: new Set(['orphans']),
    pids: new Set(),
    udids: new Set(),
  });
  assert.deepEqual(act, []);
  assert.deepEqual(
    skipped.map((s) => [s.item.id, s.why.split(':')[0]]),
    [
      ['80@x', 'gone or restarted since the report (pid/start time no longer match)'],
      ['81@x', 'now protected'],
    ],
  );
});

test('a rebooted simulator is skipped even when its UDID is approved', () => {
  const saved = [
    item({
      id: SIM_ITEM_ID,
      category: 'simulators',
      kind: 'needsApproval',
      udid: SIM,
      rootPid: 60,
    }),
  ];
  const rebooted = [
    item({
      id: `${SIM}@Tue Nov 10 09:59:00 2026`,
      category: 'simulators',
      kind: 'needsApproval',
      udid: SIM,
      rootPid: 99,
    }),
  ];
  const { act, skipped } = selectApproved(saved, rebooted, {
    categories: new Set(['simulators']),
    pids: new Set(),
    udids: new Set([SIM]),
  });
  assert.deepEqual(act, []);
  assert.equal(skipped[0]?.item.id, SIM_ITEM_ID);
});

test('only a missing directory reads as gone, never one that is merely unreadable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-reclaim-'));
  const locked = join(dir, 'locked');
  mkdirSync(join(locked, 'inner'), { recursive: true });
  chmodSync(locked, 0o000);
  try {
    assert.equal(isPathGone(dir), false);
    assert.equal(isPathGone(join(locked, 'inner')), false);
    assert.equal(isPathGone(join(dir, 'never-existed')), true);
  } finally {
    chmodSync(locked, 0o755);
    rmSync(dir, { recursive: true });
  }
});

test('every item is scored 1-10 for how likely it is still needed', () => {
  const older = 'Tue Nov 10 08:00:00 2026';
  const young = 'Tue Nov 10 09:50:00 2026';
  const at = (p: Proc, started: string): Proc => ({ ...p, started });
  const procs = [
    at(proc(10, 1, '/Users/u/.local/bin/claude', 'claude'), older),
    at(proc(20, 1, 'node', 'node tsx watch src/server.ts'), older),
    at(proc(21, 1, 'node', 'node tsx watch src/server.ts'), older),
    at(proc(22, 1, 'node', 'node tsx watch src/server.ts'), older),
    at(proc(23, 1, 'node', 'node tsx watch src/server.ts'), young),
    at(proc(24, 1, 'java', 'java GradleDaemon'), older),
    at(proc(25, 1, 'node', 'node tsx watch src/server.ts'), older),
    at(proc(26, 1, 'node', 'node tsx watch src/server.ts'), older),
  ];
  const cwds = new Map([
    [10, '/repo/.claude/worktrees/feat/live/apps/server'],
    [20, '/repo/.claude/worktrees/feat/live'],
    [21, '/repo/.claude/worktrees/feat/idle'],
    [22, '/repo/.claude/worktrees/feat/busy'],
    [23, '/repo/.claude/worktrees/feat/new'],
    [24, '/Users/u/.gradle/daemon/9.4.1'],
    [25, '/repo/.claude/worktrees/feat/removed-branch'],
    [26, '/repo/.claude/worktrees/feat/driven-by-path'],
  ]);
  const items = classify(
    snapshot(procs, {
      cwds,
      cpuPct: new Map([[22, 40]]),
      checkoutTouchedAt: (path) =>
        path.includes('driven-by-path') ? NOW - 10 * 60_000 : NOW - 3 * 3_600_000,
      liveWorktreeSlugs: new Set(['feat-live', 'feat-idle', 'feat-busy', 'feat-new']),
    }),
    NOW,
  );
  const score = (pid: number) => items.find((i) => i.rootPid === pid)?.score;
  assert.equal(score(10), 10);
  assert.equal(score(20), 8);
  assert.equal(score(22), 7);
  assert.equal(score(23), 6);
  assert.equal(score(24), 4);
  assert.equal(score(21), 3);
  assert.equal(score(25), 3);
  assert.equal(score(26), 6);
});

test('a control-app simulator scores by its worktree; a shared idle one scores 5', () => {
  const OLD = 'Tue Nov 10 08:00:00 2026';
  const simProc = (pid: number, udid: string): Proc => ({
    ...proc(
      pid,
      1,
      'launchd_sim',
      `launchd_sim /Users/u/Library/Developer/CoreSimulator/Devices/${udid}/data/x.plist`,
    ),
    started: OLD,
  });
  const procs = [simProc(60, SIM), simProc(62, OTHER_SIM)];
  const items = classify(
    snapshot(procs, {
      bootedSims: [
        { udid: SIM, name: 'control-app-fix-x' },
        { udid: OTHER_SIM, name: 'snc-qa-iphone17pro' },
      ],
    }),
    NOW,
  );
  assert.equal(items.find((i) => i.udid === SIM)?.score, 3);
  assert.equal(items.find((i) => i.udid === OTHER_SIM)?.score, 5);
});

test('--max-score stops a low-scored approval item and skips one that scores higher now', () => {
  const saved = [
    item({ id: '81@x', rootPid: 81, pids: [81], kind: 'needsApproval', score: 4 }),
    item({ id: '82@x', rootPid: 82, pids: [82], kind: 'needsApproval', score: 6 }),
    item({ id: '83@x', rootPid: 83, pids: [83], kind: 'needsApproval', score: 5 }),
    item({ id: 'app@x', kind: 'protected', score: 10 }),
  ];
  const fresh = saved.map((i) => (i.id === '83@x' ? { ...i, score: 8 } : i));
  const { act, skipped } = selectApproved(saved, fresh, {
    categories: new Set(['orphans']),
    pids: new Set(),
    udids: new Set(),
    maxScore: 5,
  });
  assert.deepEqual(
    act.map((i) => i.id),
    ['81@x'],
  );
  assert.deepEqual(
    skipped.map((s) => s.item.id),
    ['83@x'],
  );
});

test('worktreeSlugOf names a grouped and an ungrouped worktree the way control-app devices do', () => {
  assert.equal(worktreeSlugOf('/r/.claude/worktrees/feat/x/apps/mobile'), 'feat-x');
  assert.equal(worktreeSlugOf('/r/.claude/worktrees/prompt-base/packages'), 'prompt-base');
  assert.equal(worktreeSlugOf('/r/apps/server'), undefined);
});

test('an idle device in the same run as a busy one inherits its score', () => {
  const OLD = 'Tue Nov 10 08:00:00 2026';
  const procs = [
    {
      ...proc(
        60,
        1,
        'launchd_sim',
        `launchd_sim /Users/u/Library/Developer/CoreSimulator/Devices/${OTHER_SIM}/data/x.plist`,
      ),
      started: OLD,
    },
    {
      ...proc(
        90,
        1,
        'qemu-system-aarch64-headless',
        'qemu-system-aarch64-headless -avd snc_qa_phone -no-window',
      ),
      started: OLD,
    },
    {
      ...proc(
        91,
        1,
        'qemu-system-aarch64-headless',
        'qemu-system-aarch64-headless -avd Pixel_API_36 -no-window',
      ),
      started: OLD,
    },
  ];
  const items = classify(
    snapshot(procs, {
      bootedSims: [{ udid: OTHER_SIM, name: 'snc-qa-iphone17pro' }],
      cpuPct: new Map([[60, 80]]),
    }),
    NOW,
  );
  assert.equal(items.find((i) => i.udid === OTHER_SIM)?.score, 7);
  assert.equal(items.find((i) => i.rootPid === 90)?.score, 6);
  assert.match(
    items.find((i) => i.rootPid === 90)?.scoreWhy ?? '',
    /same run as snc-qa-iphone17pro/,
  );
  assert.equal(items.find((i) => i.rootPid === 91)?.score, 5);
});

test('an unknown fails closed: nothing scores 5 or below without the evidence', () => {
  const OLD = 'Tue Nov 10 08:00:00 2026';
  const orphan = (pid: number): Proc => ({
    ...proc(pid, 1, 'node', 'node tsx watch src/server.ts'),
    started: OLD,
  });
  const procs = [orphan(20), orphan(21), orphan(22), orphan(23)];
  const unreadCwds = classify(snapshot(procs), NOW);
  assert.ok(unreadCwds.filter((i) => i.category === 'orphans').every((i) => (i.score ?? 0) >= 6));

  const cwds = new Map(procs.map((p) => [p.pid, `/repo/.claude/worktrees/feat/w${p.pid}`]));
  const noLsof = classify(snapshot(procs, { cwds, listeningPids: null }), NOW);
  assert.ok(noLsof.filter((i) => i.category === 'orphans').every((i) => (i.score ?? 0) >= 6));
  const noCpu = classify(snapshot(procs, { cwds, listeningPids: new Set(), cpuPct: null }), NOW);
  assert.ok(noCpu.filter((i) => i.category === 'orphans').every((i) => (i.score ?? 0) >= 6));

  const scored = classify(
    snapshot(procs, {
      cwds,
      listeningPids: new Set([20]),
      checkoutTouchedAt: (path) => (path.endsWith('w21') ? null : NOW - 3 * 3_600_000),
    }),
    NOW,
  );
  const score = (pid: number) => scored.find((i) => i.rootPid === pid)?.score;
  assert.equal(score(20), 6);
  assert.equal(score(21), 6);
  assert.equal(score(22), 3);
});

test('a control-app simulator whose worktree was touched within the hour scores 6', () => {
  const OLD = 'Tue Nov 10 08:00:00 2026';
  const procs = [
    {
      ...proc(
        60,
        1,
        'launchd_sim',
        `launchd_sim /Users/u/Library/Developer/CoreSimulator/Devices/${SIM}/data/x.plist`,
      ),
      started: OLD,
    },
  ];
  const items = classify(
    snapshot(procs, {
      worktreePaths: new Map([['fix-x', '/repo/.claude/worktrees/fix/x']]),
      checkoutTouchedAt: (path) =>
        path === '/repo/.claude/worktrees/fix/x' ? NOW - 10 * 60_000 : undefined,
    }),
    NOW,
  );
  assert.equal(items.find((i) => i.udid === SIM)?.score, 6);
});

test('an idle control-app simulator scores 8 while a dev server listens from its worktree', () => {
  const OLD = 'Tue Nov 10 08:00:00 2026';
  const WT = '/repo/.claude/worktrees/fix/x';
  const procs = [
    {
      ...proc(
        60,
        1,
        'launchd_sim',
        `launchd_sim /Users/u/Library/Developer/CoreSimulator/Devices/${SIM}/data/x.plist`,
      ),
      started: OLD,
    },
  ];
  const score = (over: Partial<Snapshot>) =>
    classify(
      snapshot(procs, {
        worktreePaths: new Map([['fix-x', WT]]),
        checkoutTouchedAt: () => NOW - 3 * 3_600_000,
        cpuPct: new Map(),
        listeningPids: new Set([70]),
        ...over,
      }),
      NOW,
    ).find((i) => i.udid === SIM)?.score;

  assert.equal(score({ cwds: new Map([[70, `${WT}/apps/mobile`]]) }), 8);
  assert.equal(score({ cwds: new Map([[70, `${WT}-other`]]) }), 3);
  assert.equal(score({ cwds: new Map() }), 3);
  assert.equal(score({ listeningPids: null }), 6);
});

test('parseListeningPids reads lsof -F p lines only', () => {
  assert.deepEqual([...parseListeningPids('p101\nf12\np202\n')], [101, 202]);
});

test('parseArgs rejects an unknown flag, a stray word and a valued flag without its value', () => {
  const known = new Set(['stale', 'from']);
  const valued = new Set(['from']);
  assert.deepEqual(parseArgs(['--stale'], known, valued), { stale: true });
  assert.deepEqual(parseArgs(['--from', 'r.json'], known, valued), { from: 'r.json' });
  assert.throws(() => parseArgs(['--stael'], known, valued), /unknown flag/);
  assert.throws(() => parseArgs(['stale'], known, valued), /unexpected argument/);
  assert.throws(() => parseArgs(['--from', '--stale'], known, valued), /needs a value/);
});
