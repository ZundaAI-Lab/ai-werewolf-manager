@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion

rem 責務: 現行アプリ版番号を付けたAI修正依頼用ソースZIPの生成を開始し、完了結果だけを利用者へ表示する。
rem 変更ルール: 版番号の正本はapp\package.jsonとし、ZIP名はai_werewolf_manager_vXX_XX_XX.zip形式にする。抽出対象の判定はtools\build\sourceExport.ps1へ集約する。

cd /d "%~dp0"
title AI人狼マネージャー ソース抽出

set "EXPORT_SCRIPT=%CD%\tools\build\sourceExport.ps1"
set "VERSION_FILE=%CD%\app\package.json"
set "EXPORT_VERSION="

echo ========================================
echo AI人狼マネージャー ソース抽出
echo ========================================
echo.

if not exist "%EXPORT_SCRIPT%" (
  echo [抽出エラー] tools\build\sourceExport.ps1が見つかりません。
  goto :failed
)
if not exist "%VERSION_FILE%" (
  echo [抽出エラー] app\package.jsonが見つかりません。
  goto :failed
)

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo [抽出エラー] Windows PowerShellが見つかりません。
  goto :failed
)

for /f "usebackq delims=" %%V in (`powershell.exe -NoLogo -NoProfile -Command "$ErrorActionPreference='Stop'; $package=ConvertFrom-Json -InputObject (Get-Content -Raw -LiteralPath $env:VERSION_FILE); $version=[string]$package.version; if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'app/package.jsonのversionは数値3区分で指定してください。' }; $formatted=@(); foreach ($part in $version.Split('.')) { $formatted += ([int]$part).ToString('00') }; $formatted -join '_'"`) do set "EXPORT_VERSION=%%V"
if not defined EXPORT_VERSION (
  echo [抽出エラー] app\package.jsonから版番号を取得できませんでした。
  goto :failed
)

set "EXPORT_ZIP=%CD%\output\ai_werewolf_manager_v%EXPORT_VERSION%.zip"

echo .github、output、tools\node_modulesを除外してZIPを作成しています...
echo 出力ファイル: ai_werewolf_manager_v%EXPORT_VERSION%.zip
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%EXPORT_SCRIPT%" -ProjectRoot "%CD%" -OutputPath "%EXPORT_ZIP%"
set "EXPORT_EXIT_CODE=%ERRORLEVEL%"
if not "%EXPORT_EXIT_CODE%"=="0" goto :failed
if not exist "%EXPORT_ZIP%" (
  echo [抽出エラー] ZIPの生成結果を確認できませんでした。
  goto :failed
)

echo.
echo ソース抽出が完了しました。
echo 出力先: %EXPORT_ZIP%
start "" explorer.exe /select,"%EXPORT_ZIP%"
exit /b 0

:failed
echo.
echo ソース抽出に失敗しました。
pause
exit /b 1
