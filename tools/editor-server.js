#!/usr/bin/env node
/**
 * 本地代码编辑器（仅监听 127.0.0.1）
 *
 * 给 workbuddy-checkin.js 提供一个可直接编辑、保存回原文件的页面。
 * 只用 Node 内置模块，无第三方依赖；只允许编辑启动时指定的那一个文件。
 *
 * 用法：
 *   node tools/editor-server.js                     # 默认编辑 ../workbuddy-checkin.js，端口 8787
 *   node tools/editor-server.js <文件> [端口]
 *
 * 安全边界：
 *   - 只绑定 127.0.0.1，不对外网开放
 *   - 只读写启动时指定的那一个文件，请求里不接受路径参数
 *   - 写入前先存上一版到 <文件>.bak，写入用临时文件 + rename，避免中途失败留半个文件
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const FILE = path.resolve(process.argv[2] || path.join(__dirname, "..", "workbuddy-checkin.js"));
const START_PORT = parseInt(process.env.PORT || process.argv[3] || "8787", 10);
const EDITOR_HTML = path.join(__dirname, "editor.html");
const BACKUP = FILE + ".bak";
// Monaco（VS Code 的编辑器内核），由 npm 装在 tools/vendor 下，只读对外托管
const MONACO_ROOT = path.join(__dirname, "vendor", "node_modules", "monaco-editor", "min");

if (!fs.existsSync(FILE)) {
  console.error(`文件不存在：${FILE}`);
  process.exit(1);
}

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 8 * 1024 * 1024) reject(new Error("内容过大"));
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/** node --check：保存后立刻告诉用户语法有没有坏 */
function syntaxCheck() {
  const r = spawnSync(process.execPath, ["--check", FILE], { encoding: "utf8", timeout: 20000 });
  if (r.status === 0) return { ok: true, output: "" };
  return { ok: false, output: (r.stderr || r.stdout || "").trim() };
}

function fileInfo() {
  const st = fs.statSync(FILE);
  return {
    path: FILE,
    name: path.basename(FILE),
    size: st.size,
    mtime: st.mtime.toISOString(),
    backup: fs.existsSync(BACKUP) ? BACKUP : null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  // Monaco 静态资源：只允许读 MONACO_ROOT 之下的文件
  if (req.method === "GET" && url.pathname.startsWith("/monaco/")) {
    const rel = decodeURIComponent(url.pathname.slice("/monaco/".length));
    const abs = path.resolve(MONACO_ROOT, rel);
    if (!abs.startsWith(MONACO_ROOT)) return send(res, 403, JSON.stringify({ ok: false, error: "forbidden" }));
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      return send(res, 404, JSON.stringify({ ok: false, error: "not found" }));
    }
    const ext = path.extname(abs).toLowerCase();
    const types = {
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".map": "application/json; charset=utf-8",
      ".ttf": "font/ttf",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".svg": "image/svg+xml",
      ".html": "text/html; charset=utf-8",
    };
    return send(res, 200, buf, types[ext] || "application/octet-stream");
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/editor.html")) {
    return send(res, 200, fs.readFileSync(EDITOR_HTML, "utf8"), "text/html; charset=utf-8");
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    const content = fs.readFileSync(FILE, "utf8");
    return send(res, 200, JSON.stringify({ ...fileInfo(), content }));
  }

  if (req.method === "GET" && url.pathname === "/api/check") {
    return send(res, 200, JSON.stringify({ ...fileInfo(), check: syntaxCheck() }));
  }

  if (req.method === "POST" && url.pathname === "/api/save") {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      return send(res, 400, JSON.stringify({ ok: false, error: `请求解析失败：${e.message}` }));
    }
    if (typeof payload.content !== "string") {
      return send(res, 400, JSON.stringify({ ok: false, error: "缺少 content 字段" }));
    }

    // 内容没变就不写，避免无意义地刷 mtime 和备份
    const current = fs.readFileSync(FILE, "utf8");
    if (current === payload.content) {
      return send(res, 200, JSON.stringify({ ok: true, unchanged: true, ...fileInfo(), check: syntaxCheck() }));
    }

    try {
      fs.writeFileSync(BACKUP, current, "utf8");
      const tmp = FILE + ".tmp-" + process.pid;
      fs.writeFileSync(tmp, payload.content, "utf8");
      fs.renameSync(tmp, FILE);
    } catch (e) {
      try { fs.unlinkSync(FILE + ".tmp-" + process.pid); } catch {}
      return send(res, 500, JSON.stringify({ ok: false, error: `写入失败：${e.message}` }));
    }

    return send(res, 200, JSON.stringify({ ok: true, ...fileInfo(), check: syntaxCheck() }));
  }

  if (req.method === "POST" && url.pathname === "/api/restore") {
    if (!fs.existsSync(BACKUP)) {
      return send(res, 400, JSON.stringify({ ok: false, error: "没有可回滚的备份" }));
    }
    try {
      fs.copyFileSync(BACKUP, FILE);
    } catch (e) {
      return send(res, 500, JSON.stringify({ ok: false, error: `回滚失败：${e.message}` }));
    }
    return send(res, 200, JSON.stringify({ ok: true, restored: true, ...fileInfo() }));
  }

  send(res, 404, JSON.stringify({ ok: false, error: "Not found" }));
});

let port = START_PORT;
let tries = 0;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && tries++ < 10) {
    server.listen(++port, "127.0.0.1");
  } else {
    console.error(`启动失败：${e.message}`);
    process.exit(1);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`编辑目标：${FILE}`);
  console.log(`已启动：http://127.0.0.1:${port}/`);
});
