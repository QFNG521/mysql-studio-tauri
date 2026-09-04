"""无缓存的静态文件服务，专供 tests/harness UI 验证页使用。

用法：python3 tests/harness/serve.py [port]   （默认 8899，仓库根目录为站点根）
为什么不用 `python3 -m http.server`：它发送 Last-Modified 且无 Cache-Control，
浏览器会对 dist/assets/app.js 走磁盘缓存，改完代码重新打包后页面仍加载旧产物。
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler).serve_forever()
