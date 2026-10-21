$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'extension/manifest.json') -Raw | ConvertFrom-Json).version
$installer = Join-Path $projectRoot "dist/RednoteLiveRecorder-$version-Setup.exe"
$testDir = Join-Path $env:RUNNER_TEMP 'RecorderInstallSmoke'
$process = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/TASKS=',('/DIR="' + $testDir + '"')) -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer exit: $($process.ExitCode)" }
$installed = Get-Content -LiteralPath (Join-Path $testDir 'extension/manifest.json') -Raw | ConvertFrom-Json
if ($installed.version -ne $version) { throw 'Installed version mismatch.' }
$completeFile = Join-Path $testDir 'extension/install-complete.json'
$complete = Get-Content -LiteralPath $completeFile -Raw | ConvertFrom-Json
if ($complete.version -ne $version -or $complete.complete -ne $true) { throw 'Installation completion marker missing or invalid.' }
$marker = Join-Path $testDir 'keep-user-file.txt'
Set-Content -LiteralPath $marker -Value 'preserve' -Encoding utf8
$upgrade = Start-Process -FilePath $installer -ArgumentList @('/SP-','/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="' + $testDir + '"')) -WindowStyle Hidden -Wait -PassThru
if ($upgrade.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $marker)) { throw 'In-place upgrade did not preserve the installed location and existing files.' }
$complete = Get-Content -LiteralPath $completeFile -Raw | ConvertFrom-Json
if ($complete.version -ne $version -or $complete.complete -ne $true -or (Test-Path -LiteralPath ($completeFile + '.tmp'))) { throw 'Upgrade completion marker invalid or temporary file left over.' }
$launcher = Start-Process -FilePath (Join-Path $testDir 'RednoteLiveRecorder.exe') -ArgumentList '--self-test' -WindowStyle Hidden -Wait -PassThru
if ($launcher.ExitCode -ne 0) { throw 'Installed launcher self-test failed.' }
$updater = Start-Process -FilePath (Join-Path $testDir 'RednoteLiveRecorder.exe') -ArgumentList '--updater-self-test' -WindowStyle Hidden -Wait -PassThru
if ($updater.ExitCode -ne 0) { throw "Updater validation self-test failed: $($updater.ExitCode)" }
$protocol = (Get-Item -LiteralPath 'HKCU:\Software\Classes\rednoteliverecorder\shell\open\command').GetValue('')
if (-not $protocol.Contains($testDir)) { throw 'Update protocol did not preserve the installed path.' }
$uninstaller = Join-Path $testDir 'unins000.exe'
if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Uninstaller missing.' }
$uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -WindowStyle Hidden -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw 'Uninstall failed.' }
if (Test-Path -LiteralPath $completeFile) { throw 'Uninstaller did not remove its installation marker.' }
Write-Output 'PASS: installer, installed version, launcher self-test, uninstaller.'
