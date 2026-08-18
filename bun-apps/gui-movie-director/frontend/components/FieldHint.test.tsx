import { describe, it, expect } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { SelectField, ToggleField } from "./FieldComponents";

/**
 * The hint has to reach the SCREEN, not just the props.
 *
 * It never did: `toForm.fieldToUi` dropped the property on the way from the
 * schema to the UI shape, so CommandForm's `field.hint?.(...)` was always
 * undefined — and ToggleField had no hint slot at all, which is why two
 * schemas' `help:` text had nowhere to go even in principle. schemas/
 * toForm.test.ts pins the transport; these pin the render, so neither half can
 * regress while the other still looks correct.
 */
describe("field hints are rendered", () => {
  it("SelectField shows its hint", () => {
    const { container } = render(
      <SelectField label="Resolution" value="same" onChange={() => {}} options={[{ value: "same", label: "Same" }]} hint="→ 1024×1024" />,
    );
    expect(container.querySelector(".field-hint")?.textContent).toBe("→ 1024×1024");
    cleanup();
  });

  it("ToggleField shows its hint — the slot two schemas' help text had no way to reach", () => {
    const { container } = render(
      <ToggleField label="VLM Scoring" checked={false} onChange={() => {}} hint="Also score using Qwen3-VL (requires LM Studio)" />,
    );
    expect(container.querySelector(".field-hint")?.textContent).toBe("Also score using Qwen3-VL (requires LM Studio)");
    cleanup();
  });

  it("no hint renders no hint element (an empty span would shift layout)", () => {
    const { container } = render(<ToggleField label="Dry Run" checked={false} onChange={() => {}} />);
    expect(container.querySelector(".field-hint")).toBeNull();
    cleanup();
  });
});
