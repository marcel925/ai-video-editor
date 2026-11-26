#!/usr/bin/env node
/**
 * device-mute-on-boot: `PostToolUse` on Bash. After a command that may boot a simulator or emulator, starts
 * (or extends) a background sweep that mutes every booted device not yet muted, once it has booted, so no test
 * device plays through the owner's speakers (CLAUDE.md → "Test devices stay muted"). It reads no UDID from the
 * command, so `simctl boot "$UDID"` is covered. Never blocks; fails open and always exits 0.
 */
import { getIsDeviceBootCommand, getIsMainModule, requestSweep } from '../../tools/device-mute.mts';

async function readStdin(): Promise<string> {
    let text = '';
    for await (const chunk of process.stdin) text += String(chunk);
    return text;
}

async function main(): Promise<void> {
    const input = JSON.parse(await readStdin()) as { tool_input?: { command?: unknown } };
    const command = input.tool_input?.command;
    if (typeof command === 'string' && getIsDeviceBootCommand(command)) requestSweep();
}

if (getIsMainModule(import.meta.url)) {
    main()
        .catch(() => {})
        .finally(() => {
            process.exitCode = 0;
        });
}
