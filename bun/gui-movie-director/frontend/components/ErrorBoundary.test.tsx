import { describe, it, expect, jest } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { ErrorBoundary } from "./ErrorBoundary";

// A component that throws during render
function BuggyComponent({ shouldThrow = false }: { shouldThrow?: boolean }) {
  if (shouldThrow) throw new Error("Test error");
  return <div>All good</div>;
}

describe("ErrorBoundary", () => {
  it("renders children when no error", () => {
    const { container } = render(
      <ErrorBoundary>
        <div>Hello</div>
      </ErrorBoundary>
    );
    expect(container.textContent).toContain("Hello");
    cleanup();
  });

  it("catches errors and shows fallback UI", () => {
    const origError = console.error;
    console.error = () => {};

    const { container } = render(
      <ErrorBoundary>
        <BuggyComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(container.textContent).toContain("Something went wrong");
    expect(container.textContent).toContain("Test error");
    expect(container.textContent).toContain("Reload App");
    expect(container.textContent).toContain("Try Again");

    console.error = origError;
    cleanup();
  });

  it("renders custom fallback when provided", () => {
    const origError = console.error;
    console.error = () => {};

    const { container } = render(
      <ErrorBoundary fallback={<div>Custom error UI</div>}>
        <BuggyComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(container.textContent).toContain("Custom error UI");

    console.error = origError;
    cleanup();
  });
});
