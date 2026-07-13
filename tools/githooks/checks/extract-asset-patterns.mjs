// Walk corridor-invariants.json (schema-agnostic) and print grep patterns:
// ticker-like strings (2-10 upper-alnum) and 0x addresses found anywhere.
import { readFileSync } from "node:fs";
const out = new Set();
const walk = (v) => {
  if (v == null) return;
  if (typeof v === "string") {
    for (const m of v.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0]);
    if (/^[A-Z][A-Z0-9]{1,9}$/.test(v)) out.add(`\\b${v}\\b`);
  } else if (Array.isArray(v)) v.forEach(walk);
  else if (typeof v === "object") { Object.keys(v).forEach(walk); Object.values(v).forEach(walk); }
};
walk(JSON.parse(readFileSync(process.argv[2], "utf8")));
for (const p of out) console.log(p);
