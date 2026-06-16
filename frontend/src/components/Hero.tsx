import type { MantleOft } from "../api.ts";

function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export function Hero({ ofts, onOpenStory }: { ofts: MantleOft[] | null; onOpenStory: () => void }) {
  const ready = ofts !== null;
  const totalVol = ofts?.reduce((s, o) => s + o.usdVolume, 0) ?? 0;
  const totalMsgs = ofts?.reduce((s, o) => s + o.messages, 0) ?? 0;
  const projects = ofts ? new Set(ofts.map((o) => o.project)).size : 0;

  const stats = [
    { v: ready ? formatUsd(totalVol) : "-", l: "secured" },
    { v: ready ? String(ofts!.length) : "-", l: "OFTs" },
    { v: ready ? String(projects) : "-", l: "projects" },
    { v: ready ? totalMsgs.toLocaleString() : "-", l: "messages" },
  ];

  return (
    <section className="flex flex-col items-center text-center gap-5">
      <span className="text-2xs font-mono text-lz-mint uppercase tracking-eyebrow">
        Autonomous OFT security · Mantle
      </span>

      <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.06] max-w-2xl">
        Configurable trust,<br />
        continuously <span className="text-lz-mint">proven</span>.
      </h1>

      <p className="text-lz-muted max-w-xl leading-relaxed">
        LayerZero lets every token pick its own verifiers and thresholds, the most flexible
        security model in crypto. Sentinel reads that config live on Mantle and proves it
        stays safe, every five minutes.
      </p>

      <button
        onClick={onOpenStory}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-lz-text border border-lz-border hover:border-lz-mint rounded-lg px-4 py-2 transition-colors"
      >
        See how it works
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 3.5l4 4M9 3.5v4h-4" />
        </svg>
      </button>

      <dl className="flex flex-wrap justify-center gap-x-9 gap-y-4 mt-3 pt-6 border-t border-lz-border-soft w-full max-w-xl">
        {stats.map((s) => (
          <div key={s.l} className="flex flex-col items-center">
            <dd className="font-mono font-bold text-lg text-lz-text tabular leading-none">{s.v}</dd>
            <dt className="text-2xs text-lz-faint uppercase tracking-eyebrow mt-1.5">{s.l}</dt>
          </div>
        ))}
      </dl>
    </section>
  );
}
