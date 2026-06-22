import { describe, it, expect, mock } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { GalleryCard } from "./GalleryCard";
import type { GalleryImage } from "../types";

const baseImg: GalleryImage = {
  name: "test.png",
  url: "/output/0/test.png",
  size: 12345,
  createdAt: "2026-06-22T00:00:00Z",
  mediaType: "image",
  manifest: null,
  run: null,
};

describe("GalleryCard compare mode", () => {
  it("clicking in compare mode toggles selection, not the preview", () => {
    const onToggleCompare = mock(() => {});
    const onClick = mock(() => {});
    const { container } = render(
      <GalleryCard img={baseImg} compareMode onClick={onClick} onToggleCompare={onToggleCompare} />,
    );
    const card = container.querySelector("[data-image-name]") as HTMLElement;
    expect(card).toBeTruthy();
    fireEvent.click(card);
    expect(onToggleCompare).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    cleanup();
  });

  it("clicking outside compare mode opens the preview", () => {
    const onToggleCompare = mock(() => {});
    const onClick = mock(() => {});
    const { container } = render(
      <GalleryCard img={baseImg} onClick={onClick} onToggleCompare={onToggleCompare} />,
    );
    const card = container.querySelector("[data-image-name]") as HTMLElement;
    fireEvent.click(card);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onToggleCompare).not.toHaveBeenCalled();
    cleanup();
  });

  it("renders a selection badge when selected", () => {
    const { container } = render(<GalleryCard img={baseImg} compareMode selected />);
    expect(container.textContent).toContain("✓");
    cleanup();
  });

  it("does not render a selection badge when not selected", () => {
    const { container } = render(<GalleryCard img={baseImg} compareMode selected={false} />);
    expect(container.textContent).not.toContain("✓");
    cleanup();
  });
});
