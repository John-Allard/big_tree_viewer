#!/usr/bin/env python3
"""Render a local tree or session without touching the user's active browser."""

from __future__ import annotations

import argparse
import pathlib
from typing import Any

from btv_common import (
    add_common_arguments,
    export_dimensions_for_view,
    load_payload,
    payload_view_mode,
)
from btv_headless import HeadlessRenderError, default_profile_dir, render_payload_headlessly


def infer_export_format(output: pathlib.Path, explicit_format: str | None) -> str:
    suffix = output.suffix.lower().lstrip(".")
    if explicit_format:
        if suffix in {"png", "svg"} and suffix != explicit_format:
            raise SystemExit(f"--format {explicit_format} does not match the output filename {output.name!r}.")
        return explicit_format
    if suffix not in {"png", "svg"}:
        raise SystemExit("Use an output filename ending in .png or .svg, or pass --format.")
    return suffix


def build_export_payload(args: argparse.Namespace) -> tuple[dict[str, Any], pathlib.Path, str]:
    if args.session_url and (args.tree or args.payload_json):
        raise SystemExit("Use --session-url by itself, or provide a local tree/session/payload without --session-url.")
    payload = load_payload(args, require_source=not bool(args.session_url))
    if args.session_url:
        payload["sessionUrl"] = args.session_url
    output = pathlib.Path(args.output)
    export_format = infer_export_format(output, args.format)
    existing_export = payload.get("export") if isinstance(payload.get("export"), dict) else {}
    raw_width = args.width if args.width is not None else existing_export.get("width")
    raw_height = args.height if args.height is not None else existing_export.get("height")
    raw_viewport_width = (
        args.export_viewport_width
        if args.export_viewport_width is not None
        else existing_export.get("viewportWidth")
    )
    raw_viewport_height = (
        args.export_viewport_height
        if args.export_viewport_height is not None
        else existing_export.get("viewportHeight")
    )
    width, height, viewport_width, viewport_height = export_dimensions_for_view(
        export_format,
        payload_view_mode(payload),
        raw_width if isinstance(raw_width, int) else None,
        raw_height if isinstance(raw_height, int) else None,
        raw_viewport_width if isinstance(raw_viewport_width, int) else None,
        raw_viewport_height if isinstance(raw_viewport_height, int) else None,
    )
    payload["export"] = {
        "format": export_format,
        "delivery": "postMessage",
        "filename": output.name,
        "width": width,
        "height": height,
        "viewportWidth": viewport_width,
        "viewportHeight": viewport_height,
    }
    return payload, output, export_format


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render a tree or session through Big Tree Viewer in an isolated headless browser.",
    )
    add_common_arguments(parser)
    parser.add_argument("--session-url", help="Public URL for a .btvsession file.")
    parser.add_argument("--output", required=True, help="Output .png or .svg path.")
    parser.add_argument("--format", choices=["png", "svg"], help="Export format. Normally inferred from --output.")
    parser.add_argument("--width", type=int, help="PNG width. Defaults to 1600 rectangular or 1200 circular/spiral.")
    parser.add_argument("--height", type=int, help="PNG height. Defaults to 1000 rectangular or 1200 circular/spiral.")
    parser.add_argument("--export-viewport-width", type=int, help="CSS-pixel viewport width used for PNG styling.")
    parser.add_argument("--export-viewport-height", type=int, help="CSS-pixel viewport height used for PNG styling.")
    parser.add_argument("--window-width", type=int, default=1600, help="Isolated browser window width. Default: 1600.")
    parser.add_argument("--window-height", type=int, default=1000, help="Isolated browser window height. Default: 1000.")
    parser.add_argument("--browser", help="Chrome/Chromium/Edge executable. Auto-detected by default.")
    parser.add_argument(
        "--profile-dir",
        type=pathlib.Path,
        default=default_profile_dir(),
        help="Dedicated browser profile used only by BTV automation. It preserves the taxonomy cache.",
    )
    parser.add_argument("--timeout", type=float, default=180, help="Maximum render time in seconds. Default: 180.")
    args = parser.parse_args()

    payload, output, export_format = build_export_payload(args)
    try:
        result = render_payload_headlessly(
            payload,
            btv_url=args.btv_url,
            output_path=output,
            export_format=export_format,
            browser_path=args.browser,
            profile_dir=args.profile_dir,
            timeout_seconds=args.timeout,
            window_width=args.window_width,
            window_height=args.window_height,
        )
    except HeadlessRenderError as error:
        raise SystemExit(f"Big Tree Viewer render failed: {error}") from error
    dimensions = f", {result.width} x {result.height}" if result.width and result.height else ""
    print(
        f"Rendered {export_format.upper()} to {result.output_path} "
        f"({result.byte_count:,} bytes{dimensions}) using isolated {result.browser_path.name}."
    )


if __name__ == "__main__":
    main()
