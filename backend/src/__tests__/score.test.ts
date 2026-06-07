import { describe, it, expect } from "vitest";
import { computeScore } from "../services/score.js";
import type { Finding } from "../types.js";

const f = (severity: Finding["severity"]): Finding => ({
  severity,
  check: "test",
  detail: "test detail",
});

describe("computeScore", () => {
  it("returns 100 with no findings", () => {
    expect(computeScore([])).toBe(100);
  });

  it("returns 100 for all PASS findings", () => {
    expect(computeScore([f("PASS"), f("PASS"), f("PASS")])).toBe(100);
  });

  it("deducts 40 for one CRITICAL", () => {
    expect(computeScore([f("CRITICAL")])).toBe(60);
  });

  it("deducts 20 for one HIGH", () => {
    expect(computeScore([f("HIGH")])).toBe(80);
  });

  it("deducts 10 for one MEDIUM", () => {
    expect(computeScore([f("MEDIUM")])).toBe(90);
  });

  it("deducts 5 for one LOW", () => {
    expect(computeScore([f("LOW")])).toBe(95);
  });

  it("accumulates deductions across multiple findings", () => {
    // CRITICAL(40) + HIGH(20) + MEDIUM(10) + LOW(5) = 75 deducted → 25
    expect(computeScore([f("CRITICAL"), f("HIGH"), f("MEDIUM"), f("LOW")])).toBe(25);
  });

  it("floors at 0 with catastrophic findings", () => {
    // 3 × CRITICAL = 120 deducted → floor 0
    expect(computeScore([f("CRITICAL"), f("CRITICAL"), f("CRITICAL")])).toBe(0);
  });

  it("floors at 0 with mixed severe findings", () => {
    expect(computeScore([f("CRITICAL"), f("CRITICAL"), f("HIGH"), f("HIGH")])).toBe(0);
  });

  it("handles mixed PASS and real findings correctly", () => {
    // PASS(0) + HIGH(20) = 20 deducted → 80
    expect(computeScore([f("PASS"), f("HIGH"), f("PASS")])).toBe(80);
  });

  it("two CRITICALs = score 20", () => {
    expect(computeScore([f("CRITICAL"), f("CRITICAL")])).toBe(20);
  });

  it("one CRITICAL + one MEDIUM = score 50", () => {
    expect(computeScore([f("CRITICAL"), f("MEDIUM")])).toBe(50);
  });
});
