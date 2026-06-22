import { describe, it, expect, afterEach } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startDiscordTestEmulator, type RunningDiscordEmulator } from "../helpers.js";

/**
 * Second client oracle: drive a real discord.py Client through login -> READY (zlib-stream gateway)
 * -> REST round-trips against the emulator. Skips automatically when Python/discord.py aren't
 * installed, so it never blocks a JS-only environment; CI enables it by `pip install discord.py`.
 */

function discordPyAvailable(): boolean {
  const probe = spawnSync("python3", ["-c", "import discord"], { stdio: "ignore" });
  return probe.status === 0;
}

const FLOW = fileURLToPath(new URL("./discordpy_flow.py", import.meta.url));

describe("discord.py integration", () => {
  let emu: RunningDiscordEmulator | undefined;
  afterEach(async () => {
    await emu?.close();
    emu = undefined;
  });

  it.runIf(discordPyAvailable())(
    "logs in, reaches READY over zlib-stream, and round-trips REST objects",
    async () => {
      emu = await startDiscordTestEmulator();
      const out = await new Promise<{ code: number | null; output: string }>((resolve) => {
        const proc = spawn("python3", [FLOW], {
          env: { ...process.env, EMU_BASE: emu!.baseUrl, EMU_TOKEN: "test_bot_token" },
        });
        let output = "";
        proc.stdout.on("data", (d) => (output += d.toString()));
        proc.stderr.on("data", (d) => (output += d.toString()));
        proc.on("close", (code) => resolve({ code, output }));
      });

      expect(out.output, out.output).toContain("DISCORDPY_OK");
      expect(out.code).toBe(0);
    },
    30000,
  );
});
