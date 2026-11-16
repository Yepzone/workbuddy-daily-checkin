#!/usr/bin/env node
/**
 * WorkBuddy 每日积分签到
 *
 * 流程：发现本地客户端登录态 -> 取访问令牌 -> 查签到状态 -> 未签到则领取 -> 写日志
 * 令牌只在进程内存中使用，不打印、不落盘。
 *
 * 两种工作模式：
 *   客户端托管模式（默认）：签到由客户端自己完成。脚本检查客户端是否在运行，没运行就拉起来，
 *                          然后从客户端日志确认当天签到已发生。令牌始终留在客户端内，脚本不读取。
 *   令牌模式：--token/--user-id 由脚本直接调接口（需自行提供有效令牌）。
 *
 * 用法：
 *   node workbuddy-checkin.js               客户端托管模式签到（幂等，当天已签到直接跳过）
 *   node workbuddy-checkin.js --status      只查状态，不领取、不启动客户端
 *   node workbuddy-checkin.js --json        结果以 JSON 输出，便于上层程序解析
 *   node workbuddy-checkin.js --token T --user-id U   手动指定登录态，脚本直接调接口
 *   node workbuddy-checkin.js --list-clients          列出检测到的客户端和登录态情况
 *   node workbuddy-checkin.js --client-exe P          指定客户端可执行文件路径
 *   node workbuddy-checkin.js --no-ensure-client      不自动启动客户端（只检查）
 *   node workbuddy-checkin.js --wait N                等待签到日志出现的最长秒数（默认 120）
 *   node workbuddy-checkin.js --debug                 额外打印脱敏后的接口响应
 *
 * 退出码：0 成功/已完成；2 需要人工介入（未安装、未登录、登录态失效）；1 其他失败
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");

const DEFAULT_DOMAIN = "www.workbuddy.cn";
const STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
const CLAIM_PATH = "/v2/billing/meter/daily-checkin";

const LOG_FILE = path.join(__dirname, "checkin.log");

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const report = { ok: false, action: "none", code: null, credits: null, client: null, message: "" };

function log(msg) {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${msg}`;
  if (!opts.json) console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + os.EOL, "utf8");
  } catch {}
}

/** 统一收尾：写日志、按需输出 JSON、设退出码 */
function finish(exitCode, action, message, extra) {
  Object.assign(report, { ok: exitCode === 0, action, message }, extra || {});
  log(message);
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    console.log(`RESULT ${report.ok ? "ok" : "fail"} action=${action} code=${report.code ?? "-"}`);
  }
  process.exitCode = exitCode;
}

function debug(title, obj) {
  if (!opts.debug) return;
  const text = typeof obj === "string" ? obj : JSON.stringify(obj);
  console.log(`[debug] ${title}: ${redact(text).slice(0, 600)}`);
}

/** 抹掉可能出现的令牌/手机号等敏感片段 */
function redact(s) {
  return String(s)
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "eyJ***")
    .replace(/("(?:accessToken|token|refreshToken)"\s*:\s*")[^"]+/g, "$1***");
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    statusOnly: false,
    json: false,
    debug: false,
    help: false,
    listClients: false,
    token: process.env.WORKBUDDY_TOKEN || "",
    userId: process.env.WORKBUDDY_USER_ID || "",
    authFile: process.env.WORKBUDDY_AUTH_FILE || "",
    clientExe: process.env.WORKBUDDY_CLIENT_EXE || "",
    ensureClient: true,
    waitSeconds: 120,
    restartIfIdle: false,
    restartDelay: 45,
    dryRestart: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--status" || a === "--dry-run") o.statusOnly = true;
    else if (a === "--json") o.json = true;
    else if (a === "--debug") o.debug = true;
    else if (a === "--list-clients") o.listClients = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--no-ensure-client") o.ensureClient = false;
    else if (a === "--ensure-client") o.ensureClient = true;
    else if (a === "--dry-restart") o.dryRestart = true;
    else if (a === "--restart-if-idle") o.restartIfIdle = true;
    else if (a === "--restart-delay") o.restartDelay = Math.max(10, parseInt(argv[++i], 10) || 45);
    else if (a === "--token") o.token = argv[++i] || "";
    else if (a === "--user-id") o.userId = argv[++i] || "";
    else if (a === "--auth-file") o.authFile = argv[++i] || "";
    else if (a === "--client-exe") o.clientExe = argv[++i] || "";
    else if (a === "--wait") o.waitSeconds = Math.max(5, parseInt(argv[++i], 10) || 120);
  }
  return o;
}

function printHelp() {
  console.log(`WorkBuddy 每日积分签到

用法：node workbuddy-checkin.js [选项]

  （无参数）        客户端托管签到：客户端没运行就拉起，签到由客户端完成
  --status          只查状态，不领取、不启动客户端
  --json            结果以 JSON 输出
  --list-clients    列出检测到的客户端登录态情况，不联网
  --token <t>       手动指定访问令牌（也可用环境变量 WORKBUDDY_TOKEN）
  --user-id <u>     配合 --token 使用（也可用环境变量 WORKBUDDY_USER_ID）
  --auth-file <f>   指定登录态文件路径（也可用环境变量 WORKBUDDY_AUTH_FILE）
  --client-exe <p>  指定客户端可执行文件（也可用环境变量 WORKBUDDY_CLIENT_EXE）
  --no-ensure-client 不自动启动客户端，只检查
  --restart-if-idle 客户端跨天挂机未签到时，延迟重启客户端强制触发启动签到
  --restart-delay <s> 重启前等待秒数（默认 45，留出报告时间）
  --dry-restart     只打印重启 helper 的代码，不执行（排查用）
  --wait <n>        等待签到日志出现的最长秒数（默认 120）
  --debug           打印脱敏后的接口响应，便于排查
  -h, --help        显示本帮助

退出码 0=成功/已完成  2=需要人工介入  1=其他失败`);
}

// ---------------------------------------------------------------------------
// 登录态发现
// ---------------------------------------------------------------------------

/** 各平台客户端写出的登录态文件候选位置 */
function candidateAuthFiles() {
  const home = os.homedir();
  const localApp = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const list = [];

  if (opts.authFile) list.push(opts.authFile);

  if (process.platform === "win32") {
    for (const n of ["CodeBuddyExtension", "WorkBuddy", "CodeBuddy"]) {
      list.push(path.join(localApp, n, "Data", "Public", "auth", "workbuddy-desktop.info"));
      list.push(path.join(localApp, n, "Data", "Public", "auth", "codebuddy-desktop.info"));
    }
  } else if (process.platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    for (const n of ["CodeBuddyExtension", "WorkBuddy", "CodeBuddy"]) {
      list.push(path.join(base, n, "Data", "Public", "auth", "workbuddy-desktop.info"));
    }
  } else {
    const base = path.join(home, ".local", "share");
    for (const n of ["CodeBuddyExtension", "WorkBuddy", "CodeBuddy"]) {
      list.push(path.join(base, n, "Data", "Public", "auth", "workbuddy-desktop.info"));
    }
  }
  return [...new Set(list)];
}

function isEncryptedWrapper(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && v.$wbEncrypted === 1 && typeof v.envelope === "string";
}

/** 读取单个登录态文件，返回 { state, detail, auth? } */
function readAuthFile(file) {
  let raw;
  try {
    if (!fs.statSync(file).isFile()) throw new Error("不是文件");
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { state: "absent", detail: "文件不存在" };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { state: "error", detail: `JSON 解析失败：${e.message}` };
  }

  const auth = data.auth || {};
  const account = data.account || {};
  const tokenField = auth.accessToken;

  if (!tokenField) return { state: "logged-out", detail: "无 accessToken 字段" };

  const userId = account.uid || account.uniqueUserId || auth.uid || "";
  const domain = auth.domain || DEFAULT_DOMAIN;
  const expiresAt = typeof auth.expiresAt === "number" ? auth.expiresAt : null;

  if (typeof tokenField !== "string") {
    if (isEncryptedWrapper(tokenField)) {
      const hint = expiresAt && expiresAt < Date.now() ? "，且登录态已过期" : "";
      return {
        state: "encrypted",
        detail: `登录态已加密存储（$wbEncrypted 信封，需客户端解密）${hint}`,
        meta: { userId, domain, expiresAt },
      };
    }
    return { state: "error", detail: "accessToken 字段格式无法识别", meta: { userId, domain } };
  }

  if (expiresAt && expiresAt < Date.now()) {
    return {
      state: "expired",
      detail: `登录态已于 ${new Date(expiresAt).toLocaleString("zh-CN", { hour12: false })} 过期`,
      meta: { userId, domain, expiresAt },
    };
  }

  if (!userId) return { state: "no-token", detail: "登录态中缺少用户标识（X-User-Id）", meta: { domain } };

  return { state: "ready", detail: "登录态可读", auth: { token: tokenField, userId, domain, app: path.basename(path.dirname(path.dirname(path.dirname(file)))) } };
}

function scanClients() {
  const results = [];
  let auth = null;
  const seen = new Set();

  for (const file of candidateAuthFiles()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const r = readAuthFile(file);
    const app = path.basename(path.dirname(path.dirname(path.dirname(path.dirname(file)))));
    results.push({ app, path: file, state: r.state, detail: r.detail });
    if (r.state === "ready" && !auth) auth = r.auth;
  }
  return { auth, results };
}

function loadAuth() {
  if (opts.token) {
    if (!opts.userId) {
      const err = new Error("手动指定令牌时必须同时提供 --user-id（或 WORKBUDDY_USER_ID）。");
      err.needsUser = true;
      throw err;
    }
    return { token: opts.token, userId: opts.userId, domain: DEFAULT_DOMAIN, app: "手动指定" };
  }

  const { auth, results } = scanClients();
  if (auth) return auth;

  const present = results.filter((r) => r.state !== "absent");
  if (!present.length) {
    const err = new Error("未检测到 WorkBuddy 客户端登录态。请先安装并登录 WorkBuddy。");
    err.needsUser = true;
    throw err;
  }

  const encrypted = present.filter((r) => r.state === "encrypted");
  if (encrypted.length) {
    const detail = present.map((r) => `${r.app}: ${r.detail}`).join("；");
    const err = new Error(
      `WorkBuddy 客户端把登录态加密保存在本地（${detail}），脚本无法离线解密。` +
        `两种可行方式：①直接在客户端里完成签到（客户端启动时会自动签到）；` +
        `②用 --token 传入访问令牌，并用 --user-id 指定用户标识。`
    );
    err.needsUser = true;
    throw err;
  }

  const detail = present.map((r) => `${r.app}: ${r.detail}`).join("；");
  const err = new Error(`未取得可用登录态（${detail}）。请打开 WorkBuddy 客户端重新登录。`);
  err.needsUser = true;
  throw err;
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

/** 调用签到接口（网络错误重试一次） */
function callApi(domain, apiPath, token, userId, retry = 1) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: domain,
        path: apiPath,
        method: "POST",
        timeout: 30000,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "X-User-Id": userId,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", (e) => {
      if (retry > 0) setTimeout(() => callApi(domain, apiPath, token, userId, retry - 1).then(resolve, reject), 3000);
      else reject(e);
    });
    req.end("{}");
  });
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

/** 从各种可能的响应形态里取“今日可得/已得积分” */
function pickCredit(data) {
  const d = data && typeof data === "object" ? data.data || data : {};
  const cands = [d.credit, d.credits, d.reward, d.dailyCredit, d.baseCredit, data.credit, data.credits];
  for (const c of cands) if (typeof c === "number") return c;
  return null;
}

/** 判断状态响应里的“今日是否已签到” */
function pickCheckedIn(data) {
  const d = data && typeof data === "object" ? data.data || data : {};
  for (const k of ["checkedIn", "checked", "todayCheckedIn", "hasCheckedIn", "signed", "signedIn"]) {
    if (typeof d[k] === "boolean") return d[k];
  }
  return null;
}

/** 活动是否开启（部分响应会明确给出） */
function pickEnabled(data) {
  const d = data && typeof data === "object" ? data.data || data : {};
  for (const k of ["enable", "enabled", "activityEnabled", "isOpen"]) {
    if (typeof d[k] === "boolean") return d[k];
  }
  return null;
}

/** 判断响应是否表示“今天已签到” */
function looksAlreadyDone(data) {
  const code = data.code;
  const msg = String(data.message || data.msg || data.error || "");
  if (code === 10001) return true;
  return /已签到|already|重复/.test(msg);
}

function isAuthError(status, data) {
  if (status === 401 || status === 403) return true;
  const code = data.code;
  return code === 1001 || code === 401;
}

// ---------------------------------------------------------------------------
// 客户端托管模式
//
// 令牌由客户端在运行期解密、只存在其进程内存中，磁盘上仅留密文，脚本不去解密。
// 因此改为：确保客户端在运行（客户端启动时会自动签到），再从客户端日志确认签到已发生。
// ---------------------------------------------------------------------------

const { execFileSync, spawn } = require("child_process");

const LOG_ROOT = path.join(os.homedir(), ".workbuddy", "logs");
const CLIENT_IMAGE = "WorkBuddy.exe";

function clientExeCandidates() {
  const localApp = process.env.LOCALAPPDATA || "";
  const progFiles = process.env.ProgramFiles || "C:\\Program Files";
  const progFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return [
    opts.clientExe,
    path.join(progFiles, "WorkBuddy", CLIENT_IMAGE),
    path.join(progFilesX86, "WorkBuddy", CLIENT_IMAGE),
    localApp && path.join(localApp, "Programs", "WorkBuddy", CLIENT_IMAGE),
    localApp && path.join(localApp, "WorkBuddy", CLIENT_IMAGE),
    "D:\\workbuddy\\WorkBuddy.exe",
  ].filter(Boolean);
}

function findClientExe() {
  for (const p of clientExeCandidates()) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

function isClientRunning() {
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${CLIENT_IMAGE}`, "/NH"], {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    });
    return new RegExp(CLIENT_IMAGE.replace(".", "\\."), "i").test(out);
  } catch {
    return false;
  }
}

function startClient(exe) {
  const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return true;
}

function todayLogDir(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return path.join(LOG_ROOT, `${y}-${m}-${day}`);
}

/** 在当天客户端主线程日志里找“已发起签到”的记录（只认 daily-checkin，不含状态轮询） */
function latestCheckinAttempt() {
  const dir = todayLogDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^workbuddyMainThread.*\.log$/i.test(f));
  } catch {
    return null;
  }
  let best = null;
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const re =
      /\[(\d{4}\/\d{2}\/\d{2}) (\d{2}:\d{2}:\d{2})\.\d+\][^\n]*check-in outgoing path=\/v2\/billing\/meter\/daily-checkin[^\n]*hasToken=(\w+)[^\n]*hasError=(\w+)/g;
    let m;
    while ((m = re.exec(text))) {
      const at = `${m[1]} ${m[2]}`;
      if (!best || at > best.at) best = { at, time: m[2], hasToken: m[3] === "true", hasError: m[4] === "true" };
    }
  }
  return best;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE_FILE = path.join(__dirname, ".restart-state.json");

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function alreadyRestartedToday() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).date === todayKey();
  } catch {
    return false;
  }
}

function markRestartedToday() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ date: todayKey(), at: new Date().toISOString() }), "utf8");
  } catch {}
}

/** 当天主线程日志最早一条记录的时间（近似反映客户端本次进程何时起来） */
function earliestLogTimeToday() {
  const dir = todayLogDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /^workbuddyMainThread.*\.log$/i.test(f));
  } catch {
    return null;
  }
  let earliest = null;
  for (const f of files) {
    let head;
    try {
      const fd = fs.openSync(path.join(dir, f), "r");
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.subarray(0, n).toString("utf8");
    } catch {
      continue;
    }
    const m = head.match(/\[(\d{4}\/\d{2}\/\d{2}) (\d{2}:\d{2}:\d{2})/);
    if (m && (!earliest || m[2] < earliest)) earliest = m[2];
  }
  return earliest;
}

/**
 * 客户端整天挂机不重启时不会跨天签到。此判断用于识别这种“陈旧进程”：
 * 当天没有任何签到记录，且日志显示进程当天零点前后就在跑。
 */
function clientLooksStale() {
  const t = earliestLogTimeToday();
  return !!t && t < "01:00:00";
}

/**
 * 延迟重启客户端。必须用分离进程：脚本本身跑在客户端里，
 * 直接杀进程会把这次运行一起带走，导致报告发不出去。
 *
 * 不拼 cmd 命令串——从 Git Bash 之类环境继承的 PATH 会让 `timeout` 解析到 MSYS 版本而失败。
 * 改用 node 起一个 detached helper 自己计时，再 taskkill + 重新拉起。
 */
function buildRestartHelperCode(exe, delaySeconds) {
  const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  return `
const { execFileSync, spawn } = require("child_process");
setTimeout(() => {
  try { execFileSync(${JSON.stringify(taskkill)}, ["/F", "/IM", ${JSON.stringify(CLIENT_IMAGE)}], { stdio: "ignore" }); } catch {}
  setTimeout(() => {
    try {
      const c = spawn(${JSON.stringify(exe)}, [], { detached: true, stdio: "ignore" });
      c.unref();
    } catch {}
  }, 5000);
}, ${Math.round(delaySeconds * 1000)});
`;
}

function scheduleClientRestart(exe, delaySeconds) {
  const child = spawn(process.execPath, ["-e", buildRestartHelperCode(exe, delaySeconds)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function runClientMode() {
  const exe = findClientExe();
  if (!exe) {
    const err = new Error(
      "未找到 WorkBuddy 客户端可执行文件。请用 --client-exe 指定路径（或设置 WORKBUDDY_CLIENT_EXE）。"
    );
    err.needsUser = true;
    throw err;
  }
  report.client = "WorkBuddy 客户端";

  const found = latestCheckinAttempt();
  if (found && !found.hasError) {
    return finish(0, "already", `今日已签到，客户端于 ${found.time} 完成签到（客户端：WorkBuddy 客户端）。`, {
      code: 0,
    });
  }
  if (opts.statusOnly) {
    return finish(0, "pending", `今日尚未签到（客户端：WorkBuddy 客户端）。`, { code: 0 });
  }

  const wasRunning = isClientRunning();
  if (!wasRunning) {
    if (!opts.ensureClient) {
      return finish(2, "client_not_running", "WorkBuddy 客户端未运行，签到由客户端完成，请先启动客户端。");
    }
    startClient(exe);
    log(`已启动客户端：${exe}`);
  }

  // 陈旧进程（跨天挂着没重启）不会自己再签，等日志没有意义：直接重启客户端触发启动签到
  if (wasRunning && opts.restartIfIdle && !alreadyRestartedToday() && clientLooksStale()) {
    if (opts.statusOnly) {
      return finish(0, "pending", "今日尚未签到，且客户端已跨天挂着未重启，建议重启客户端。", { code: 0 });
    }
    scheduleClientRestart(exe, opts.restartDelay);
    markRestartedToday();
    return finish(
      0,
      "restart_scheduled",
      `今日未见签到记录，且客户端已跨天挂着未重启。将在 ${opts.restartDelay} 秒后重启客户端，重启后客户端会自动完成签到。`,
      { code: 0 }
    );
  }

  const deadline = Date.now() + opts.waitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const a = latestCheckinAttempt();
    if (a && !a.hasError) {
      const how = wasRunning ? "客户端已完成签到" : "拉起客户端后已完成签到";
      return finish(0, "claimed", `${how}（${a.time}，客户端：WorkBuddy 客户端）。`, { code: 0 });
    }
  }

  return finish(
    2,
    "pending",
    wasRunning
      ? `客户端已在运行，但 ${opts.waitSeconds} 秒内未见新的签到记录。可能今天已由客户端更早完成（日志未留存），或签到活动未开启。`
      : `已启动客户端，但 ${opts.waitSeconds} 秒内未见签到记录，请打开客户端查看登录状态。`
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  if (opts.help) return printHelp();

  if (opts.dryRestart) {
    // 只打印重启 helper 的代码，不执行，便于校验与排查
    const exe = findClientExe() || "<未找到客户端>";
    process.stdout.write(buildRestartHelperCode(exe, opts.restartDelay));
    return;
  }

  if (opts.listClients) {
    const { auth, results } = scanClients();
    if (opts.json) {
      process.stdout.write(JSON.stringify({ available: !!auth, clients: results }, null, 2) + "\n");
      return;
    }
    if (!results.length) console.log("未检测到任何 WorkBuddy 客户端登录态文件。");
    for (const r of results) console.log(`- ${r.app}  [${r.state}]  ${r.path}\n    ${r.detail}`);
    console.log(auth ? `\n可用登录态：${auth.app}` : "\n无可用登录态。");
    return;
  }

  // 没有手动提供令牌时走客户端托管模式；令牌只在客户端内部使用
  if (!opts.token) {
    try {
      return await runClientMode();
    } catch (e) {
      return finish(2, "auth_required", e.message);
    }
  }

  let auth;
  try {
    auth = loadAuth();
  } catch (e) {
    return finish(2, "auth_required", e.message);
  }

  const { token, userId, domain, app } = auth;
  report.client = app;
  const api = (p) => callApi(domain, p, token, userId);

  // 1) 查状态
  let status;
  try {
    const res = await api(STATUS_PATH);
    const data = parseJson(res.body);
    debug(`status HTTP ${res.status}`, res.body);

    if (isAuthError(res.status, data)) {
      return finish(2, "auth_required", `登录态已失效（HTTP ${res.status}${data.code ? `, code=${data.code}` : ""}），请打开 WorkBuddy 客户端重新登录。`);
    }
    if (res.status !== 200) {
      return finish(1, "error", `查询签到状态失败（HTTP ${res.status}）：${redact(res.body).slice(0, 200)}`);
    }
    status = data;
  } catch (e) {
    return finish(1, "error", `查询签到状态失败：${e.message}`);
  }

  const credit = pickCredit(status);
  const checkedIn = pickCheckedIn(status);
  const enabled = pickEnabled(status);

  if (checkedIn === true) {
    return finish(0, "already", `今日已签到，今日可得积分 ${credit ?? "-"}（客户端：${app}）。`, {
      code: 0,
      credits: credit,
    });
  }
  if (enabled === false) {
    return finish(0, "disabled", "签到活动当前未开启，跳过。", { credits: credit });
  }
  if (opts.statusOnly) {
    return finish(0, "pending", `今日未签到，可得积分 ${credit ?? "-"}（客户端：${app}）。`, {
      code: 0,
      credits: credit,
    });
  }

  // 2) 领取
  let res;
  try {
    res = await api(CLAIM_PATH);
  } catch (e) {
    return finish(1, "error", `签到请求失败：${e.message}`);
  }

  const data = parseJson(res.body);
  debug(`claim HTTP ${res.status}`, res.body);

  if (isAuthError(res.status, data)) {
    return finish(2, "auth_required", `签到失败：登录态已失效（HTTP ${res.status}），请打开 WorkBuddy 客户端重新登录。`);
  }

  if (looksAlreadyDone(data)) {
    const c = pickCredit(data) ?? credit;
    return finish(0, "already", `今日已签到，今日可得积分 ${c ?? "-"}（客户端：${app}）。`, { code: data.code ?? null, credits: c });
  }

  if (res.status === 200 && (data.code === 0 || data.code === undefined || data.code === 200)) {
    const gained = pickCredit(data);
    if (gained === null && data.code === undefined) {
      return finish(1, "error", `签到返回无法识别：${redact(res.body).slice(0, 200)}（可加 --debug 查看完整响应）`);
    }
    return finish(0, "claimed", `签到成功，获得积分 ${gained ?? "-"}（客户端：${app}）。`, {
      code: data.code ?? 0,
      credits: gained,
    });
  }

  const msg = `签到未成功（HTTP ${res.status}, code=${data.code ?? "-"}, msg=${data.message || data.msg || ""}）。`;
  return finish(1, "error", msg, { code: data.code ?? null });
}

main().catch((e) => finish(1, "error", `未捕获异常：${e.message}`));
