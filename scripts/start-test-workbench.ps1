param([switch]$CheckOnly,[switch]$CaptureDiagnostics)
$ErrorActionPreference = 'Stop'
$testRoot = Split-Path -Parent $PSScriptRoot
$testExe = Join-Path $testRoot 'node_modules\electron\dist\electron.exe'
$testPackagedExe = Join-Path $testRoot 'release\win-unpacked\Browser Workbench.exe'
$testMain = Join-Path $testRoot 'dist\src\desktop\main.js'
if (!(Test-Path -LiteralPath $testExe) -or !(Test-Path -LiteralPath $testMain)) {throw 'TEST_WORKBENCH_BUILD_REQUIRED'}
$testListeners = @(netstat -ano | Where-Object {$_ -match '^\s*TCP\s+127\.0\.0\.1:18767\s+\S+\s+LISTENING\s+(\d+)\s*$'} | ForEach-Object {[int]($_.Trim() -split '\s+')[-1]})
if ($testListeners.Count -gt 0) {
 if ($testListeners.Count -ne 1) {throw 'TEST_WORKBENCH_PORT_OWNER_AMBIGUOUS'}
 $testOwner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $testListeners[0])
 if (!$testOwner -or !$testOwner.CommandLine -or !$testOwner.CommandLine.Contains($testRoot) -or $testOwner.ExecutablePath -notin @($testExe,$testPackagedExe)) {throw 'TEST_WORKBENCH_PORT_IN_USE_BY_OTHER_CONTROLLER'}
}
if ($CheckOnly) {Write-Output 'TEST_WORKBENCH_START_READONLY_CHECK_PASSED'; exit 0}
# Existing software uses single-instance handling. Never retire historical research services.
$testPreviousData = $env:WORKBENCH_DATA_DIR
$testPreviousPort = $env:WORKBENCH_PORT
$testPreviousTiming = $env:WORKBENCH_TRACE_TIMING
try {
 $env:WORKBENCH_DATA_DIR = Join-Path $env:APPDATA 'Browser Workbench\data'
 $env:WORKBENCH_PORT = '18767'
 $testCapture = @{}
 if ($CaptureDiagnostics) {
  $env:WORKBENCH_TRACE_TIMING = '1'
  $testLogId = [Guid]::NewGuid().ToString()
  $testCapture.RedirectStandardOutput = Join-Path $testRoot ('audit\desktop-runtime-' + $testLogId + '.stdout.log')
  $testCapture.RedirectStandardError = Join-Path $testRoot ('audit\desktop-runtime-' + $testLogId + '.stderr.log')
 }
 $testProcess = Start-Process -FilePath $testExe -ArgumentList ('"' + $testRoot + '"') -WorkingDirectory $testRoot -WindowStyle Hidden -PassThru @testCapture
 if ($CaptureDiagnostics) {Write-Output ('TEST_WORKBENCH_DIAGNOSTICS=' + $testCapture.RedirectStandardError)}
} finally {
 $env:WORKBENCH_DATA_DIR = $testPreviousData
 $env:WORKBENCH_PORT = $testPreviousPort
 $env:WORKBENCH_TRACE_TIMING = $testPreviousTiming
}
Write-Output ('TEST_WORKBENCH_STARTED PID=' + $testProcess.Id)
