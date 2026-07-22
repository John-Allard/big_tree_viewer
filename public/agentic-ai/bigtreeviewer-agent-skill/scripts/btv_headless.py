#!/usr/bin/env python3
"""Render a Big Tree Viewer launch payload in an isolated headless browser."""

from __future__ import annotations

import contextlib
import dataclasses
import html
import json
import os
import pathlib
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import zlib
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterator


@dataclasses.dataclass(frozen=True)
class HeadlessRenderResult:
    output_path: pathlib.Path
    browser_path: pathlib.Path
    byte_count: int
    width: int | None
    height: int | None


class HeadlessRenderError(RuntimeError):
    """Raised when the isolated browser cannot complete an export."""


def default_profile_dir() -> pathlib.Path:
    configured_root = os.environ.get("BTV_AGENT_CACHE_HOME") or os.environ.get("XDG_CACHE_HOME")
    if configured_root:
        cache_root = pathlib.Path(configured_root)
    elif os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        cache_root = pathlib.Path(os.environ["LOCALAPPDATA"])
    elif sys.platform == "darwin":
        cache_root = pathlib.Path.home() / "Library" / "Caches"
    else:
        cache_root = pathlib.Path.home() / ".cache"
    return cache_root / "bigtreeviewer-agent" / "chrome-profile"


def find_chromium(explicit_path: str | None = None) -> pathlib.Path:
    candidates: list[str] = []
    if explicit_path:
        candidates.append(explicit_path)
    if os.environ.get("BTV_BROWSER"):
        candidates.append(os.environ["BTV_BROWSER"])
    candidates.extend([
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
        "microsoft-edge-stable",
        "microsoft-edge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ])
    if os.name == "nt":
        for root_name in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            root = os.environ.get(root_name)
            if root:
                candidates.extend([
                    str(pathlib.Path(root) / "Google/Chrome/Application/chrome.exe"),
                    str(pathlib.Path(root) / "Microsoft/Edge/Application/msedge.exe"),
                ])
    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return pathlib.Path(resolved).resolve()
        path = pathlib.Path(candidate).expanduser()
        if path.is_file() and os.access(path, os.X_OK):
            return path.resolve()
    raise HeadlessRenderError(
        "No Chrome, Chromium, or Edge executable was found. Install a Chromium-based browser "
        "or pass --browser /path/to/browser. The BTV helper does not download a browser."
    )


def _target_url_and_origin(btv_url: str) -> tuple[str, str]:
    parsed = urllib.parse.urlsplit(btv_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HeadlessRenderError(f"Invalid Big Tree Viewer URL: {btv_url!r}")
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query = [(key, value) for key, value in query if key != "btv_api"]
    query.append(("btv_api", "1"))
    target_url = urllib.parse.urlunsplit((
        parsed.scheme,
        parsed.netloc,
        parsed.path or "/",
        urllib.parse.urlencode(query),
        parsed.fragment,
    ))
    origin = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    return target_url, origin


def _launcher_html(target_url: str, target_origin: str, browser_timeout_seconds: float) -> bytes:
    timeout_ms = max(1_000, round(browser_timeout_seconds * 1_000))
    source = f"""<!doctype html>
<meta charset="utf-8">
<title>Big Tree Viewer isolated renderer</title>
<p id="status">Starting isolated Big Tree Viewer renderer...</p>
<script>
const targetUrl = {json.dumps(target_url)};
const targetOrigin = {json.dumps(target_origin)};
const statusNode = document.getElementById("status");
let finished = false;
let loadSent = false;
let viewer = null;

function setStatus(stage, message) {{
  statusNode.textContent = message;
  void fetch("/status", {{
    method: "POST",
    headers: {{ "Content-Type": "application/json" }},
    body: JSON.stringify({{ stage, message }}),
  }}).catch(() => undefined);
}}

async function fail(message) {{
  if (finished) return;
  finished = true;
  clearTimeout(timeoutHandle);
  statusNode.textContent = message;
  try {{
    await fetch("/error", {{
      method: "POST",
      headers: {{ "Content-Type": "application/json" }},
      body: JSON.stringify({{ message }}),
    }});
  }} catch (_) {{}}
  if (viewer && !viewer.closed) viewer.close();
}}

async function submitExport(message) {{
  if (finished) return;
  finished = true;
  clearTimeout(timeoutHandle);
  try {{
    let blob;
    if (message.format === "png" && typeof message.dataUrl === "string") {{
      blob = await (await fetch(message.dataUrl)).blob();
    }} else if (message.format === "svg" && typeof message.text === "string") {{
      blob = new Blob([message.text], {{ type: message.mimeType || "image/svg+xml" }});
    }} else {{
      throw new Error("Big Tree Viewer returned an export without image data.");
    }}
    setStatus("uploading", "Receiving completed render...");
    const response = await fetch("/result", {{
      method: "POST",
      headers: {{
        "Content-Type": message.mimeType || blob.type || "application/octet-stream",
        "X-BTV-Format": message.format,
        "X-BTV-Width": String(message.width || ""),
        "X-BTV-Height": String(message.height || ""),
      }},
      body: blob,
    }});
    if (!response.ok) throw new Error(await response.text());
    statusNode.textContent = "Render complete.";
    if (viewer && !viewer.closed) viewer.close();
  }} catch (error) {{
    finished = false;
    await fail(error instanceof Error ? error.message : String(error));
  }}
}}

const timeoutHandle = setTimeout(() => {{
  void fail("Timed out waiting for Big Tree Viewer to render the export.");
}}, {timeout_ms});

const payloadPromise = fetch("/payload", {{ cache: "no-store" }}).then((response) => {{
  if (!response.ok) throw new Error("Unable to read the local launch payload.");
  return response.json();
}});

window.addEventListener("message", async (event) => {{
  if (event.source !== viewer || event.origin !== targetOrigin || !event.data) return;
  if (event.data.type === "big-tree-viewer:ready" && !loadSent) {{
    loadSent = true;
    try {{
      const payload = await payloadPromise;
      setStatus("loading", "Loading tree in Big Tree Viewer...");
      viewer.postMessage({{ type: "big-tree-viewer:load", payload }}, targetOrigin);
    }} catch (error) {{
      await fail(error instanceof Error ? error.message : String(error));
    }}
    return;
  }}
  if (event.data.type === "big-tree-viewer:loaded") {{
    setStatus("rendering", "Rendering Big Tree Viewer export...");
    return;
  }}
  if (event.data.type === "big-tree-viewer:exported") {{
    await submitExport(event.data);
    return;
  }}
  if (event.data.type === "big-tree-viewer:error" || event.data.type === "big-tree-viewer:export-error") {{
    await fail(event.data.message || "Big Tree Viewer reported an unknown error.");
  }}
}});

try {{
  viewer = window.open(targetUrl, "btv-isolated-render", "noopener=false");
  if (!viewer) void fail("The isolated browser blocked the Big Tree Viewer window.");
  else setStatus("opening", "Opening Big Tree Viewer in the isolated browser...");
}} catch (error) {{
  void fail(error instanceof Error ? error.message : String(error));
}}
</script>
"""
    return source.encode("utf-8")


@dataclasses.dataclass
class _ServerState:
    launcher: bytes
    payload: bytes
    output_path: pathlib.Path
    expected_format: str
    event: threading.Event = dataclasses.field(default_factory=threading.Event)
    error: str | None = None
    stage: str = "starting"
    width: int | None = None
    height: int | None = None
    received_path: pathlib.Path | None = None


def _handler_for(state: _ServerState) -> type[BaseHTTPRequestHandler]:
    class RenderHandler(BaseHTTPRequestHandler):
        server_version = "BTVHeadlessRenderer/1"

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def _send_bytes(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
            self.send_response(status.value)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            path = urllib.parse.urlsplit(self.path).path
            if path in {"/", "/launcher"}:
                self._send_bytes(HTTPStatus.OK, state.launcher, "text/html; charset=utf-8")
                return
            if path == "/payload":
                self._send_bytes(HTTPStatus.OK, state.payload, "application/json; charset=utf-8")
                return
            self._send_bytes(HTTPStatus.NOT_FOUND, b"Not found", "text/plain; charset=utf-8")

        def _read_body(self, maximum: int | None = None) -> bytes:
            raw_length = self.headers.get("Content-Length")
            if raw_length is None:
                raise HeadlessRenderError("The browser response did not include a Content-Length header.")
            length = int(raw_length)
            if maximum is not None and length > maximum:
                raise HeadlessRenderError("The browser response was unexpectedly large.")
            body = self.rfile.read(length)
            if len(body) != length:
                raise HeadlessRenderError("The browser response ended before all export bytes were received.")
            return body

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            path = urllib.parse.urlsplit(self.path).path
            try:
                if path == "/status":
                    message = json.loads(self._read_body(64 * 1024).decode("utf-8"))
                    if isinstance(message, dict) and isinstance(message.get("stage"), str):
                        state.stage = message["stage"]
                    self._send_bytes(HTTPStatus.OK, b"ok", "text/plain; charset=utf-8")
                    return
                if path == "/error":
                    message = json.loads(self._read_body(1024 * 1024).decode("utf-8"))
                    state.error = str(message.get("message") if isinstance(message, dict) else message)
                    self._send_bytes(HTTPStatus.OK, b"ok", "text/plain; charset=utf-8")
                    state.event.set()
                    return
                if path != "/result":
                    self._send_bytes(HTTPStatus.NOT_FOUND, b"Not found", "text/plain; charset=utf-8")
                    return
                actual_format = self.headers.get("X-BTV-Format", "").lower()
                if actual_format != state.expected_format:
                    raise HeadlessRenderError(
                        f"Expected a {state.expected_format} export, but Big Tree Viewer returned {actual_format or 'an unknown format'}."
                    )
                raw_length = self.headers.get("Content-Length")
                if raw_length is None:
                    raise HeadlessRenderError("The browser response did not include a Content-Length header.")
                remaining = int(raw_length)
                state.output_path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(
                    mode="wb",
                    dir=state.output_path.parent,
                    prefix=f".{state.output_path.name}.",
                    suffix=".tmp",
                    delete=False,
                ) as handle:
                    temporary_path = pathlib.Path(handle.name)
                    while remaining > 0:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise HeadlessRenderError("The browser response ended before all export bytes were received.")
                        handle.write(chunk)
                        remaining -= len(chunk)
                state.received_path = temporary_path
                width_header = self.headers.get("X-BTV-Width", "")
                height_header = self.headers.get("X-BTV-Height", "")
                state.width = int(width_header) if width_header.isdigit() else None
                state.height = int(height_header) if height_header.isdigit() else None
                self._send_bytes(HTTPStatus.OK, b"ok", "text/plain; charset=utf-8")
                state.stage = "complete"
                state.event.set()
            except Exception as error:  # Browser receives the concrete failure text.
                state.error = str(error)
                self._send_bytes(
                    HTTPStatus.BAD_REQUEST,
                    str(error).encode("utf-8", errors="replace"),
                    "text/plain; charset=utf-8",
                )
                state.event.set()

    return RenderHandler


@contextlib.contextmanager
def _profile_lock(profile_dir: pathlib.Path, timeout_seconds: float) -> Iterator[None]:
    profile_dir.mkdir(parents=True, exist_ok=True)
    lock_path = profile_dir.parent / f".{profile_dir.name}.render.lock"
    with lock_path.open("a+b") as lock_file:
        if os.name == "nt":
            import msvcrt

            lock_file.seek(0, os.SEEK_END)
            if lock_file.tell() == 0:
                lock_file.write(b"\0")
                lock_file.flush()
            deadline = time.monotonic() + timeout_seconds
            while True:
                lock_file.seek(0)
                try:
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise HeadlessRenderError(
                            f"Timed out waiting for another BTV render using profile {profile_dir}."
                        )
                    time.sleep(0.1)
            try:
                yield
            finally:
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            return

        try:
            import fcntl
        except ImportError as error:
            raise HeadlessRenderError("This platform does not provide a supported browser-profile file lock.") from error
        deadline = time.monotonic() + timeout_seconds
        while True:
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise HeadlessRenderError(
                        f"Timed out waiting for another BTV render using profile {profile_dir}."
                    )
                time.sleep(0.1)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _terminate_browser(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        process.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        if process.poll() is None:
            if os.name == "posix":
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=5)


def _paeth_predictor(left: int, above: int, upper_left: int) -> int:
    estimate = left + above - upper_left
    left_distance = abs(estimate - left)
    above_distance = abs(estimate - above)
    upper_left_distance = abs(estimate - upper_left)
    if left_distance <= above_distance and left_distance <= upper_left_distance:
        return left
    if above_distance <= upper_left_distance:
        return above
    return upper_left


def _png_has_visible_content(path: pathlib.Path, required_pixels: int = 32) -> bool | None:
    with path.open("rb") as handle:
        if handle.read(8) != b"\x89PNG\r\n\x1a\n":
            return False
        width = 0
        row_bytes = 0
        bytes_per_pixel = 0
        color_type = -1
        previous_row = bytearray()
        scanline_buffer = bytearray()
        visible_pixels = 0
        decompressor = zlib.decompressobj()

        def process_scanlines() -> bool:
            nonlocal previous_row, visible_pixels
            scanline_size = row_bytes + 1
            while row_bytes > 0 and len(scanline_buffer) >= scanline_size:
                filter_type = scanline_buffer[0]
                encoded = scanline_buffer[1:scanline_size]
                del scanline_buffer[:scanline_size]
                reconstructed = bytearray(row_bytes)
                for index, value in enumerate(encoded):
                    left = reconstructed[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
                    above = previous_row[index] if previous_row else 0
                    upper_left = previous_row[index - bytes_per_pixel] if previous_row and index >= bytes_per_pixel else 0
                    if filter_type == 0:
                        predictor = 0
                    elif filter_type == 1:
                        predictor = left
                    elif filter_type == 2:
                        predictor = above
                    elif filter_type == 3:
                        predictor = (left + above) // 2
                    elif filter_type == 4:
                        predictor = _paeth_predictor(left, above, upper_left)
                    else:
                        return False
                    reconstructed[index] = (value + predictor) & 0xFF
                previous_row = reconstructed
                for offset in range(0, len(reconstructed), bytes_per_pixel):
                    if color_type == 6:
                        red, green, blue, alpha = reconstructed[offset:offset + 4]
                    elif color_type == 2:
                        red, green, blue = reconstructed[offset:offset + 3]
                        alpha = 255
                    elif color_type == 4:
                        gray, alpha = reconstructed[offset:offset + 2]
                        red = green = blue = gray
                    else:
                        gray = reconstructed[offset]
                        red = green = blue = gray
                        alpha = 255
                    if alpha >= 16 and (red < 248 or green < 248 or blue < 248):
                        visible_pixels += 1
                        if visible_pixels >= required_pixels:
                            return True
            return False

        while True:
            raw_length = handle.read(4)
            if len(raw_length) != 4:
                break
            chunk_length = struct.unpack(">I", raw_length)[0]
            chunk_type = handle.read(4)
            chunk_data = handle.read(chunk_length)
            handle.read(4)
            if len(chunk_type) != 4 or len(chunk_data) != chunk_length:
                return False
            if chunk_type == b"IHDR":
                width, _height, bit_depth, color_type, _compression, _filter, interlace = struct.unpack(
                    ">IIBBBBB", chunk_data
                )
                channel_counts = {0: 1, 2: 3, 4: 2, 6: 4}
                if bit_depth != 8 or interlace != 0 or color_type not in channel_counts:
                    return None
                bytes_per_pixel = channel_counts[color_type]
                row_bytes = width * bytes_per_pixel
                previous_row = bytearray(row_bytes)
            elif chunk_type == b"IDAT":
                pending = chunk_data
                max_output = max(64 * 1024, (row_bytes + 1) * 4)
                while pending:
                    decoded = decompressor.decompress(pending, max_output)
                    pending = decompressor.unconsumed_tail
                    scanline_buffer.extend(decoded)
                    if process_scanlines():
                        return True
            elif chunk_type == b"IEND":
                scanline_buffer.extend(decompressor.flush())
                if process_scanlines():
                    return True
                break
        return visible_pixels >= required_pixels


def _validate_output(path: pathlib.Path, export_format: str) -> tuple[int | None, int | None]:
    if not path.is_file() or path.stat().st_size == 0:
        raise HeadlessRenderError("Big Tree Viewer reported success but did not produce a non-empty output file.")
    if export_format == "png":
        header = path.read_bytes()[:24]
        if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
            raise HeadlessRenderError("Big Tree Viewer returned a file that is not a valid PNG image.")
        dimensions = struct.unpack(">II", header[16:24])
        visible_content = _png_has_visible_content(path)
        if visible_content is False:
            raise HeadlessRenderError("Big Tree Viewer returned a blank PNG image.")
        return dimensions
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        prefix = handle.read(4096).lower()
    if "<svg" not in prefix:
        raise HeadlessRenderError("Big Tree Viewer returned a file that is not a valid SVG image.")
    return None, None


def render_payload_headlessly(
    payload: dict[str, Any],
    *,
    btv_url: str,
    output_path: pathlib.Path,
    export_format: str,
    browser_path: str | None = None,
    profile_dir: pathlib.Path | None = None,
    timeout_seconds: float = 180,
    window_width: int = 1600,
    window_height: int = 1000,
) -> HeadlessRenderResult:
    if export_format not in {"png", "svg"}:
        raise HeadlessRenderError(f"Unsupported export format: {export_format}")
    if timeout_seconds <= 0:
        raise HeadlessRenderError("The render timeout must be greater than zero.")
    browser = find_chromium(browser_path)
    profile = (profile_dir or default_profile_dir()).expanduser().resolve()
    output = output_path.expanduser().resolve()
    target_url, target_origin = _target_url_and_origin(btv_url)
    state = _ServerState(
        launcher=_launcher_html(target_url, target_origin, timeout_seconds),
        payload=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        output_path=output,
        expected_format=export_format,
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler_for(state))
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, name="btv-render-server", daemon=True)
    server_thread.start()
    launcher_url = f"http://127.0.0.1:{server.server_port}/launcher"
    command = [
        str(browser),
        "--headless=new",
        "--disable-gpu",
        "--disable-popup-blocking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-extensions",
        "--disable-session-crashed-bubble",
        "--no-first-run",
        "--no-default-browser-check",
        "--noerrdialogs",
        f"--user-data-dir={profile}",
        f"--window-size={max(800, window_width)},{max(600, window_height)}",
        launcher_url,
    ]
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        command.insert(1, "--no-sandbox")
    process: subprocess.Popen[bytes] | None = None
    stderr_log = tempfile.TemporaryFile(mode="w+b")
    try:
        with _profile_lock(profile, timeout_seconds):
            process = subprocess.Popen(
                command,
                stdout=stderr_log,
                stderr=stderr_log,
                start_new_session=os.name == "posix",
            )
            deadline = time.monotonic() + timeout_seconds
            while not state.event.wait(timeout=0.2):
                return_code = process.poll()
                if return_code is not None:
                    stderr_log.seek(0)
                    detail = stderr_log.read().decode("utf-8", errors="replace").strip()[-4000:]
                    raise HeadlessRenderError(
                        f"The isolated browser exited with code {return_code} during {state.stage}."
                        + (f"\n{detail}" if detail else "")
                    )
                if time.monotonic() >= deadline:
                    raise HeadlessRenderError(
                        f"Timed out after {timeout_seconds:g} seconds while the renderer was {state.stage}."
                    )
            if state.error:
                raise HeadlessRenderError(html.unescape(state.error))
    except Exception:
        if state.received_path is not None:
            state.received_path.unlink(missing_ok=True)
        raise
    finally:
        if process is not None:
            _terminate_browser(process)
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)
        stderr_log.close()
    if state.received_path is None:
        raise HeadlessRenderError("Big Tree Viewer completed without returning an output file.")
    try:
        width, height = _validate_output(state.received_path, export_format)
        output.parent.mkdir(parents=True, exist_ok=True)
        os.replace(state.received_path, output)
    except Exception:
        state.received_path.unlink(missing_ok=True)
        raise
    if state.width is not None and width is not None and state.width != width:
        raise HeadlessRenderError("The PNG dimensions reported by Big Tree Viewer do not match the output file.")
    if state.height is not None and height is not None and state.height != height:
        raise HeadlessRenderError("The PNG dimensions reported by Big Tree Viewer do not match the output file.")
    return HeadlessRenderResult(
        output_path=output,
        browser_path=browser,
        byte_count=output.stat().st_size,
        width=width,
        height=height,
    )
