$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'extension/manifest.json') -Raw | ConvertFrom-Json
$buildDir = Join-Path $projectRoot 'build'
$distDir = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $buildDir,$distDir -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:winexe /codepage:65001 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll ("/out:" + (Join-Path $buildDir 'RednoteLiveRecorder.exe')) (Join-Path $PSScriptRoot 'Launcher.cs') (Join-Path $PSScriptRoot 'Updater.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
$inno = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6/ISCC.exe'
if (-not (Test-Path -LiteralPath $inno)) { throw 'Inno Setup 6 is required.' }
& $inno ("/DAppVersion=" + $manifest.version) (Join-Path $PSScriptRoot 'setup.iss')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
