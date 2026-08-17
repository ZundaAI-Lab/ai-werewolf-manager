@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion

rem 責務: tools配下の開発用Electron実行環境を自己修復し、現行ソースと一致するRenderer生成物を確認してappをダブルクリック1回で起動する。
rem 変更ルール: ゲーム機能や配布生成を扱わない。依存物はtools\node_modules以外へ作成せず、生成物更新はtools\build\ensureCurrentBuild.jsへ委譲する。

cd /d "%~dp0"
title AI人狼マネージャー 起動

set "APP_ROOT=%CD%\app"
set "TOOLS_ROOT=%CD%\tools"
set "BUILD_CHECK_SCRIPT=%TOOLS_ROOT%\build\ensureCurrentBuild.js"
set "ELECTRON_EXE=%TOOLS_ROOT%\node_modules\electron\dist\electron.exe"
set "ELECTRON_INSTALL_SCRIPT=%TOOLS_ROOT%\node_modules\electron\install.js"

if not exist "%APP_ROOT%\package.json" (
  echo [起動エラー] app\package.jsonが見つかりません。
  echo この起動ファイルをソース版の最上位フォルダに置いてください。
  goto :failed
)
if not exist "%TOOLS_ROOT%\package-lock.json" (
  echo [起動エラー] tools\package-lock.jsonが見つかりません。
  goto :failed
)
if not exist "%BUILD_CHECK_SCRIPT%" (
  echo [起動エラー] tools\build\ensureCurrentBuild.jsが見つかりません。
  goto :failed
)

set "NODE_EXE="
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if defined ProgramFiles(x86) if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODE_EXE=%NVM_SYMLINK%\node.exe"
if not defined NODE_EXE (
  echo [起動エラー] Node.jsが見つかりません。
  echo ソース版の起動と生成物確認にはNode.jsが必要です。配布済みEXEの利用者には不要です。
  goto :failed
)

set "NPM_CMD="
for /f "delims=" %%I in ('where npm.cmd 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%I"
for %%I in ("%NODE_EXE%") do if not defined NPM_CMD if exist "%%~dpInpm.cmd" set "NPM_CMD=%%~dpInpm.cmd"
if not defined NPM_CMD (
  echo [起動エラー] npm.cmdが見つかりません。
  echo Node.jsを標準構成で再インストールしてください。
  goto :failed
)

set "ELECTRON_SKIP_BINARY_DOWNLOAD="
set "ELECTRON_OVERRIDE_DIST_PATH="
set "npm_config_ignore_scripts=false"

if exist "%ELECTRON_EXE%" goto :verify_build

if exist "%ELECTRON_INSTALL_SCRIPT%" (
  echo Electron本体が欠けているため、既存パッケージから復旧しています...
  "%NODE_EXE%" "%ELECTRON_INSTALL_SCRIPT%"
  if not errorlevel 1 if exist "%ELECTRON_EXE%" goto :verify_build
  echo 既存パッケージから復旧できなかったため、toolsの依存関係を再導入します。
  echo.
)

:install_dependencies
echo 初回起動準備を行っています。完了後は自動的にアプリが開きます。
echo.
pushd "%TOOLS_ROOT%"
call "%NPM_CMD%" ci --ignore-scripts=false --foreground-scripts --no-audit --no-fund
set "INSTALL_EXIT_CODE=%ERRORLEVEL%"
popd
if not "%INSTALL_EXIT_CODE%"=="0" (
  echo.
  echo [起動エラー] 必要ファイルの導入に失敗しました。
  echo インターネット接続とセキュリティソフトの履歴を確認してください。
  goto :failed
)

if exist "%ELECTRON_EXE%" goto :verify_build
if not exist "%ELECTRON_INSTALL_SCRIPT%" (
  echo [起動エラー] Electronパッケージの導入結果が不完全です。
  echo tools\node_modulesを削除してから、もう一度実行してください。
  goto :failed
)

echo Electron本体がまだ見つからないため、取得処理を直接実行しています...
"%NODE_EXE%" "%ELECTRON_INSTALL_SCRIPT%"
if errorlevel 1 (
  echo [起動エラー] Electron本体の取得に失敗しました。
  goto :failed
)
if not exist "%ELECTRON_EXE%" (
  echo [起動エラー] Electron本体を確認できませんでした。
  goto :failed
)

:verify_build
echo 現行ソースとRenderer生成物の一致を確認しています...
"%NODE_EXE%" "%BUILD_CHECK_SCRIPT%"
if errorlevel 1 (
  echo [起動エラー] Renderer生成物を現行ソースへ更新できませんでした。
  goto :failed
)

:launch
start "" "%ELECTRON_EXE%" "%APP_ROOT%"
if errorlevel 1 (
  echo [起動エラー] アプリを起動できませんでした。
  goto :failed
)
exit /b 0

:failed
echo.
pause
exit /b 1
