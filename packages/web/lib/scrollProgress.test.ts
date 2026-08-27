import { describe, it, expect } from "vitest"
import { scrollProgress } from "./scrollProgress"

describe("scrollProgress", () => {
  it("is 0 at the top of the track", () => {
    expect(scrollProgress(0, 1000)).toBe(0)
  })

  it("is 1 once the track has scrolled its full span", () => {
    expect(scrollProgress(-1000, 1000)).toBe(1)
  })

  it("is proportional partway through the track", () => {
    expect(scrollProgress(-250, 1000)).toBe(0.25)
  })

  it("clamps before the track is reached (top still positive)", () => {
    expect(scrollProgress(500, 1000)).toBe(0)
  })

  it("clamps past the end of the track (scrolled further than the span)", () => {
    expect(scrollProgress(-2000, 1000)).toBe(1)
  })

  it("is 0 when the track is shorter than the viewport (non-positive span)", () => {
    expect(scrollProgress(-50, 0)).toBe(0)
    expect(scrollProgress(-50, -200)).toBe(0)
  })
})
