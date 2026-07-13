// Print grep patterns from corridor-invariants.json:
//   - 0x addresses found ANYWHERE in the JSON (never stoplisted)
//   - ticker-like tokens (3-10 upper-alnum) tokenized out of IDENTITY fields only:
//     * `name` fields are prose sentences ("TICK src→dst — prose with CAPS") whose
//       leading token is the ticker; take ONLY that leading token so prose emphasis
//       words (DELIVERS, ANYWAY, ...) never become commit blockers
//     * ticker/symbol/asset/token fields are bare identifiers — tokenize fully
//   - tokens are filtered against the committed stoplist of engine vocabulary
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME_KEY = /^names?$/i;
const IDENTITY_KEY = /^(ticker|symbol|asset|token)s?$/i;
const TICKER = /\b[A-Z][A-Z0-9]{2,9}\b/g;
const LEADING_TICKER = /^[A-Z][A-Z0-9]{2,9}\b/;
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

const addTicker = (tok) => {
  if (tok && !stop.has(tok)) out.add(`\\b${tok}\\b`);
};
const out = new Set();
const walk = (v, key) => {
  if (v == null) return;
  if (typeof v === "string") {
    for (const m of v.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0]);
    if (typeof key === "string") {
      if (NAME_KEY.test(key)) {
        const m = v.match(LEADING_TICKER); // prose sentence: leading token only
        if (m) addTicker(m[0]);
      } else if (IDENTITY_KEY.test(key)) {
        for (const m of v.matchAll(TICKER)) addTicker(m[0]); // bare identifier: full
      }
    }
  } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
  else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
};
walk(JSON.parse(readFileSync(process.argv[2], "utf8")), null);
for (const p of out) console.log(p);
