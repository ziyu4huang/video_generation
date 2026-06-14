import { describe, it, expect } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { SkeletonCard, SkeletonRow, SkeletonFormSection } from "./Skeleton";

describe("SkeletonCard", () => {
  it("renders without crashing", () => {
    const { container } = render(<SkeletonCard />);
    expect(container.querySelector('[data-testid="skeleton-card"]')).toBeTruthy();
    cleanup();
  });
});

describe("SkeletonRow", () => {
  it("renders without crashing", () => {
    const { container } = render(<SkeletonRow />);
    expect(container.querySelector('[data-testid="skeleton-row"]')).toBeTruthy();
    cleanup();
  });
});

describe("SkeletonFormSection", () => {
  it("renders without crashing", () => {
    const { container } = render(<SkeletonFormSection />);
    expect(container.querySelector('[data-testid="skeleton-form-section"]')).toBeTruthy();
    cleanup();
  });
});
