#!/usr/bin/env python3
"""Render a local tree or session with Big Tree Viewer and save SVG or PNG."""

from __future__ import annotations

import argparse
import base64
import pathlib

from btv_common import add_common_arguments, load_payload, normalize_btv_url


def infer_format(path: str, requested: str | None) -> str:
    if requested:
        return requested
    suffix = pathlib.Path(path).suffix.lower()
    if suffix == ".png":
        return "png"
    if suffix and suffix != ".svg":
        raise SystemExit("Use --format svg or --format png for non-.svg/.png output paths.")
    return "svg"


def write_export(path: str, result: dict) -> None:
    if not result.get("ok"):
        raise SystemExit(result.get("message") or "Big Tree Viewer export failed.")
    output = pathlib.Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    if result.get("format") == "png":
        data_url = result.get("dataUrl")
        if not isinstance(data_url, str) or "," not in data_url:
            raise SystemExit("Big Tree Viewer did not return PNG data.")
        output.write_bytes(base64.b64decode(data_url.split(",", 1)[1]))
        return
    text = result.get("text")
    if not isinstance(text, str):
        raise SystemExit("Big Tree Viewer did not return SVG text.")
    output.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Render a tree or session with Big Tree Viewer.")
    add_common_arguments(parser)
    parser.add_argument("--out", required=True, help="Output SVG or PNG path.")
    parser.add_argument("--format", choices=["svg", "png"], help="Output format. Defaults from --out extension.")
    parser.add_argument("--width", type=int, default=2400, help="PNG export width and browser viewport width.")
    parser.add_argument("--height", type=int, default=2400, help="PNG export height and browser viewport height.")
    parser.add_argument("--timeout-ms", type=int, default=120000, help="Render timeout in milliseconds.")
    args = parser.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise SystemExit(
            "btv_render.py requires Playwright. Install it with:\n"
            "  python -m pip install playwright\n"
            "  python -m playwright install chromium"
        ) from error

    payload = load_payload(args)
    export_format = infer_format(args.out, args.format)
    payload["export"] = {
        "format": export_format,
        "delivery": "postMessage",
        "filename": pathlib.Path(args.out).name,
        "width": args.width,
        "height": args.height,
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": args.width, "height": args.height})
        page.goto(f"{normalize_btv_url(args.btv_url)}?btv_api=1", wait_until="domcontentloaded")
        page.wait_for_function("window.__BIG_TREE_VIEWER_API_READY__ === true", timeout=args.timeout_ms)
        result = page.evaluate(
            """({ payload, timeoutMs }) => new Promise((resolve, reject) => {
              const timeout = window.setTimeout(() => {
                window.removeEventListener("message", handler);
                reject(new Error("Timed out waiting for Big Tree Viewer export."));
              }, timeoutMs);
              function handler(event) {
                const data = event.data || {};
                if (data.type === "big-tree-viewer:exported" || data.type === "big-tree-viewer:export-error") {
                  window.clearTimeout(timeout);
                  window.removeEventListener("message", handler);
                  resolve(data);
                }
              }
              window.addEventListener("message", handler);
              window.postMessage({ type: "big-tree-viewer:load", payload }, "*");
            })""",
            {"payload": payload, "timeoutMs": args.timeout_ms},
        )
        browser.close()

    write_export(args.out, result)
    print(args.out)


if __name__ == "__main__":
    main()
