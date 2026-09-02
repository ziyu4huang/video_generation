#!/usr/bin/env python3
"""Static file server with HTTP Range support — `python3 serve.py [port] [dir]`.

Drop-in replacement for `python3 -m http.server`. Plain http.server ignores
the Range header (returns 200 + the whole file), which breaks <video> seek
bars in Chromium: the player cannot fetch the byte range it jumps to, so
dragging progress silently fails. This handler answers `bytes=a-b` with 206
and exactly the requested slice.

Usage (from the repo root):
  python/venv/bin/python bun-apps/zcode-generate-slide-video/scripts/serve.py 8123
"""
import http.server
import os
import re
import sys

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")


class RangeFileHandler(http.server.SimpleHTTPRequestHandler):
    _range: tuple[int, int] | None = None

    def send_head(self):
        """Return a positioned file object for range GETs, else default behavior."""
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().send_head()
        header = self.headers.get("Range", "")
        match = RANGE_RE.match(header.strip())
        if not match:
            self._range = None
            return super().send_head()
        size = os.path.getsize(path)
        start = int(match.group(1) or 0)
        end = int(match.group(2) or size - 1)
        end = min(end, size - 1)
        if start > end or start >= size:
            self.send_error(416, "Requested Range Not Satisfiable")
            return None
        self._range = (start, end)
        f = open(path, "rb")  # noqa: SIM115 — handler closes it after copyfile
        try:
            f.seek(start)
            self.send_response(206)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
        except Exception:
            f.close()
            raise
        return f

    def copyfile(self, source, output_file):
        if self._range is None:
            return super().copyfile(source, output_file)
        start, end = self._range
        remaining = end - start + 1
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            output_file.write(chunk)
            remaining -= len(chunk)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    directory = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    handler = lambda *a, **kw: RangeFileHandler(*a, directory=directory, **kw)  # noqa: E731
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"serving {directory} on http://127.0.0.1:{port} (Range supported)")
    server.serve_forever()


if __name__ == "__main__":
    main()
