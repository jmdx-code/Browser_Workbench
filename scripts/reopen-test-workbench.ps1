param([switch]$CheckOnly,[string]$InterruptedPlanId,[string]$SnapshotDirectory,[switch]$CaptureDiagnostics)
$ErrorActionPreference = 'Stop'
$reopenRoot = Split-Path -Parent $PSScriptRoot
$reopenExe = Join-Path $reopenRoot 'node_modules\electron\dist\electron.exe'
$reopenListener = @(netstat -ano | Where-Object {$_ -match '^\s*TCP\s+127\.0\.0\.1:18767\s+\S+\s+LISTENING\s+(\d+)\s*$'} | ForEach-Object {[int]($_.Trim() -split '\s+')[-1]})
if($reopenListener.Count -gt 1){throw 'WORKBENCH_PORT_OWNER_AMBIGUOUS'}
$reopenChild = if($reopenListener.Count -eq 1){Get-CimInstance Win32_Process -Filter ('ProcessId='+$reopenListener[0])}else{$null}
$reopenParent = if($reopenChild){Get-CimInstance Win32_Process -Filter ('ProcessId='+$reopenChild.ParentProcessId)}else{$null}
if ($reopenParent) {
 if ($reopenParent.ExecutablePath -ne $reopenExe -or !$reopenParent.CommandLine.Contains($reopenRoot) -or !$reopenChild -or $reopenChild.ParentProcessId -ne $reopenParent.ProcessId -or $reopenChild.ExecutablePath -ne $reopenExe) {throw 'OLD_WORKBENCH_OWNER_CHANGED'}
 $reopenSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
 $null = Invoke-WebRequest 'http://127.0.0.1:18767/workbench/' -WebSession $reopenSession -UseBasicParsing
 try {
  $reopenTasks = Invoke-RestMethod 'http://127.0.0.1:18767/api/workspace/tasks' -WebSession $reopenSession -Headers @{'x-workbench-task-contract'='4'}
 } catch {
  $reopenFailure = $null
  try {$reopenFailure = $_.ErrorDetails.Message | ConvertFrom-Json} catch {}
  if ($reopenFailure.code -ne 'TASK_CONTRACT_UNSUPPORTED') {throw}
  try {
   $reopenTasks = Invoke-RestMethod 'http://127.0.0.1:18767/api/workspace/tasks' -WebSession $reopenSession -Headers @{'x-workbench-task-contract'='3'}
  } catch {
   $reopenFailure = $null
   try {$reopenFailure = $_.ErrorDetails.Message | ConvertFrom-Json} catch {}
   if ($reopenFailure.code -ne 'TASK_CONTRACT_UNSUPPORTED') {throw}
   $reopenTasks = Invoke-RestMethod 'http://127.0.0.1:18767/api/workspace/tasks' -WebSession $reopenSession -Headers @{'x-workbench-task-contract'='2'}
  }
 }
 $reopenActive = @($reopenTasks.plans | Where-Object {$_.state -in @('QUEUED','RUNNING','PAUSING','STOPPING')})
 if ($InterruptedPlanId) {
  if (!$SnapshotDirectory) {throw 'INTERRUPTED_CONTROL_SNAPSHOT_REQUIRED'}
  $reopenSnapshotRoot = [IO.Path]::GetFullPath($SnapshotDirectory)
  $reopenAuditRoot = [IO.Path]::GetFullPath((Join-Path $reopenRoot 'audit')) + [IO.Path]::DirectorySeparatorChar
  if (!$reopenSnapshotRoot.StartsWith($reopenAuditRoot,[StringComparison]::OrdinalIgnoreCase)) {throw 'INTERRUPTED_SNAPSHOT_OUTSIDE_AUDIT'}
  $reopenSnapshot = Get-Content -LiteralPath (Join-Path $reopenSnapshotRoot 'snapshot.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($reopenSnapshot.kind -ne 'readonly-interrupted-control-backup' -or $reopenSnapshot.planId -ne $InterruptedPlanId -or
      $reopenActive.Count -ne 1 -or $reopenActive[0].id -ne $InterruptedPlanId -or $reopenActive[0].state -notin @('PAUSING','STOPPING') -or
      $reopenActive[0].updatedAt -ne $reopenSnapshot.active[0].updated_at -or
      !(Test-Path -LiteralPath (Join-Path $reopenSnapshotRoot 'workspace.sqlite')) -or !(Test-Path -LiteralPath (Join-Path $reopenSnapshotRoot 'journal.sqlite'))) {throw 'INTERRUPTED_CONTROL_SCOPE_CHANGED'}
 } elseif ($reopenActive.Count -gt 0) {throw 'WORKBENCH_TASKS_NOT_STOPPED'}
 if (!$CheckOnly) {
  $reopenCurrentParent = Get-CimInstance Win32_Process -Filter ('ProcessId='+$reopenParent.ProcessId)
  if (!$reopenCurrentParent -or $reopenCurrentParent.CommandLine -ne $reopenParent.CommandLine -or $reopenCurrentParent.CreationDate -ne $reopenParent.CreationDate) {throw 'WORKBENCH_PARENT_REPLACED'}
  Stop-Process -Id $reopenParent.ProcessId
  Wait-Process -Id $reopenParent.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
  $reopenRemaining = Get-CimInstance Win32_Process -Filter ('ProcessId='+$reopenChild.ProcessId)
  if ($reopenRemaining -and $reopenRemaining.CreationDate -eq $reopenChild.CreationDate -and $reopenRemaining.ParentProcessId -eq $reopenParent.ProcessId -and $reopenRemaining.ExecutablePath -eq $reopenExe) {
   try {Stop-Process -Id $reopenRemaining.ProcessId} catch {if (Get-Process -Id $reopenRemaining.ProcessId -ErrorAction SilentlyContinue) {throw}}
   Wait-Process -Id $reopenRemaining.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
  }
 }
}
if ($CheckOnly) {Write-Output 'REOPEN_WORKBENCH_READONLY_CHECK_PASSED'; exit 0}
& (Join-Path $PSScriptRoot 'start-test-workbench.ps1') -CaptureDiagnostics:$CaptureDiagnostics
