@echo off
rem ---------------------------------------------------------------------------
rem  Publish dsh-plugin-community to the npm registry.
rem
rem  Why this script exists: on this machine `npm`, `pnpm` and even `node` are
rem  NOT on PATH. The only Node.js install is the one DSH ships with, and the
rem  only publisher available is pnpm (there is no npm CLI in that runtime).
rem  So "npm publish" cannot be typed directly -- the paths have to be spelled
rem  out. That is all this file does.
rem
rem  Keep this file ASCII-only on purpose. A .cmd with non-ASCII text gets
rem  mangled by the GBK console and the mojibake ends up in the commands.
rem  Delayed expansion is deliberately OFF: with it on, every literal "!" in
rem  the status lines below would be swallowed as a variable delimiter.
rem
rem  Usage:  scripts\publish.cmd            (full: checks + tests + publish)
rem          scripts\publish.cmd check      (checks + tests only, no publish)
rem          scripts\publish.cmd login      (log in to the registry)
rem          scripts\publish.cmd whoami     (show the signed-in account)
rem ---------------------------------------------------------------------------
setlocal
set "SCRIPT_DIR=%~dp0"
set "PLUGIN_DIR=%SCRIPT_DIR%.."
pushd "%PLUGIN_DIR%" || exit /b 1

rem ------------------------------- locate node -------------------------------
set "NODE_EXE="
if defined DSH_NODE if exist "%DSH_NODE%" set "NODE_EXE=%DSH_NODE%"
if not defined NODE_EXE (
  for %%P in (
    "C:\Users\29427\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  ) do if exist %%P set "NODE_EXE=%%~P"
)
if not defined NODE_EXE (
  for /f "delims=" %%P in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%P"
)
if not defined NODE_EXE (
  echo [x] Could not find node.exe.
  echo     Set DSH_NODE to its full path, e.g.:
  echo       set DSH_NODE=C:\path\to\node.exe
  exit /b 1
)

rem ------------------------------- locate pnpm -------------------------------
set "PNPM_MJS="
if defined DSH_PNPM if exist "%DSH_PNPM%" set "PNPM_MJS=%DSH_PNPM%"
if not defined PNPM_MJS (
  for %%P in (
    "C:\Users\29427\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
  ) do if exist %%P set "PNPM_MJS=%%~P"
)
if not defined PNPM_MJS (
  echo [x] Could not find pnpm.mjs.
  echo     Set DSH_PNPM to its full path, e.g.:
  echo       set DSH_PNPM=C:\path\to\pnpm\bin\pnpm.mjs
  exit /b 1
)

echo node : %NODE_EXE%
echo pnpm : %PNPM_MJS%
echo dir  : %CD%
echo.

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=publish"

if /i "%ACTION%"=="login"  goto :login
if /i "%ACTION%"=="whoami" goto :whoami
if /i "%ACTION%"=="check"  goto :check
if /i "%ACTION%"=="publish" goto :publish
echo [x] Unknown action: %ACTION%
echo     Use: check ^| publish ^| login ^| whoami
popd & exit /b 1

rem ------------------------------- checks -----------------------------------
:check
echo === 1/2 pack-check (recomputes what npm would pack) ===
"%NODE_EXE%" "%SCRIPT_DIR%pack-check.mjs"
if errorlevel 1 (
  echo.
  echo [x] pack-check failed. Fix the problems above before publishing.
  popd & exit /b 1
)
echo.
echo === 2/2 tests ===
"%NODE_EXE%" --test "test/*.test.mjs"
if errorlevel 1 (
  echo.
  echo [x] Tests failed. Publishing a broken build is how you get a bad version
  echo     on the registry, and a version number can never be reused.
  popd & exit /b 1
)
echo.
echo [ok] checks passed.
popd & exit /b 0

rem ------------------------------- publish ----------------------------------
:publish
call :runcheck
if errorlevel 1 (popd & exit /b 1)

echo.
echo === checking the signed-in account ===
"%NODE_EXE%" "%PNPM_MJS%" whoami >nul 2>&1
if errorlevel 1 (
  echo [!] Not logged in to the npm registry yet.
  echo.
  echo     Run this once, in a NORMAL terminal window ^(it needs a real
  echo     interactive TTY, so it cannot run from inside a chat tool^):
  echo.
  echo         "%SCRIPT_DIR%publish.cmd" login
  echo.
  echo     It will ask for your npm username, password, and a one-time code
  echo     from your authenticator if you have 2FA enabled.
  echo.
  echo     Alternative that avoids the prompt entirely: create an access token
  echo     at https://www.npmjs.com/settings/~/tokens and put this line in
  echo     "%%USERPROFILE%%\.npmrc" ^(never commit that file^):
  echo.
  echo         //registry.npmjs.org/:_authToken=npm_YOUR_TOKEN_HERE
  echo.
  popd & exit /b 2
)
for /f "delims=" %%U in ('"%NODE_EXE%" "%PNPM_MJS%" whoami 2^>nul') do echo     signed in as: %%U

echo.
echo === git working tree ===
git status --porcelain >"%TEMP%\dcom-git.txt" 2>nul
for %%F in ("%TEMP%\dcom-git.txt") do if %%~zF GTR 0 (
  echo [!] The working tree has uncommitted changes:
  type "%TEMP%\dcom-git.txt"
  echo.
  echo     pnpm refuses to publish from a dirty tree by default. Either commit
  echo     the changes, or re-run with --no-git-checks if you know it is fine.
  popd & exit /b 1
)
del "%TEMP%\dcom-git.txt" 2>nul
echo     clean.

echo.
echo === publishing dsh-plugin-community to https://registry.npmjs.org/ ===
echo     This is irreversible for this version number.
echo.
"%NODE_EXE%" "%PNPM_MJS%" publish --access public
if errorlevel 1 (
  echo.
  echo [x] Publish failed. Common causes:
  echo       - EOTP          wrong / expired one-time code
  echo       - E409 / E403   this version already exists ^(bump the version^)
  echo       - E404          not authenticated ^(see the login step above^)
  popd & exit /b 1
)
echo.
echo [ok] published. Verify with:
echo        "%SCRIPT_DIR%publish.cmd" whoami
echo        https://www.npmjs.com/package/dsh-plugin-community
popd & exit /b 0

rem ------------------------------- sub-actions ------------------------------
:login
echo Logging in to https://registry.npmjs.org/
echo ^(needs a real interactive terminal -- do not run this from a chat tool^)
echo.
"%NODE_EXE%" "%PNPM_MJS%" login
popd & exit /b %errorlevel%

:whoami
"%NODE_EXE%" "%PNPM_MJS%" whoami
popd & exit /b %errorlevel%

:runcheck
rem NOTE: no pushd/popd here -- this is a `call`ed subroutine, the caller owns
rem the working directory. Popping here would pop the caller's pushd too.
"%NODE_EXE%" "%SCRIPT_DIR%pack-check.mjs" || exit /b 1
"%NODE_EXE%" --test "test/*.test.mjs" >"%TEMP%\dcom-test.txt" 2>&1
if errorlevel 1 (
  echo [x] Tests failed:
  findstr /R /C:"^not ok" "%TEMP%\dcom-test.txt"
  del "%TEMP%\dcom-test.txt" 2>nul
  exit /b 1
)
findstr /R /C:"^# tests " /C:"^# pass " /C:"^# fail " "%TEMP%\dcom-test.txt"
del "%TEMP%\dcom-test.txt" 2>nul
exit /b 0
