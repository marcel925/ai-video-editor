import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    getIsDeviceBootCommand,
    getIsMutedReading,
    getNativeToolPath,
    getStreamVolumeArgs,
    parseBootedSimulatorUdids,
    parseEmulatorSerials,
    parseMuteArgs,
    parseReverseMappings,
    parseReverseSnapshot,
    parseStreamVolume,
} from './device-mute.mts';

const UDID = '464850D7-E93A-4F43-837C-6C701498A381';

test('a stream volume reading keeps its own minimum, which is 1 for alarm and accessibility', () => {
    assert.deepEqual(parseStreamVolume('[V] volume is 6 in range [1..7]'), { current: 6, min: 1, max: 7 });
    assert.deepEqual(parseStreamVolume('[V] volume is 0 in range [0..15]\n'), { current: 0, min: 0, max: 15 });
    assert.equal(parseStreamVolume('Error: unknown stream'), undefined);
});

test('stream volume commands target one serial and one stream', () => {
    assert.deepEqual(getStreamVolumeArgs('emulator-5680', 4), ['-s', 'emulator-5680', 'shell', 'cmd', 'media_session', 'volume', '--stream', '4', '--get']);
    assert.deepEqual(getStreamVolumeArgs('emulator-5680', 3, 0).slice(-3), ['3', '--set', '0']);
});

test('simulator boots, including by variable, and emulator launches trigger a sweep', () => {
    assert.equal(getIsDeviceBootCommand(`xcrun simctl boot ${UDID} && xcrun simctl bootstatus ${UDID} -b`), true);
    assert.equal(getIsDeviceBootCommand('UDID=$(xcrun simctl create x "iPhone 17 Pro"); xcrun simctl boot "$UDID"'), true);
    assert.equal(getIsDeviceBootCommand("bash -c '~/Library/Android/sdk/emulator/emulator -avd test_api35 -read-only -port 5680 -no-audio &'"), true);
    assert.equal(getIsDeviceBootCommand('~/Library/Android/sdk/emulator/emulator @Pixel_API_36 -no-window'), true);
});

test('commands that only list, stop or kill devices trigger nothing', () => {
    assert.equal(getIsDeviceBootCommand(`xcrun simctl shutdown ${UDID}; xcrun simctl list devices booted`), false);
    assert.equal(getIsDeviceBootCommand('emulator -list-avds; adb -s emulator-5680 emu kill'), false);
});

test('mute arguments need a mode and, for ios or android, at least one id', () => {
    assert.deepEqual(parseMuteArgs(['ios', UDID]), { mode: 'ios', ids: [UDID], isDetach: false });
    assert.deepEqual(parseMuteArgs(['sweep', '--detach']), { mode: 'sweep', ids: [], isDetach: true });
    assert.deepEqual(parseMuteArgs(['booted']), { mode: 'booted', ids: [], isDetach: false });
    assert.equal(parseMuteArgs(['android']), undefined);
    assert.equal(parseMuteArgs(['tvos', UDID]), undefined);
});

test('booted simulators and running emulators are read from simctl and adb output', () => {
    const simctl = JSON.stringify({ devices: { 'iOS-26-5': [{ udid: UDID, state: 'Booted' }, { udid: 'X', state: 'Shutdown' }] } });
    assert.deepEqual(parseBootedSimulatorUdids(simctl), [UDID]);
    assert.deepEqual(parseBootedSimulatorUdids('not json'), []);
    assert.deepEqual(parseEmulatorSerials('List of devices attached\nemulator-5646\tdevice\nemulator-5650\toffline\nR58M\tdevice\n'), ['emulator-5646']);
});

test('adb reverse mappings survive the adbd restart that adb root causes', () => {
    assert.deepEqual(parseReverseMappings('emulator-5680 tcp:8123 tcp:8123\nemulator-5680 tcp:9090 tcp:9091\n'), [
        ['tcp:8123', 'tcp:8123'],
        ['tcp:9090', 'tcp:9091'],
    ]);
    assert.deepEqual(parseReverseMappings(''), []);
});

test('each native tool is cached per name and source version', () => {
    assert.equal(getNativeToolPath('reader', 'a'), getNativeToolPath('reader', 'a'));
    assert.notEqual(getNativeToolPath('reader', 'a'), getNativeToolPath('reader', 'b'));
    assert.notEqual(getNativeToolPath('reader', 'a'), getNativeToolPath('buttons', 'a'));
});

test('only a clean zero reading counts as muted', () => {
    assert.equal(getIsMutedReading('0.000\n'), true);
    assert.equal(getIsMutedReading('0.600\n'), false);
    assert.equal(getIsMutedReading(''), false);
});



test('a saved reverse snapshot reads back as pairs, dropping malformed entries', () => {
    assert.deepEqual(parseReverseSnapshot('[["tcp:8177","tcp:8177"],["tcp:1"],[2,3]]'), [['tcp:8177', 'tcp:8177']]);
    assert.deepEqual(parseReverseSnapshot('{}'), []);
    assert.deepEqual(parseReverseSnapshot(''), []);
    assert.deepEqual(parseReverseSnapshot('[["tcp:8'), []);
});
