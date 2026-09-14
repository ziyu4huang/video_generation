/**
 * Parent-visible child-output cap — upstream `PER_TASK_OUTPUT_CAP` parity
 * (earendil-works/pi `examples/extensions/subagent/index.ts`). A child's
 * output enters the parent LLM's context capped at CHILD_OUTPUT_CAP; the full
 * text survives in tool `details` (singular tool, `SubagentToolDetails.output`)
 * and in the durable run record (both tools already persist it —
 * `persistence.save({ output })`).
 *
 * Unit: JS string length (UTF-16 code units), matching how the rendered text
 * is measured downstream. Byte-accurate sizing is not a goal — the cap is
 * context economics, not storage.
 */

export const CHILD_OUTPUT_CAP = 50 * 1024;

/** Marker line appended to capped bodies; names where the full text lives.
 *  String literal is a deploy-bundle grep target (PB-09). */
export const OUTPUT_CAP_MARKER = `[output capped at ${CHILD_OUTPUT_CAP} bytes for the parent context — full output preserved in tool details and list_subagent_runs]`;

export interface CappedOutput {
  text: string;
  capped: boolean;
}

/** Cap a child's output for the parent-visible path. At exactly the cap the
 *  text passes uncapped (only strictly-larger bodies are truncated). */
export function capChildOutput(output: string): CappedOutput {
  if (output.length <= CHILD_OUTPUT_CAP) return { text: output, capped: false };
  return { text: `${output.slice(0, CHILD_OUTPUT_CAP)}\n${OUTPUT_CAP_MARKER}`, capped: true };
}
