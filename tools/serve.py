"""Local web server for the Studios, with HTTP range requests (Python's http.server has none, and without them
Chrome can't seek the footage clips, so video exports would freeze).

    python tools/serve.py [port]        # then open http://localhost:8000/studio/, /video/ or /deck/
"""
import functools
import http.server
import os
import pathlib
import re
import sys
import threading

ROOT = pathlib.Path(__file__).resolve().parent.parent


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_head(self):
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start = int(m[1]) if m[1] else max(0, size - int(m[2] or 0))
        end = min(int(m[2]), size - 1) if m[1] and m[2] else size - 1
        if start >= size:
            self.send_error(416)
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        n = getattr(self, "_remaining", None)
        if n is None:
            return super().copyfile(source, outputfile)
        while n > 0:
            chunk = source.read(min(65536, n))
            if not chunk:
                break
            outputfile.write(chunk)
            n -= len(chunk)
        self._remaining = None

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass  # browsers cancel media range requests mid-stream all the time

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()


def serve(port=0):
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(RangeHandler, directory=str(ROOT)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(RangeHandler, directory=str(ROOT)))
    print(f"Serving {ROOT} at http://localhost:{port}/  (Studios: /studio/  /video/  /deck/)")
    httpd.serve_forever()
