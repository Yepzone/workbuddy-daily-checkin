@echo off
setlocal
rem 双击启动本地编辑器：默认编辑上级目录的 workbuddy-checkin.js
rem 打开后把控制台里的 http://127.0.0.1:8787/ 地址粘到浏览器，或在 WorkBuddy 右侧面板打开

set "SERVER=%~dp0editor-server.js"
set "NODE="
for %%I in (node.exe) do set "NODE=%%~$PATH:I"
if not defined NODE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions" (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%D\node.exe" set "NODE=%%D\node.exe"
  )
)
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
  echo [ERROR] 未找到 node.exe，请先安装 Node.js 或把它加入 PATH。
  pause
  exit /b 1
)

"%NODE%" "%SERVER%" %*
pause
