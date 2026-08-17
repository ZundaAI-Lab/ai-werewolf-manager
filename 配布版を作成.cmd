@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title AI人狼マネージャー 配布版作成

echo ========================================
echo AI人狼マネージャー 配布版作成
echo ========================================
echo.

where node.exe >nul 2>&1
if errorlevel 1 goto :node_missing
where npm.cmd >nul 2>&1
if errorlevel 1 goto :npm_missing

node -e "const v=process.versions.node.split('.').map(Number);const n=v[0]*1000000+v[1]*1000+v[2];process.exit(Math.max(0,22012000-n)?1:0)"
if errorlevel 1 goto :node_old

if not exist "tools\build\releasePipeline.js" (
  echo tools\build\releasePipeline.jsが見つかりません。
  goto :failed_pause
)

echo [1/1] 実行中の開発版を停止し、依存導入・全検査・Windows配布版生成を実行しています...
node "tools\build\releasePipeline.js"
set "RELEASE_EXIT_CODE=%ERRORLEVEL%"
if not "%RELEASE_EXIT_CODE%"=="0" goto :failed

echo.
echo 配布版の生成が完了しました。
echo 出力先: %CD%\output\dist
start "" explorer.exe "%CD%\output\dist"
exit /b 0

:node_missing
echo Node.jsが見つかりません。
echo 配布物を作成する開発PCにはNode.js 22.12.0以上が必要です。
goto :failed_pause

:npm_missing
echo npmが見つかりません。Node.jsを標準構成で再インストールしてください。
goto :failed_pause

:node_old
echo Node.js 22.12.0以上が必要です。
node --version
goto :failed_pause

:failed
echo.
echo 配布版の生成に失敗しました。output\distの不完全な成果物は削除されています。

:failed_pause
pause
exit /b 1
