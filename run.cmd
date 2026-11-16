@echo off
setlocal
set "SCRIPT=%~dp0workbuddy-checkin.js"

rem 依次尝试：PATH 中的 node -> WorkBuddy 内置 node -> 常见安装路径
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
  exit /b 1
)

"%NODE%" "%SCRIPT%" %*
exit /b %ERRORLEVEL%
