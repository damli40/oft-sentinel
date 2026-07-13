// Print grep patterns from corridor-invariants.json:
//   - 0x addresses found ANYWHERE in the JSON (never stoplisted)
//   - ticker-like tokens (3-10 upper-alnum) tokenized out of IDENTITY fields only
//     (name/ticker/symbol/asset/token keys) — prose fields like `why` carry caps
//     emphasis words (LOCAL, ONLY, ...) that must not become commit blockers
//   - tokens are filtered against the committed stoplist of engine vocabulary
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const IDENTITY_KEY = /^(name|ticker|symbol|asset|token)s?$/i;
const stopFile = join(dirname(fileURLToPath(import.meta.url)), "ticker-stoplist.txt");
let stop = new Set();
try {
  stop = new Set(
    readFileSync(stopFile, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
} catch {} // missing stoplist = no filtering, never a crash

const out = new Set();
const walk = (v, key) => {
  if (v == null) return;
  if (typeof v === "string") {
    for (const m of v.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0]);
    if (typeof key === "string" && IDENTITY_KEY.test(key)) {
      for (const m of v.matchAll(/\b[A-Z][A-Z0-9]{2,9}\b/g)) {
        if (!stop.has(m[0])) out.add(`\\b${m[0]}\\b`);
      }
    }
  } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
  else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
};
walk(JSON.parse(readFileSync(process.argv[2], "utf8")), null);
for (const p of out) console.log(p);
