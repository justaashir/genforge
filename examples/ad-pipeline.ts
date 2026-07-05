// The pipeline genforge was extracted from: a Meta video ad for a local
// grocery app. Storyboard image → human review → 15s video → human review,
// with a hard budget and cost approval on the expensive step.
//
//   bun examples/ad-pipeline.ts        # runs (or resumes) the pipeline
//   bunx genforge dev                  # review UI at :4321 — approve gates there
//
// Crash it anywhere (ctrl-c, kill -9, laptop dies): re-running the same
// command resumes exactly where it stopped and never re-buys a generation.

import { fal } from "../src/adapters/fal";
import { gate, run, step } from "../src/index";

await run("under-one-roof-ad", async (ctx) => {
  ctx.budget(5.0); // hard ceiling — enforced before every submit

  const storyboard = await step(ctx, "storyboard", {
    adapter: fal("fal-ai/nano-banana-pro/edit"),
    input: {
      aspect_ratio: "9:16",
      image_urls: ["https://assets.example.com/brand-ad-tote.png"],
      num_images: 1,
      prompt:
        "4-panel storyboard grid: branded tote fills with groceries, " +
        "doorstep delivery at golden hour, product close-up, end card space",
    },
    units: 1,
  });

  await gate(ctx, "review-storyboard", {
    artifact: storyboard,
    note: "does panel 1 work as the video start frame?",
  });

  const video = await step(ctx, "full-ad", {
    adapter: fal("fal-ai/kling-video/v3/pro/image-to-video"),
    approveOver: 1.0, // >$1 → blocks on an approval gate first
    input: {
      duration: "15",
      generate_audio: true,
      start_image_url: storyboard.url,
    },
    units: 15, // billed per second of output video
  });

  await gate(ctx, "review-video", {
    artifact: video,
    note: "hook in second 1? readable muted? logo after the hook?",
  });

  console.log(`shipped: ${video.path ?? video.url}`);
});
