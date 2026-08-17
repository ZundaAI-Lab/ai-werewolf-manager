# 責務: 現行ソースとRenderer生成物の一致および製造ゲート通過を確認してから、フォルダ構成を維持したAI修正依頼用ZIPを生成する。
# 変更ルール: 生成物更新はensureCurrentBuild.js、構造検査はmanufacturingGate.jsへ委譲する。除外対象は.github、output、tools/node_modulesに限定し、追加除外は利用者の明示指示を必須とする。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
$output = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $output
$archiveRootName = 'ai_werewolf_manager'
$ensureBuildScript = Join-Path $root 'tools\build\ensureCurrentBuild.js'
$manufacturingGateScript = Join-Path $root 'tools\build\manufacturingGate.js'

function Invoke-NodeValidation {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        throw "$Label が見つかりません: $ScriptPath"
    }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        throw "$Label の実行に必要なNode.jsが見つかりません。"
    }

    & $nodeCommand.Source $ScriptPath
    if ($LASTEXITCODE -ne 0) {
        throw "$Label に失敗しました。終了コード: $LASTEXITCODE"
    }
}


$excludedRoots = @(
    [System.IO.Path]::GetFullPath((Join-Path $root '.github')).TrimEnd('\', '/'),
    [System.IO.Path]::GetFullPath((Join-Path $root 'output')).TrimEnd('\', '/'),
    [System.IO.Path]::GetFullPath((Join-Path $root 'tools\node_modules')).TrimEnd('\', '/')
)

function Test-ExcludedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    foreach ($excludedRoot in $excludedRoots) {
        if ([string]::Equals($fullPath, $excludedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
        $prefix = $excludedRoot + [System.IO.Path]::DirectorySeparatorChar
        if ($fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "プロジェクトルートが見つかりません: $root"
}

Invoke-NodeValidation -ScriptPath $ensureBuildScript -Label 'Renderer生成物鮮度保証'
Invoke-NodeValidation -ScriptPath $manufacturingGateScript -Label '製造規約ゲート'

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
if (Test-Path -LiteralPath $output) {
    Remove-Item -LiteralPath $output -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$archive = $null
$fileCount = 0
$directoryCount = 1

try {
    $archive = [System.IO.Compression.ZipFile]::Open(
        $output,
        [System.IO.Compression.ZipArchiveMode]::Create
    )

    try {
        $archive.CreateEntry("$archiveRootName/") | Out-Null

        $stack = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
        $stack.Push((Get-Item -LiteralPath $root))

        while ($stack.Count -gt 0) {
            $currentDirectory = $stack.Pop()
            $directories = @($currentDirectory.EnumerateDirectories() | Sort-Object FullName -Descending)
            foreach ($directory in $directories) {
                if (Test-ExcludedPath -Path $directory.FullName) {
                    continue
                }

                $relativeDirectory = $directory.FullName.Substring($root.Length)
                while ($relativeDirectory.StartsWith('\') -or $relativeDirectory.StartsWith('/')) {
                    $relativeDirectory = $relativeDirectory.Substring(1)
                }
                $entryDirectory = $relativeDirectory.Replace('\', '/')
                $archive.CreateEntry("$archiveRootName/$entryDirectory/") | Out-Null
                $directoryCount += 1
                $stack.Push($directory)
            }

            $files = @($currentDirectory.EnumerateFiles() | Sort-Object FullName)
            foreach ($file in $files) {
                if (Test-ExcludedPath -Path $file.FullName) {
                    continue
                }

                $relativeFile = $file.FullName.Substring($root.Length)
                while ($relativeFile.StartsWith('\') -or $relativeFile.StartsWith('/')) {
                    $relativeFile = $relativeFile.Substring(1)
                }
                $entryName = "$archiveRootName/" + $relativeFile.Replace('\', '/')
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive,
                    $file.FullName,
                    $entryName,
                    [System.IO.Compression.CompressionLevel]::Optimal
                ) | Out-Null
                $fileCount += 1
            }
        }
    }
    finally {
        if ($null -ne $archive) {
            $archive.Dispose()
            $archive = $null
        }
    }

    if ($fileCount -eq 0) {
        throw '抽出対象のファイルがありません。'
    }

    $archiveInfo = Get-Item -LiteralPath $output
    Write-Host "抽出ファイル数: $fileCount"
    Write-Host "保持ディレクトリ数: $directoryCount"
    Write-Host "ZIPサイズ: $($archiveInfo.Length) bytes"
    Write-Host "生成先: $output"
}
catch {
    if ($null -ne $archive) {
        try {
            $archive.Dispose()
        }
        catch {
            # 元の生成失敗を優先し、後始末中の例外は再送出しない。
        }
        $archive = $null
    }
    Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
    throw
}
