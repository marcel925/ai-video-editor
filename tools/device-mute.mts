#!/usr/bin/env node
/**
 * device-mute — make a test simulator or emulator silent while its playback keeps running, so a session's
 * device check never plays through the owner's speakers (owner, 2026-11-26). Never touches the Mac's own
 * volume or output device. Canonical: CLAUDE.md → "Test devices stay muted".
 *
 *   node tools/device-mute.mts ios <udid>... | android <serial>... | booted | sweep  [--detach]
 *
 * iOS: the simulated device has its own volume, moved only by its volume buttons, so this presses volume-down
 * (sim-volume-buttons.m) until the device reads 0 (sim-volume-read.m). SpringBoard ignores the buttons for up to
 * a minute after `bootstatus` returns, hence the retry. Android: every audio stream goes to its minimum via adb,
 * which sticks only as root. `sweep` mutes every booted device that is not muted yet, repeatedly for a few
 * minutes, so a device still booting is caught too; one sweep runs at a time and a new request extends it.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';


const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BUTTONS_SOURCE = join(SCRIPT_DIR, 'sim-volume-buttons.m');
const READER_SOURCE = join(SCRIPT_DIR, 'sim-volume-read.m');
export const CACHE_DIR = join(homedir(), 'Library/Caches/device-mute');
const SWEEP_LOCK = join(CACHE_DIR, 'sweep.lock');
/** Music, ring, alarm, notification, system and accessibility: everything an app, TTS or the OS plays. */
export const ANDROID_MUTED_STREAMS = [1, 2, 3, 4, 5, 10] as const;
/** iOS volume moves in sixteenths, so sixteen presses reach 0 from any level. */
export const IOS_VOLUME_DOWN_PRESSES = 16;
const BOOT_WAIT_TIMEOUT_MILLISECONDS = 15 * 60 * 1000;
const IOS_MUTE_ATTEMPTS = 20;
const RETRY_MILLISECONDS = 10_000;
const SWEEP_WINDOW_MILLISECONDS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MILLISECONDS = 60_000;

export interface StreamVolumeInterface {
    readonly current: number;
    readonly min: number;
    readonly max: number;
}

export interface MuteArgsInterface {
    readonly mode: 'android' | 'booted' | 'ios' | 'sweep';
    readonly ids: readonly string[];
    readonly isDetach: boolean;
}

/** `cmd media_session volume --get` prints `[V] volume is 6 in range [1..7]`; the minimum is not always 0. */
export function parseStreamVolume(output: string): StreamVolumeInterface | undefined {
    const match = /volume is (\d+) in range \[(\d+)\.\.(\d+)\]/.exec(output);
    if (!match) return undefined;
    return { current: Number(match[1]), min: Number(match[2]), max: Number(match[3]) };
}

export function getStreamVolumeArgs(serial: string, stream: number, value?: number): string[] {
    const action = value === undefined ? ['--get'] : ['--set', String(value)];
    return ['-s', serial, 'shell', 'cmd', 'media_session', 'volume', '--stream', String(stream), ...action];
}

/**
 * A command that may have booted a device. Deliberately loose: it only triggers a sweep, which mutes devices
 * that are already booted and not yet muted, so a false positive (a commit message naming `simctl boot`) does
 * nothing the owner did not ask for, and `simctl boot "$UDID"` matches although the hook never sees the UDID.
 */
export function getIsDeviceBootCommand(command: string): boolean {
    return /\bsimctl\s+boot\b|\bemulator\b[^\n]*\s-avd\b|\bemulator\s+@\w/.test(command);
}

export function parseMuteArgs(argv: readonly string[]): MuteArgsInterface | undefined {
    const [mode, ...rest] = argv;
    if (mode !== 'ios' && mode !== 'android' && mode !== 'booted' && mode !== 'sweep') return undefined;
    const ids = rest.filter((arg) => !arg.startsWith('--'));
    if ((mode === 'ios' || mode === 'android') && ids.length === 0) return undefined;
    return { mode, ids, isDetach: rest.includes('--detach') };
}

export function parseBootedSimulatorUdids(simctlJson: string): string[] {
    try {
        const devices = (JSON.parse(simctlJson) as { devices?: Record<string, { udid: string; state: string }[]> }).devices ?? {};
        const udids: string[] = [];
        for (const list of Object.values(devices)) for (const device of list) if (device.state === 'Booted') udids.push(device.udid);
        return udids;
    } catch {
        return [];
    }
}

export function parseEmulatorSerials(adbDevicesOutput: string): string[] {
    const serials: string[] = [];
    for (const line of adbDevicesOutput.split(/\r?\n/)) {
        const match = /^(emulator-\d+)\s+device\b/.exec(line);
        if (match?.[1]) serials.push(match[1]);
    }
    return serials;
}

/** `adb reverse --list` lines (`<serial> tcp:8081 tcp:8081`) as the `[remote, local]` pairs to re-create. */
export function parseReverseMappings(output: string): [string, string][] {
    const mappings: [string, string][] = [];
    for (const line of output.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3 && parts[1] && parts[2]) mappings.push([parts[1], parts[2]]);
    }
    return mappings;
}

export function getNativeToolPath(name: string, source: string): string {
    return join(CACHE_DIR, `${name}-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`);
}

/** `sim-volume-read` prints the device volume; anything unreadable counts as not muted yet. */
export function getIsMutedReading(output: string): boolean {
    const volume = Number.parseFloat(output.trim());
    return Number.isFinite(volume) && volume === 0;
}

export function getIsSweepCommand(psCommand: string): boolean {
    return /device-mute\.mts\s+sweep\b/.test(psCommand);
}

/** The sweep keeps going until this long after its lock was last touched, so each new boot request extends it. */
export function getSweepDeadline(lockTouchedAt: number): number {
    return lockTouchedAt + SWEEP_WINDOW_MILLISECONDS;
}

async function run(command: string, args: readonly string[], timeout = COMMAND_TIMEOUT_MILLISECONDS): Promise<string> {
    const { stdout } = await execFileAsync(command, [...args], { maxBuffer: 16 * 1024 * 1024, timeout });
    return String(stdout);
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const nativeBuilds = new Map<string, Promise<string>>();

/** Compiled once per source version into the cache (Xcode's clang is on every Mac that runs simulators); concurrent callers share one build. */
function getNativeTool(sourcePath: string, clangArgs: readonly string[]): Promise<string> {
    const toolPath = getNativeToolPath(basename(sourcePath, '.m'), readFileSync(sourcePath, 'utf8'));
    const pending = nativeBuilds.get(toolPath);
    if (pending) return pending;
    const build = (async () => {
        if (existsSync(toolPath)) return toolPath;
        mkdirSync(CACHE_DIR, { recursive: true });
        const partialPath = `${toolPath}.${process.pid}`;
        await run('xcrun', [...clangArgs, '-fobjc-arc', sourcePath, '-o', partialPath], BOOT_WAIT_TIMEOUT_MILLISECONDS);
        renameSync(partialPath, toolPath);
        return toolPath;
    })();
    nativeBuilds.set(toolPath, build);
    // A failed build is forgotten, so the next attempt compiles again.
    build.catch(() => nativeBuilds.delete(toolPath));
    return build;
}

function getSimulatorTools(): Promise<[string, string]> {
    return Promise.all([
        getNativeTool(BUTTONS_SOURCE, ['clang', '-framework', 'Foundation']),
        getNativeTool(READER_SOURCE, ['--sdk', 'iphonesimulator', 'clang', '-target', 'arm64-apple-ios17.0-simulator', '-framework', 'AVFoundation']),
    ]);
}

export async function muteSimulator(udid: string): Promise<string> {
    await run('xcrun', ['simctl', 'bootstatus', udid], BOOT_WAIT_TIMEOUT_MILLISECONDS);
    const developerDir = (await run('xcode-select', ['-p'])).trim();
    const [buttons, reader] = await getSimulatorTools();
    const getIsMuted = async () => getIsMutedReading(await run('xcrun', ['simctl', 'spawn', udid, reader]));
    if (await getIsMuted()) return `${udid} already muted`;
    for (let attempt = 1; attempt <= IOS_MUTE_ATTEMPTS; attempt++) {
        await run(buttons, [developerDir, udid, 'down', String(IOS_VOLUME_DOWN_PRESSES)]);
        if (await getIsMuted()) return `muted ${udid} (attempt ${attempt})`;
        await sleep(RETRY_MILLISECONDS);
    }
    throw new Error(`${udid} still not muted after ${IOS_MUTE_ATTEMPTS} attempts`);
}

async function getUnmutedStreams(serial: string): Promise<{ stream: number; min: number }[]> {
    const unmuted: { stream: number; min: number }[] = [];
    for (const stream of ANDROID_MUTED_STREAMS) {
        const volume = parseStreamVolume(await run('adb', getStreamVolumeArgs(serial, stream)));
        if (volume && volume.current !== volume.min) unmuted.push({ stream, min: volume.min });
    }
    return unmuted;
}

/** As the shell user `--set` is accepted and silently ignored (measured on an API 35 emulator); as root it sticks. */
/** Mappings taken before an `adb root` and not yet put back, kept across retries until they are. */
const pendingReverseMappings = new Map<string, [string, string][]>();

async function ensureAdbRoot(serial: string): Promise<void> {
    if ((await run('adb', ['-s', serial, 'shell', 'id', '-u'])).trim() !== '0') {
        // Restarting adbd as root drops `adb reverse` mappings, so a session's Metro link is put back.
        // No snapshot, no restart: an unreadable list would lose the mappings, so the sweep retries instead.
        pendingReverseMappings.set(serial, parseReverseMappings(await run('adb', ['-s', serial, 'reverse', '--list'])));
        await run('adb', ['-s', serial, 'root']);
    }
    const mappings = pendingReverseMappings.get(serial);
    if (!mappings) return;
    await run('adb', ['-s', serial, 'wait-for-device'], BOOT_WAIT_TIMEOUT_MILLISECONDS);
    for (const [remote, local] of mappings) await run('adb', ['-s', serial, 'reverse', remote, local]);
    pendingReverseMappings.delete(serial);
}

export async function muteEmulator(serial: string): Promise<string> {
    const waitForBoot = 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done';
    await run('adb', ['-s', serial, 'wait-for-device', 'shell', waitForBoot], BOOT_WAIT_TIMEOUT_MILLISECONDS);
    const unmuted = await getUnmutedStreams(serial);
    if (unmuted.length === 0) return `${serial} already muted`;
    await ensureAdbRoot(serial);
    for (const { stream, min } of unmuted) await run('adb', getStreamVolumeArgs(serial, stream, min));
    const stillUnmuted = await getUnmutedStreams(serial);
    if (stillUnmuted.length > 0) throw new Error(`${serial} streams ${stillUnmuted.map((s) => s.stream).join(', ')} did not take their minimum volume`);
    return `muted ${serial} streams ${unmuted.map((s) => s.stream).join(', ')}`;
}

/** Re-runs this script in the background with output in the cache log, so a hook or a boot step never waits on it. */
export function spawnDetachedMute(args: readonly string[]): void {
    mkdirSync(CACHE_DIR, { recursive: true });
    const log = openSync(join(CACHE_DIR, 'device-mute.log'), 'a');
    const scriptPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [scriptPath, ...args.filter((arg) => arg !== '--detach')], { detached: true, stdio: ['ignore', log, log] });
    child.unref();
}

function getLiveSweepPid(): number | undefined {
    try {
        const pid = Number(readFileSync(SWEEP_LOCK, 'utf8'));
        if (!Number.isInteger(pid) || pid <= 1) return undefined;
        // A recycled pid is some other process, so the lock counts only while a sweep holds it.
        const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
        return getIsSweepCommand(command) ? pid : undefined;
    } catch {
        return undefined;
    }
}

/** Starts a sweep, or extends the one already running so it also catches a device booting now. */
export function requestSweep(): void {
    if (getLiveSweepPid() !== undefined) {
        const now = new Date();
        utimesSync(SWEEP_LOCK, now, now);
        return;
    }
    spawnDetachedMute(['sweep']);
}

async function getBootedDevices(): Promise<{ simulators: string[]; emulators: string[] }> {
    const [simctl, adb] = await Promise.all([run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']).catch(() => ''), run('adb', ['devices']).catch(() => '')]);
    return { simulators: parseBootedSimulatorUdids(simctl), emulators: parseEmulatorSerials(adb) };
}

function log(line: string): void {
    process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

/** Takes the lock atomically; false when another live sweep holds it, which then covers this request. */
function getIsSweepLockAcquired(): boolean {
    mkdirSync(CACHE_DIR, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            writeFileSync(SWEEP_LOCK, String(process.pid), { flag: 'wx' });
            return true;
        } catch {
            if (getLiveSweepPid() !== undefined) return false;
            rmSync(SWEEP_LOCK, { force: true });
        }
    }
    return false;
}

function releaseSweepLock(): void {
    try {
        if (readFileSync(SWEEP_LOCK, 'utf8') === String(process.pid)) rmSync(SWEEP_LOCK, { force: true });
    } catch {
        // Already gone.
    }
}

async function runSweep(): Promise<number> {
    if (!getIsSweepLockAcquired()) {
        // Another sweep holds the lock: extend it to cover this request.
        const now = new Date();
        try {
            utimesSync(SWEEP_LOCK, now, now);
        } catch {
            // It finished in between; the next boot request starts a fresh one.
        }
        return 0;
    }
    const settled = new Set<string>();
    const inFlight = new Map<string, Promise<void>>();
    const track = (id: string, job: () => Promise<string>) => {
        if (settled.has(id) || inFlight.has(id)) return;
        inFlight.set(
            id,
            job()
                .then(
                    (line) => {
                        log(line);
                        settled.add(id);
                    },
                    // Not settled, so the next round tries this device again.
                    (error: unknown) => log(`device-mute failed for ${id}, retrying: ${String(error)}`),
                )
                .finally(() => inFlight.delete(id)),
        );
    };
    try {
        await sweepUntilIdle(settled, inFlight, track);
    } finally {
        releaseSweepLock();
    }
    return 0;
}

async function sweepUntilIdle(
    settled: Set<string>,
    inFlight: ReadonlyMap<string, Promise<void>>,
    track: (id: string, job: () => Promise<string>) => void,
): Promise<void> {
    let lockTouchedAt = Date.now();
    for (;;) {
        try {
            lockTouchedAt = statSync(SWEEP_LOCK).mtimeMs;
        } catch {
            // The lock vanished; finish on the last deadline seen.
        }
        const isOpen = Date.now() < getSweepDeadline(lockTouchedAt);
        if (!isOpen && inFlight.size === 0) return;
        if (!isOpen) {
            // Past the deadline only the jobs already running finish; nothing new starts.
            await Promise.race(inFlight.values());
            continue;
        }
        const booted = await getBootedDevices();
        // A device shut down and booted again comes back at full volume, so it is muted afresh.
        const live = new Set([...booted.simulators, ...booted.emulators]);
        for (const id of settled) if (!live.has(id)) settled.delete(id);
        for (const udid of booted.simulators) track(udid, () => muteSimulator(udid));
        for (const serial of booted.emulators) track(serial, () => muteEmulator(serial));
        await sleep(RETRY_MILLISECONDS);
    }
}

async function main(): Promise<number> {
    const argv = process.argv.slice(2);
    const args = parseMuteArgs(argv);
    if (!args) {
        process.stderr.write('usage: device-mute.mts ios <udid>... | android <serial>... | booted | sweep  [--detach]\n');
        return 2;
    }
    if (args.isDetach) {
        spawnDetachedMute(argv);
        return 0;
    }
    if (args.mode === 'sweep') return runSweep();
    const booted = args.mode === 'booted' ? await getBootedDevices() : undefined;
    const simulators = booted?.simulators ?? (args.mode === 'ios' ? args.ids : []);
    const emulators = booted?.emulators ?? (args.mode === 'android' ? args.ids : []);
    const results = await Promise.allSettled([...simulators.map((udid) => muteSimulator(udid)), ...emulators.map((serial) => muteEmulator(serial))]);
    let exitCode = 0;
    for (const result of results) {
        if (result.status === 'fulfilled') log(result.value);
        else {
            exitCode = 1;
            log(`device-mute failed: ${String(result.reason)}`);
        }
    }
    return exitCode;
}

/** True when this file is the entry point, also when it is run through a symlink. */
export function getIsMainModule(moduleUrl: string): boolean {
    const entry = process.argv[1];
    if (!entry) return false;
    try {
        return moduleUrl === pathToFileURL(realpathSync(entry)).href;
    } catch {
        return false;
    }
}

if (getIsMainModule(import.meta.url)) {
    main().then(
        (code) => {
            process.exitCode = code;
        },
        (error: unknown) => {
            process.stderr.write(`device-mute: ${String(error)}\n`);
            process.exitCode = 1;
        },
    );
}
