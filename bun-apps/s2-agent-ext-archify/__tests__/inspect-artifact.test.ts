import { describe, test, expect } from "bun:test";
import { inspectArtifact } from "../lib/inspect-artifact.ts";

describe("inspectArtifact", () => {
  const SAMPLE = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="generator" content="archify 2.12.0">
  <title>Production Deployment</title>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono" rel="stylesheet">
  <link href="https://tt-a1i.github.io/archify/start.html?type=architecture" rel="help">
</head>
<body>
  <script>console.log("inline");</script>
  <script src="https://evil.example.com/bundle.js"></script>
  <svg viewBox="0 0 1436 760" role="img">
    <g data-kind="frontend"><text>Customers</text></g>
    <g data-kind="backend"><text>API <tspan>Gateway</tspan></text></g>
    <g data-kind="database"><text>DB</text></g>
    <g data-kind="frontend"><text>Edge</text></g>
  </svg>
  <a href="https://tt-a1i.github.io/archify/start.html">Start</a>
  <img src="https://evil.example.com/logo.png">
</body>
</html>`;

  test("extracts document basics", () => {
    const f = inspectArtifact(SAMPLE);
    expect(f.hasDoctype).toBe(true);
    expect(f.hasSvg).toBe(true);
    expect(f.svgViewBox).toBe("0 0 1436 760");
    expect(f.title).toBe("Production Deployment");
    expect(f.generator).toBe("archify 2.12.0");
    expect(f.bytes).toBe(SAMPLE.length);
  });

  test("counts data-kind nodes and dedups kinds", () => {
    const f = inspectArtifact(SAMPLE);
    expect(f.dataKindAttrCount).toBe(4); // 4 groups carry data-kind (frontend x2)
    expect(f.dataKinds.sort()).toEqual(["backend", "database", "frontend"]);
  });

  test("extracts text labels, stripping nested tags", () => {
    const f = inspectArtifact(SAMPLE);
    expect(f.textLabels).toContain("Customers");
    expect(f.textLabels).toContain("API Gateway"); // <tspan> stripped
    expect(f.textLabels).toContain("DB");
    expect(f.textLabels).toContain("Edge");
  });

  test("classifies external refs: optional allowlist vs required", () => {
    const f = inspectArtifact(SAMPLE);
    // optional (non-blocking): google fonts, gstatic, archify help
    const optionalUrls = f.externalRefs.filter((r) => !r.blocking).map((r) => r.url);
    expect(optionalUrls.some((u) => u.includes("fonts.googleapis.com"))).toBe(true);
    expect(optionalUrls.some((u) => u.includes("fonts.gstatic.com"))).toBe(true);
    expect(optionalUrls.some((u) => u.includes("tt-a1i.github.io"))).toBe(true);
    // required (blocking): external script + external img
    const requiredUrls = f.requiredExternalRefs.map((r) => r.url);
    expect(requiredUrls).toContain("https://evil.example.com/bundle.js");
    expect(requiredUrls.some((u) => u.endsWith("logo.png"))).toBe(true);
  });

  test("counts inline vs external scripts", () => {
    const f = inspectArtifact(SAMPLE);
    expect(f.inlineScripts).toBe(1);
    expect(f.externalScripts).toBe(1);
  });

  test("isOptional host matching is boundary-anchored (no bypass via suffix-domain)", () => {
    // attacker-controlled suffix domain must NOT be classified optional
    const evil = `<!doctype html><html><head><title>X</title></head>
      <body><svg viewBox="0 0 10 10"><g data-kind="a"><text>A</text></g></svg>
      <script src="https://tt-a1i.github.io.evil.com/x.js"></script>
      <img src="https://fonts.googleapis.com.evil.attacker/x.png">
      <a href="https://evil.com#https://fonts.gstatic.com">link</a></body></html>`;
    const f = inspectArtifact(evil);
    const requiredUrls = f.requiredExternalRefs.map((r) => r.url);
    expect(requiredUrls).toContain("https://tt-a1i.github.io.evil.com/x.js");
    expect(requiredUrls.some((u) => u.endsWith("x.png"))).toBe(true);
    expect(requiredUrls.some((u) => u.startsWith("https://evil.com"))).toBe(true);
    expect(f.requiredExternalRefs.length).toBe(3);
    // genuine allowlisted hosts (and subdomains) still classified optional
    const clean = `<!doctype html><html><head><title>X</title></head>
      <body><svg viewBox="0 0 10 10"><g data-kind="a"><text>A</text></g></svg>
      <a href="https://tt-a1i.github.io/archify/start.html">help</a>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=x">
      <link rel="preconnect" href="https://fonts.gstatic.com"></body></html>`;
    const c = inspectArtifact(clean);
    expect(c.requiredExternalRefs).toEqual([]);
  });

  test("returns empty requiredExternalRefs for a clean offline artifact", () => {
    const clean = `<!doctype html><html><head><title>X</title></head>
      <body><svg viewBox="0 0 10 10"><g data-kind="a"><text>A</text></g></svg>
      <link rel="preconnect" href="https://fonts.gstatic.com"></body></html>`;
    const f = inspectArtifact(clean);
    expect(f.requiredExternalRefs).toEqual([]);
    expect(f.dataKindAttrCount).toBe(1);
  });
});
