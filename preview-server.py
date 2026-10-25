#!/usr/bin/env python3
"""本地预览服务器：禁用缓存。

python http.server 不发 Cache-Control，浏览器会启发式缓存 JS/CSS，
改完代码刷新页面看到的还是旧版本。此服务器对所有响应加 no-store。
用法：python preview-server.py  （在 blog 目录下运行，端口 8123）
"""
import http.server
import socketserver
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 静默访问日志


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), NoCacheHandler) as httpd:
        httpd.allow_reuse_address = True
        print("preview server on http://127.0.0.1:%d (no-cache)" % PORT)
        httpd.serve_forever()
