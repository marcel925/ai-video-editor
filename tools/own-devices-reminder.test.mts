import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Proc } from './memory-reclaim.mts';
import {
  findOwnedProcesses,
  findSessionPid,
  formatReminder,
  isInCheckout,
  isSimulatorForWorktrees,
  newDevices,
  orphansInCheckout,
  parseBootedSimulators,
  parseCwds,
  toOwnedDevice,
} from './own-devices-reminder.mts';

const STARTED = 'Thu Nov 26 10:00:00 2026';
const NOW = Date.parse('Thu Nov 26 10:25:00 2026');

const proc = (pid: number, ppid: number, comm: string, args = comm): Proc => ({
  pid,
  ppid,
  rssKb: 1024,
  started: STARTED,
  comm,
  args,
});

const PROCS: Proc[] = [
  proc(100, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2'),
  proc(200, 100, '/Users/u/.local/bin/claude', 'claude'),
  proc(210, 200, '/bin/zsh', '/bin/zsh -c npm exec expo start --port 8100'),
  proc(220, 210, 'npm exec expo start --port 8100', 'npm exec expo start --port 8100'),
  proc(230, 220, 'node', 'node /wt/node_modules/.bin/expo start --port 8100'),
  proc(240, 200, '/bin/zsh', '/bin/zsh -c emulator -avd check -port 5654'),
  proc(
    250,
    240,
    '/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless',
    'qemu-system-aarch64-headless -avd check -port 5654',
  ),
  proc(260, 200, '/bin/zsh', '/bin/zsh -c node tools/own-devices-reminder.mts'),
  proc(270, 260, 'node', 'node tools/own-devices-reminder.mts'),
  proc(280, 200, 'node', 'node /r/motion/node_modules/.bin/remotion studio src/index.ts'),
  proc(300, 100, '/Users/u/.local/bin/claude', 'claude'),
  proc(310, 300, 'node', 'node /other/node_modules/.bin/expo start --port 8200'),
  proc(400, 200, '/bin/zsh', '/bin/zsh -c claude -p "run the check"'),
  proc(410, 400, '/Users/u/.local/bin/claude', 'claude -p review the vite config'),
  proc(420, 410, 'node', 'node /nested/node_modules/.bin/expo start --port 8300'),
];

test('finds the session above the hook process, and none outside a session', () => {
  assert.equal(findSessionPid(PROCS, 270), 200);
  assert.equal(findSessionPid(PROCS, 100), undefined);
});

test("lists this session's servers once and its emulator, never a shell wrapper or another session's", () => {
  assert.deepEqual(
    findOwnedProcesses(PROCS, 200)
      .map((p) => p.pid)
      .sort(),
    [220, 250, 280],
  );
  assert.deepEqual(
    findOwnedProcesses(PROCS, 300).map((p) => p.pid),
    [310],
  );
  assert.deepEqual(
    findOwnedProcesses(PROCS, 410).map((p) => p.pid),
    [420],
  );
});

test('a nested agent session whose prompt names a dev server is never listed as one', () => {
  assert.equal(
    findOwnedProcesses(PROCS, 200).some((p) => p.pid === 410),
    false,
  );
});

test('an owned process becomes a device with its port and kind', () => {
  const [metro, emulator] = [220, 250].map((pid) =>
    toOwnedDevice(PROCS.find((p) => p.pid === pid) as Proc),
  );
  assert.deepEqual(metro, {
    key: `220@${STARTED}`,
    kind: 'dev server',
    id: 'pid 220',
    port: '8100',
    startedAt: STARTED,
  });
  assert.equal(emulator?.kind, 'emulator');
  assert.equal(emulator?.port, '5654');
});

test('a simulator matches its control-app worktree slug exactly, never a prefix', () => {
  assert.equal(isSimulatorForWorktrees('control-app-retro_port', ['retro_port']), true);
  assert.equal(isSimulatorForWorktrees('control-app-retro-port', ['retro_port']), true);
  assert.equal(isSimulatorForWorktrees('control-app-retro-port-2', ['retro_port']), false);
  assert.equal(isSimulatorForWorktrees('control-app-feed-redesign', ['feed']), false);
  assert.equal(isSimulatorForWorktrees('iPhone 17 Pro', ['retro_port']), false);
});

const ROOT = '/repo/.claude/worktrees/aggressive-idle-reclaim';

test('a path is in a checkout only outside the worktrees nested under it', () => {
  assert.equal(isInCheckout(`${ROOT}/motion`, ROOT), true);
  assert.equal(isInCheckout(ROOT, ROOT), true);
  assert.equal(isInCheckout(`${ROOT}-2/motion`, ROOT), false);
  assert.equal(isInCheckout('/repo/.claude/worktrees/other/motion', '/repo'), false);
  assert.equal(isInCheckout('/repo/motion', '/repo'), true);
});

test('an orphaned dev server counts when its cwd is in the checkout, never an attached one, an agent or another checkout', () => {
  const procs = [
    proc(1001, 1, 'npm exec expo start --port 8100', 'npm exec expo start --port 8100'),
    proc(1002, 1, 'node', 'node /x/expo start --port 8101'),
    proc(1003, 500, 'node', 'node /x/expo start --port 8102'),
    proc(1004, 1, '/Users/u/.local/bin/claude', 'claude -p fix the vite config'),
  ];
  const cwds = new Map([
    [1001, `${ROOT}/motion`],
    [1002, '/repo/.claude/worktrees/other/motion'],
    [1003, `${ROOT}/motion`],
    [1004, ROOT],
  ]);
  assert.deepEqual(
    orphansInCheckout(procs, cwds, ROOT).map((p) => p.pid),
    [1001],
  );
});

test('reminds once per new device and never while a stop hook is already active', () => {
  const devices = [
    toOwnedDevice(PROCS[3] as Proc),
    { key: 'UDID-1', kind: 'simulator' as const, id: 'control-app-x UDID-1' },
  ];
  assert.equal(newDevices(devices, new Set(), false).length, 2);
  assert.deepEqual(
    newDevices(devices, new Set([`220@${STARTED}`]), false).map((d) => d.key),
    ['UDID-1'],
  );
  assert.deepEqual(newDevices(devices, new Set([`220@${STARTED}`, 'UDID-1']), false), []);
  assert.deepEqual(newDevices(devices, new Set(), true), []);
});

test('the reminder names each device, its port and age, and how to stop it', () => {
  const text = formatReminder(
    [toOwnedDevice(PROCS[3] as Proc), { key: 'U', kind: 'simulator', id: 'control-app-x U' }],
    NOW,
  );
  assert.match(
    text,
    /^This session still runs:\n- dev server pid 220, port 8100, 25m old\n- simulator control-app-x U\n/,
  );
  assert.match(text, /Room on the machine/);
  assert.match(text, /not be reminded about these again/);
});

test('parses lsof cwds and booted simulators, tolerating bad JSON', () => {
  assert.deepEqual(
    [...parseCwds('p220\nfcwd\nn/repo/.claude/worktrees/x\n')],
    [[220, '/repo/.claude/worktrees/x']],
  );
  const json = JSON.stringify({
    devices: {
      ios: [
        { udid: 'abc', name: 'control-app-x', state: 'Booted' },
        { udid: 'def', name: 'y', state: 'Shutdown' },
      ],
    },
  });
  assert.deepEqual(parseBootedSimulators(json), [{ udid: 'ABC', name: 'control-app-x' }]);
  assert.deepEqual(parseBootedSimulators('not json'), []);
});
