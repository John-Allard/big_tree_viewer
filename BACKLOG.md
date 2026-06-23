# Backlog

## Detect silent large-spiral canvas draw failures

- Observed on 2026-06-19 in Chrome with hardware acceleration enabled: 200k+ tip trees in spiral mode can load and remain hoverable while the main tree is invisible.
- Full Chrome restart with hardware acceleration disabled restores rendering, which points to Chrome's accelerated canvas/graphics backend silently failing to rasterize the large spiral `Path2D` branch workload.
- Add a render-health check for large spiral draws that samples the canvas after drawing and verifies branch-colored pixels are present.
- If the check fails, try a CPU/readback-oriented canvas path such as a `willReadFrequently` context/canvas fallback, then redraw.
- If fallback still fails, show a visible warning explaining that the browser graphics backend failed and suggesting disabling hardware acceleration or using another browser.
