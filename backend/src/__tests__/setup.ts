/**
 * Global test setup. One job: make the suite hermetic.
 *
 * `readSnapshot`'s last-resort fallback is Etherscan's eth_call proxy, and it
 * fires whenever every RPC in the list fails a read on a chain flagged
 * `etherscanFree`. Several fixtures produce exactly that shape on purpose
 * (a handler that models some selectors and answers "0x" to the rest), so with
 * ETHERSCAN_API_KEY present in the ambient environment the suite made LIVE
 * `fetch` calls to api.etherscan.io — each one serialized behind a real 400ms
 * spacer.
 *
 * Two things were wrong with that, beyond the ~3s it cost:
 *
 *  1. "323 tests passing" meant something different on a machine with the key
 *     set than on one without it. The reads the fallback served were the reads a
 *     keyless machine saw fail, so the two runs exercised different code and
 *     asserted over different snapshots. A green run is only evidence if it is
 *     the same run everywhere.
 *  2. A security monitor's test suite must not depend on a third party being up,
 *     rate-limiting us favourably, or returning what it returned last week.
 *
 * Unsetting the key here makes `etherscanCall` reject immediately — the same
 * outcome a keyless machine already had, now the outcome EVERY machine has. The
 * fallback path itself is not thereby left uncovered: it is pinned directly in
 * read-snapshot.test.ts ("Etherscan eth_call fallback"), which stubs both the
 * key and `fetch` so the path runs end to end against an in-process double.
 *
 * A test that wants the key back can `vi.stubEnv("ETHERSCAN_API_KEY", …)`; it
 * must stub `fetch` too, or it is reintroducing exactly this problem.
 */
delete process.env.ETHERSCAN_API_KEY;
