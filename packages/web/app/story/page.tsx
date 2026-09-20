import type { Metadata } from "next";
import { ScrollFilm } from "@/components/ScrollFilm";

export const metadata: Metadata = {
  title: "open-kb — the story",
  description: "One domain in, knowledge base out — scroll to play.",
};

/**
 * The launch film as a scroll. /film plays it with sound at its own pace;
 * this page hands the clock to the reader — the film advances exactly as far
 * as they scroll, which turns the 32.5-second montage (`ScrollFilm.tsx`'s own
 * `TOTAL`, matching `launch-rig.html`'s and `DemoHome.tsx`'s independent
 * "32 seconds") into a walkthrough they control. The rig renders every frame
 * from its timeline deterministically, so scrubbing backwards is as clean as
 * forwards.
 */
export default function StoryPage() {
  return <ScrollFilm />;
}
