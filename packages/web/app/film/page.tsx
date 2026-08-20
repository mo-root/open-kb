import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "open-kb — the launch film",
  description: "One domain in, knowledge base out.",
};

/**
 * The film, with its sound. The landing autoplays it muted — a page a visitor
 * chose to open is the one place the score plays, so this is a deliberate
 * destination rather than chrome: one video, controls on, nothing else asking
 * for attention.
 */
export default function FilmPage() {
  return (
    <div className="mx-auto max-w-5xl px-5 py-10">
      <video
        src="/launch.mp4"
        controls
        autoPlay
        playsInline
        aria-label="The launch film: one domain in, knowledge base out"
        className="w-full rounded-lg border border-slate-800"
      />
      <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-wider text-slate-500">
        one domain in, knowledge base out
      </p>
    </div>
  );
}
