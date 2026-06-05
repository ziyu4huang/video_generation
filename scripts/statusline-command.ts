#!/usr/bin/env bun
/**
 * statusline-command.ts — Claude Code status line renderer
 *
 * Reads JSON from stdin (piped by Claude Code) and outputs a formatted status line.
 * Output format: Model | folder | Ctx: 5.2% | Tokens: 12345
 *
 * Install: bun run ~/.claude/statusline-command.ts
 * Configure in settings.json:
 *   { "statusLine": { "type": "command", "command": "bun run ~/.claude/statusline-command.ts" } }
 */

async function main() {
  const input = await new Response(process.stdin).text();
  let data: any;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(1);
  }

  const parts: string[] = [];

  const model = data?.model?.display_name;
  if (model) parts.push(model);

  const dir = data?.workspace?.current_dir;
  if (dir) {
    const folder = dir.split("/").pop() || dir;
    parts.push(folder);
  }

  const used = data?.context_window?.used_percentage ?? 0;
  parts.push(`Ctx: ${used}%`);

  const totalInput = data?.context_window?.total_input_tokens ?? 0;
  const totalOutput = data?.context_window?.total_output_tokens ?? 0;
  parts.push(`Tokens: ${totalInput + totalOutput}`);

  if (parts.length > 0) {
    process.stdout.write(parts.join(" | "));
  }
}

main();
