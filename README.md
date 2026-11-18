# WorkBuddy 每日积分签到

每天自动领取 WorkBuddy 签到积分。不需要账号密码，不需要模拟点击界面，也不需要把访问令牌交给脚本。

## 两种模式

### 客户端托管模式（默认，推荐）

签到由客户端自己完成，脚本负责"确保这件事今天会发生"，再去核对结果：

1. 读当天客户端日志 `%USERPROFILE%\.workbuddy\logs\<日期>\workbuddyMainThread*.log`
2. 若当天已有 `check-in outgoing path=/v2/billing/meter/daily-checkin ... hasError=false`，说明已签到，直接报告
3. 若没有：检查 `WorkBuddy.exe` 是否在运行；没运行就启动它（客户端启动时会自动签到）
4. 在 `--wait` 秒内轮询日志，等到签到记录出现就报告成功

令牌始终留在客户端进程内，脚本不读、不解密、不落盘。`--no-ensure-client` 可关闭自动启动，只做检查。

#### 挂机跨天的兜底（`--restart-if-idle`）

客户端只在**启动时**签到一次（今天的日志可佐证：`daily-checkin` 1 次，`checkin-activity-status` 轮询 30 多次）。所以几天不重启的客户端，第二天不会自己签。

开启该开关后，脚本会判断"陈旧进程"：当天没有任何签到记录，且当天主线程日志的首条时间在 01:00 之前（说明进程在零点前后就在跑）。命中则延迟重启客户端，靠启动动作触发签到。

两个实现约束：

- **必须用分离进程**：脚本自己跑在客户端里，直接杀进程会把这次运行一起带走，报告就发不出去。helper 用 `node -e` 起、`detached` + `unref`，等 45 秒（`--restart-delay`）后 `taskkill` 再拉起。
- **不要拼 `cmd /c "timeout /t ..."`**：从 Git Bash 之类环境继承的 PATH 会让 `timeout` 解析到 MSYS 版本，整条命令链直接失败（实测踩过）。

每天最多重启一次（状态记在 `.restart-state.json`），避免反复重启。

### 令牌模式

`--token <令牌> --user-id <uid>` 时由脚本直接调接口：

1. 调用 `POST https://{domain}/v2/billing/meter/checkin-activity-status` 查询今日状态
2. 未签到则调用 `POST https://{domain}/v2/billing/meter/daily-checkin` 领取，结果写入 `checkin.log`
3. 请求头：`Authorization: Bearer <token>` + `X-User-Id: <uid>`

token 只在进程内存中使用，不打印、不落盘；日志里的令牌与响应体会做脱敏。

## 为什么不从本地登录态里抠令牌

WorkBuddy 5.x 起，登录态以 `{"$wbEncrypted":1,"envelope":"..."}` 加密落盘（AES-256-GCM 信封），解封所需的密钥由原生模块在运行期产生、只在客户端内存里存在，磁盘上仅有 `~/.workbuddy/keyblob` 里的密文槽位。这是有意的设计——让其他程序拿不到令牌。

所以脚本不去解密它：一来那是绕过客户端刻意的凭据保护，二来把可长期使用的 Bearer 令牌塞进每天定时运行的脚本，本身就是个泄露面。脚本改成走客户端自己的通道（即上面的客户端托管模式），效果一样，且不产生额外凭据副本。

需要脚本直接调接口时，用 `--token` 自行提供令牌即可。

## 环境要求

- Node.js（无需任何第三方依赖）
- 已登录的 WorkBuddy 客户端

## 手动运行

```bat
node workbuddy-checkin.js
```

或双击 `run.cmd`。

脚本是幂等的：当天已签到会直接跳过，重复运行不会重复领取（接口本身也幂等，已签到返回 code 10001）。

### 浏览器里改脚本（可选）

`tools/` 下有一个本地编辑页面，用 Monaco（VS Code 的编辑器内核）打开 `workbuddy-checkin.js`，改完直接保存回磁盘：

```bat
cd tools\vendor && npm install     :: 首次需要，装 Monaco
cd ..\.. && node tools\editor-server.js
```

浏览器打开 `http://127.0.0.1:8787/`（或双击 `tools\edit.cmd`）。页面只监听回环地址、只认启动时指定的那一个文件；保存前会留一份 `.bak`，并在保存后跑一遍 `node --check`。

### 命令行选项

| 选项 | 作用 |
| --- | --- |
| （无参数） | 客户端托管签到：客户端没运行就拉起，签到由客户端完成 |
| `--status` | 只查今日是否已签到，不领取、不启动客户端（试跑用） |
| `--json` | 结果以 JSON 输出，便于上层程序解析 |
| `--list-clients` | 列出探测到的登录态文件及其状态，不联网 |
| `--client-exe <p>` | 指定客户端可执行文件（也可用 `WORKBUDDY_CLIENT_EXE`） |
| `--no-ensure-client` | 不自动启动客户端，只做检查 |
| `--restart-if-idle` | 客户端跨天挂机、当天未签到时，延迟重启客户端强制触发启动签到 |
| `--restart-delay <s>` | 重启前等待秒数（默认 45，留出报告时间） |
| `--dry-restart` | 只打印重启 helper 的代码，不执行（排查用） |
| `--wait <n>` | 等待签到日志出现的最长秒数（默认 120） |
| `--token <t>` `--user-id <u>` | 手动指定登录态，脚本直接调接口（也可用 `WORKBUDDY_TOKEN` / `WORKBUDDY_USER_ID`） |
| `--auth-file <f>` | 指定登录态文件路径（也可用 `WORKBUDDY_AUTH_FILE`） |
| `--debug` | 打印脱敏后的接口响应，排查契约变化 |
| `-h`, `--help` | 显示帮助 |

### 输出字段

`--json` 输出固定为：`ok` / `action` / `code` / `credits` / `client` / `message`。

| action | 含义 |
| --- | --- |
| `claimed` | 签到成功（令牌模式给出本次积分；客户端托管模式给出签到时间，积分为 `null`） |
| `already` | 今日已签到 |
| `disabled` | 签到活动当前未开启 |
| `pending` | 今日还没签到：`--status` 模式下未领取，或等待签到日志超时 |
| `restart_scheduled` | 该签未签且客户端跨天未重启，已安排延迟重启客户端 |
| `client_not_running` | 客户端未运行且未允许自动启动 |
| `auth_required` | 未安装/未登录/令牌加密或失效，需人工介入 |
| `error` | 网络或接口异常，可稍后重试 |

### 退出码

| 码 | 含义 | 上层应该做什么 |
| --- | --- | --- |
| 0 | 签到成功 / 今日已签到 / 活动未开启 | 无事可做 |
| 2 | 未检测到客户端、未登录、令牌加密或失效 | 需要人工打开 WorkBuddy |
| 1 | 网络错误、接口异常等其他失败 | 可稍后重试 |

非 `--json` 模式下，最后一行固定输出 `RESULT ok|fail action=<动作> code=<接口码>`，方便日志抓取。

### 排查

```bat
node workbuddy-checkin.js --list-clients
```

会列出每个候选登录态文件的路径与状态（`ready` 可读 / `encrypted` 已加密 / `logged-out` 未登录 / `expired` 已过期 / `absent` 不存在 / `error` 解析失败），一眼看出问题在哪一层。

接口返回结构与预期不符时，加 `--debug` 再跑一次，能看到脱敏后的原始响应。

## 由 WorkBuddy 每天自动执行

已配置为 WorkBuddy 定时任务，每天执行本脚本并把结果汇总。脚本侧无需额外改动，定时调度不在系统计划任务里。

想调整时间或停用，直接在 WorkBuddy 的自动化设置里改。

## 注意事项

- 定时任务只在开机状态执行，关机时不会补跑
- 签到接口为客户端私有接口，服务端变更可能导致脚本失效；`--debug` 可快速定位是契约变了还是登录态没了
- 登录态过期后需要打开客户端重新登录
