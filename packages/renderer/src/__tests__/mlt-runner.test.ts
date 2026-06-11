import { describe, it, expect } from "vitest";
import { buildMeltArgs, buildMeltProfile, meltProfilePath } from "../mlt-runner.js";

describe("melt profile", () => {
  it("derives a .profile sidecar path from the script path", () => {
    expect(meltProfilePath("/x/project.mlt")).toBe("/x/project.profile");
    expect(meltProfilePath("/x/project")).toBe("/x/project.profile");
  });

  it("emits a square-pixel BT.709 profile (not dv_pal's 16:15)", () => {
    const p = buildMeltProfile(1080, 1920, 30);
    expect(p).toContain("width=1080");
    expect(p).toContain("height=1920");
    expect(p).toContain("sample_aspect_num=1");
    expect(p).toContain("sample_aspect_den=1");
    expect(p).toContain("display_aspect_num=1080");
    expect(p).toContain("display_aspect_den=1920");
    expect(p).toContain("colorspace=709");
    expect(p).toContain("frame_rate_num=30");
  });

  it("points -profile at the sidecar file, not an ad-hoc WxH string", () => {
    const args = buildMeltArgs("/x/project.mlt", "/x/out.mp4", {
      scriptPath: "/x/project.mlt",
      width: 1080,
      height: 1920,
      fps: 30,
    });
    const i = args.indexOf("-profile");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("/x/project.profile");
    // the broken ad-hoc form must be gone
    expect(args.join(" ")).not.toContain("1080x1920/30");
    // consumer still carries explicit dims
    expect(args).toContain("width=1080");
    expect(args).toContain("height=1920");
  });
});
