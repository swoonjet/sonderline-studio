"""Minimal client for FigCraft's control port (newline-delimited JSON over 127.0.0.1).

    from fc import FC
    fc = FC(47821)
    fc.ex("node.create", {"type": "frame", "width": 100, "height": 100})   # engine.execute
    fc.call("document.inspect")                                          # control method

Start the app with: open -n -a FigCraft --args --control 47821 --automation-read-root <dir> --automation-write-root <dir>
"""
import json, os, socket, subprocess, sys, itertools


class FCError(RuntimeError):
    pass


class FC:
    def __init__(self, port=47821, timeout_ms=120000):
        self.s = socket.create_connection(("127.0.0.1", port))
        self.f = self.s.makefile("rwb")
        self.ids = itertools.count(1)
        self.timeout_ms = timeout_ms

    def call(self, method, params=None):
        msg = {"id": next(self.ids), "method": method, "params": params or {}, "timeoutMs": self.timeout_ms}
        self.f.write((json.dumps(msg) + "\n").encode())
        self.f.flush()
        reply = json.loads(self.f.readline())
        if not reply.get("ok"):
            raise FCError(f'{method} {json.dumps(params)[:300]} → {reply.get("error")}')
        return reply.get("result")

    def ex(self, command, params=None):
        return self.call("engine.execute", {"command": command, "params": params or {}})

    def batch(self, commands):
        """commands: [{"command":..., "params":..., "as": "name"}]; refer back with {"$ref": "name"}. One undo step."""
        return self.ex("command.batch", {"commands": commands})


CLI = os.path.expanduser("~/.local/opt/figcraft-cli/figcraft-cli-0.18.1-macos-universal/figcraft-cli")


class FCHeadless:
    """Same interface as FC, but drives `figcraft-cli mcp`: an in-process engine with no window, so nothing
    steals focus. Roots confine file access (read: project + fonts; write: project/figcraft)."""

    def __init__(self, project, cli=CLI):
        project = os.path.abspath(project)
        self.p = subprocess.Popen([cli, "mcp", "--automation-read-root", project,
                                   "--automation-write-root", os.path.join(project, "figcraft"),
                                   "--automation-read-root", os.path.expanduser("~/Library/Fonts")],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.ids = itertools.count(1)
        self._rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "sonderline-kit", "version": "1"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def _rpc(self, method, params):
        i = next(self.ids)
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise FCError("figcraft-cli exited")
            msg = json.loads(line)
            if msg.get("id") == i:
                if "error" in msg:
                    raise FCError(f'{method}: {msg["error"]}')
                return msg["result"]

    def tool(self, name, args):
        r = self._rpc("tools/call", {"name": name, "arguments": args})
        text = "".join(c.get("text", "") for c in r.get("content", []))
        if r.get("isError"):
            raise FCError(f"{name} {json.dumps(args)[:300]} → {text}")
        try:
            return json.loads(text)
        except ValueError:
            return text

    def call(self, method, params=None):
        params = params or {}
        if method == "document.inspect":
            r = self.tool("inspect_document", params)
            return r.get("document", r) if isinstance(r, dict) else r
        if method == "node.get":
            return self.tool("get_node", params)
        raise FCError(f"no headless mapping for {method}")

    def ex(self, command, params=None):
        return self.tool("run_command", {"command": command, "params": params or {}})

    def open(self, path):
        return self.tool("open_file", {"path": str(path)})

    def close(self):
        self.p.terminate()


if __name__ == "__main__":
    fc = FC(int(sys.argv[1]) if len(sys.argv) > 1 else 47821)
    print(json.dumps(fc.call(sys.argv[2] if len(sys.argv) > 2 else "document.inspect"), indent=1)[:4000])
