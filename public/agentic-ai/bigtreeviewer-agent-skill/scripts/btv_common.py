#!/usr/bin/env python3
"""Shared helpers for Big Tree Viewer agent scripts."""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import pathlib
import tempfile
import urllib.parse
from typing import Any


DEFAULT_BTV_URL = "https://bigtreeviewer.net/"
DEFAULT_RECTANGULAR_EXPORT_SIZE = (1600, 1000)
DEFAULT_SQUARE_EXPORT_SIZE = (1200, 1200)


def read_text(path: str) -> str:
    return pathlib.Path(path).read_text(encoding="utf-8")


def read_session(path: str) -> dict[str, Any]:
    data = pathlib.Path(path).read_bytes()
    if data.startswith(b"\x1f\x8b"):
        data = gzip.decompress(data)
    try:
        parsed = json.loads(data.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"{path} is not a valid Big Tree Viewer session file.") from error
    if not isinstance(parsed, dict) or parsed.get("format") != "big-tree-viewer-session" or parsed.get("version") != 1:
        raise SystemExit(f"{path} is not a valid Big Tree Viewer session file.")
    return parsed


def path_looks_like_session(path: str) -> bool:
    return pathlib.Path(path).suffix.lower() in {".btvsession", ".json"}


def base64url_text(value: str) -> str:
    encoded = base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii")
    return encoded.rstrip("=")


def parse_bool(value: str | bool | None) -> bool | None:
    if value is None or isinstance(value, bool):
        return value
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"Expected true or false, got {value!r}.")


def add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("tree", nargs="?", help="Local Newick/NEXUS tree file or .btvsession session file.")
    parser.add_argument("--btv-url", default=DEFAULT_BTV_URL, help="Big Tree Viewer URL. Default: https://bigtreeviewer.net/")
    parser.add_argument("--payload-json", help="JSON file containing a Big Tree Viewer launch payload.")
    parser.add_argument("--metadata", help="Optional local CSV/TSV metadata file.")
    parser.add_argument("--metadata-key", help="Metadata column matched to tree labels.")
    parser.add_argument("--metadata-value", help="Metadata value/color column.")
    parser.add_argument("--view", choices=["rectangular", "circular", "fan", "spiral"], help="Tree view mode.")
    parser.add_argument("--order", choices=["asc", "desc", "input"], help="Child ordering.")
    parser.add_argument("--tip-labels", type=parse_bool, help="Show tip labels: true or false.")
    parser.add_argument("--genus-labels", type=parse_bool, help="Show genus labels: true or false.")
    parser.add_argument("--taxonomy", type=parse_bool, help="Show taxonomy overlays when the payload contains taxonomy.")
    parser.add_argument("--taxonomy-branch-colors", type=parse_bool, help="Color branches using taxonomy mapping.")
    parser.add_argument("--map-taxonomy", action="store_true", help="Run Big Tree Viewer's standard NCBI taxonomy mapper after loading the tree using an already cached taxonomy archive.")
    parser.add_argument("--allow-taxonomy-download", action="store_true", help="Allow Big Tree Viewer to download the NCBI taxdump archive if --map-taxonomy is enabled and no cached archive is available.")
    parser.add_argument("--taxonomy-low-memory", action="store_true", help="Use low-memory mode when --map-taxonomy is enabled.")
    parser.add_argument("--time-stripes", type=parse_bool, help="Show time stripes: true or false.")
    parser.add_argument("--scale-bars", type=parse_bool, help="Show scale bars: true or false.")
    parser.add_argument("--branch-thickness", type=float, help="Branch thickness scale.")
    parser.add_argument("--rotation", type=float, help="Circular rotation in degrees.")
    parser.add_argument("--spiral-turns", type=float, help="Number of spiral turns.")
    parser.add_argument("--rect-scale-x", type=float, help="Rectangular camera x scale. Use with the other --rect-* camera options.")
    parser.add_argument("--rect-scale-y", type=float, help="Rectangular camera y scale. Use with the other --rect-* camera options.")
    parser.add_argument("--rect-translate-x", type=float, help="Rectangular camera x translation in screen pixels. Use with the other --rect-* camera options.")
    parser.add_argument("--rect-translate-y", type=float, help="Rectangular camera y translation in screen pixels. Use with the other --rect-* camera options.")


def load_payload(args: argparse.Namespace, *, require_source: bool = True) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    if args.payload_json:
        payload = json.loads(read_text(args.payload_json))
        if not isinstance(payload, dict):
            raise SystemExit("--payload-json must contain a JSON object.")
    if args.tree:
        if path_looks_like_session(args.tree):
            payload["session"] = read_session(args.tree)
        else:
            payload["newick"] = read_text(args.tree)
        payload.setdefault("label", pathlib.Path(args.tree).stem)
    if args.metadata:
        payload["metadata"] = {
            **payload.get("metadata", {}),
            "text": read_text(args.metadata),
            "label": pathlib.Path(args.metadata).name,
            "keyColumn": args.metadata_key,
            "valueColumn": args.metadata_value,
            "enabled": True,
        }
    visual = dict(payload.get("visual") or {})
    option_map = {
        "view": "viewMode",
        "order": "order",
        "tip_labels": "showTipLabels",
        "genus_labels": "showGenusLabels",
        "taxonomy": "taxonomyEnabled",
        "taxonomy_branch_colors": "taxonomyBranchColoringEnabled",
        "time_stripes": "showTimeStripes",
        "scale_bars": "showScaleBars",
        "branch_thickness": "branchThicknessScale",
        "rotation": "circularRotationDegrees",
        "spiral_turns": "spiralTurns",
    }
    for arg_name, payload_name in option_map.items():
        value = getattr(args, arg_name, None)
        if value is not None:
            visual[payload_name] = value
    if visual:
        payload["visual"] = visual
    if args.map_taxonomy:
        taxonomy = dict(payload.get("taxonomy") or {})
        taxonomy["runMapping"] = True
        if args.allow_taxonomy_download:
            taxonomy["allowDownload"] = True
        if args.taxonomy_low_memory:
            taxonomy["lowMemoryMode"] = True
        payload["taxonomy"] = taxonomy
    rect_camera_values = {
        "scaleX": args.rect_scale_x,
        "scaleY": args.rect_scale_y,
        "translateX": args.rect_translate_x,
        "translateY": args.rect_translate_y,
    }
    provided_rect_camera_values = {key: value for key, value in rect_camera_values.items() if value is not None}
    if provided_rect_camera_values:
        if len(provided_rect_camera_values) != len(rect_camera_values):
            raise SystemExit("Use all rectangular camera options together: --rect-scale-x, --rect-scale-y, --rect-translate-x, and --rect-translate-y.")
        canvas = dict(payload.get("canvas") or {})
        canvas["camera"] = {"kind": "rect", **provided_rect_camera_values}
        payload["canvas"] = canvas
    if require_source and not any(key in payload for key in ("newick", "newickUrl", "session", "sessionUrl")):
        raise SystemExit("Provide a local tree/session file or --payload-json with newick/newickUrl/session/sessionUrl.")
    return payload


def payload_view_mode(payload: dict[str, Any], fallback: str = "rectangular") -> str:
    visual = payload.get("visual") if isinstance(payload.get("visual"), dict) else {}
    if visual.get("viewMode") in {"rectangular", "circular", "fan", "spiral"}:
        return str(visual["viewMode"])
    session = payload.get("session") if isinstance(payload.get("session"), dict) else {}
    settings = session.get("settings") if isinstance(session.get("settings"), dict) else {}
    if settings.get("viewMode") in {"rectangular", "circular", "fan", "spiral"}:
        return str(settings["viewMode"])
    return fallback if fallback in {"rectangular", "circular", "fan", "spiral"} else "rectangular"


def export_dimensions_for_view(
    export_format: str,
    view_mode: str,
    width: int | None,
    height: int | None,
    viewport_width: int | None,
    viewport_height: int | None,
) -> tuple[int | None, int | None, int | None, int | None]:
    if export_format != "png":
        return None, None, viewport_width, viewport_height
    if view_mode in {"rectangular", "fan"}:
        return (
            width if width is not None else DEFAULT_RECTANGULAR_EXPORT_SIZE[0],
            height if height is not None else DEFAULT_RECTANGULAR_EXPORT_SIZE[1],
            viewport_width,
            viewport_height,
        )
    if width is not None and height is not None and width != height:
        raise SystemExit("Circular and spiral PNG exports must be square. Use equal --width and --height, or provide only one dimension.")
    if viewport_width is not None and viewport_height is not None and viewport_width != viewport_height:
        raise SystemExit("Circular and spiral PNG export viewports must be square. Use equal viewport dimensions, or provide only one.")
    size = width if width is not None else height
    if size is None:
        size = DEFAULT_SQUARE_EXPORT_SIZE[0]
    viewport_size = viewport_width if viewport_width is not None else viewport_height
    return size, size, viewport_size, viewport_size


def normalize_btv_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SystemExit(f"Invalid Big Tree Viewer URL: {value!r}")
    path = parsed.path or "/"
    if not path.endswith("/"):
        path = f"{path}/"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment))


def _inline_json(value: Any) -> str:
    return (
        json.dumps(value)
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def write_launcher_html(payload: dict[str, Any], btv_url: str) -> pathlib.Path:
    payload_json = _inline_json(payload)
    target = normalize_btv_url(btv_url)
    parsed_target = urllib.parse.urlsplit(target)
    target_origin = urllib.parse.urlunsplit((parsed_target.scheme, parsed_target.netloc, "", "", ""))
    target_query = urllib.parse.parse_qsl(parsed_target.query, keep_blank_values=True)
    target_query = [(key, value) for key, value in target_query if key != "btv_api"]
    target_query.append(("btv_api", "1"))
    target_with_api = urllib.parse.urlunsplit((
        parsed_target.scheme,
        parsed_target.netloc,
        parsed_target.path or "/",
        urllib.parse.urlencode(target_query),
        parsed_target.fragment,
    ))
    html_text = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Big Tree Viewer</title>
<style>
html, body {{ width: 100%; height: 100%; margin: 0; overflow: hidden; background: #fff; }}
#viewer {{ display: block; width: 100%; height: 100%; border: 0; }}
#status {{
  position: fixed;
  z-index: 1;
  top: 0;
  left: 0;
  right: 0;
  box-sizing: border-box;
  margin: 0;
  padding: 10px 14px;
  color: #1f2933;
  background: #fff;
  font: 14px/1.4 system-ui, sans-serif;
}}
body.btv-loaded #status {{ display: none; }}
body.btv-error #status {{ color: #8b1e1e; }}
</style>
</head>
<body>
<p id="status" role="status" aria-live="polite">Opening Big Tree Viewer...</p>
<iframe id="viewer" title="Big Tree Viewer" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
<script>
const payload = {payload_json};
const targetOrigin = {_inline_json(target_origin)};
const targetUrl = {_inline_json(target)};
const windowLaunchPrefix = "big-tree-viewer-window-launch-v1:";
const windowNameProbePrefix = "big-tree-viewer-window-name-probe-v1:";
const statusNode = document.getElementById("status");
const viewer = document.getElementById("viewer");
let embeddedLoadSent = false;
let completed = false;
function sendEmbeddedLoad() {{
  if (embeddedLoadSent || completed) return;
  embeddedLoadSent = true;
  viewer.contentWindow.postMessage({{ type: "big-tree-viewer:load", payload }}, targetOrigin);
}}
window.addEventListener("message", (event) => {{
  if (event.source !== viewer.contentWindow || event.origin !== targetOrigin || !event.data) return;
  if (event.data.type === "big-tree-viewer:ready" && !embeddedLoadSent) {{
    const capabilities = Array.isArray(event.data.capabilities) ? event.data.capabilities : [];
    if (capabilities.includes("window-name-launch") && event.data.windowNameProbe === true) {{
      completed = true;
      statusNode.textContent = "Transferring the local tree to Big Tree Viewer...";
      window.name = windowLaunchPrefix + JSON.stringify(payload);
      const launchUrl = new URL(targetUrl);
      launchUrl.searchParams.delete("btv_api");
      launchUrl.searchParams.set("btv_window_launch", "1");
      window.location.replace(launchUrl.toString());
    }} else {{
      sendEmbeddedLoad();
    }}
  }}
  if (event.data.type === "big-tree-viewer:loaded") {{
    completed = true;
    document.body.classList.add("btv-loaded");
    statusNode.textContent = "Loaded in Big Tree Viewer.";
    viewer.focus();
  }}
  if (event.data.type === "big-tree-viewer:error") {{
    completed = true;
    document.body.classList.add("btv-error");
    statusNode.textContent = "Big Tree Viewer error: " + String(event.data.message || "Unknown error");
  }}
}});
window.setTimeout(() => {{
  if (!completed) {{
    document.body.classList.add("btv-error");
    statusNode.textContent = "Big Tree Viewer did not finish opening. Check the browser console or network connection.";
  }}
}}, 30000);
const probeToken = typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${{Date.now()}}-${{Math.random().toString(16).slice(2)}}`;
const probeUrl = new URL({_inline_json(target_with_api)});
probeUrl.searchParams.set("btv_window_name_probe", probeToken);
viewer.contentWindow.name = windowNameProbePrefix + probeToken;
viewer.src = probeUrl.toString();
</script>
</body>
</html>
"""
    handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".html", delete=False)
    with handle:
        handle.write(html_text)
    return pathlib.Path(handle.name)
