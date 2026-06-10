import type { Finding } from "../types.js";

const DEDUCTIONS: Record<string, number> = {
  CRITICAL: 40,
  HIGH: 20,
  MEDIUM: 10,
  LOW: 5,
  PASS: 0,
  UNKNOWN: 0,
};

export function computeScore(findings: Finding[]): number {
  const total = findings.reduce((acc, f) => acc - (DEDUCTIONS[f.severity] ?? 0), 100);
  return Math.max(0, total);
}
