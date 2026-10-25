param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$config = Get-Content -LiteralPath (Join-Path $root 'config/media-runtime.json') -Raw | ConvertFrom-Json
if ($config.directory -notmatch '^[a-zA-Z0-9.-]+$' -or $config.directory.Contains('..')) { throw 'MEDIA_RUNTIME_DIRECTORY_INVALID' }
$destination = Join-Path $root 'vendor/media-runtime'
$runtime = Join-Path $destination $config.directory
if (-not (Test-Path -LiteralPath $runtime)) {
    if ($VerifyOnly) { throw 'MEDIA_RUNTIME_NOT_PREPARED' }
    $archive = Join-Path $root ('audit/' + $config.directory + '.zip')
    if (-not $config.archiveUrl.StartsWith('https://github.com/BtbN/FFmpeg-Builds/releases/download/')) { throw 'MEDIA_RUNTIME_SOURCE_REJECTED' }
    if (-not (Test-Path -LiteralPath (Split-Path $archive -Parent))) { New-Item -ItemType Directory -Path (Split-Path $archive -Parent) | Out-Null }
    if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $config.archiveUrl -OutFile $archive }
    if ((Get-Item -LiteralPath $archive).Length -ne $config.archiveBytes -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.archiveSha256) { throw 'MEDIA_RUNTIME_ARCHIVE_MISMATCH' }
    Expand-Archive -LiteralPath $archive -DestinationPath $destination
}
$checked = 0
foreach ($entry in $config.binarySha256.PSObject.Properties) {
    if ($entry.Name -notmatch '^[a-z0-9.-]+\.(exe|dll)$') { throw 'MEDIA_RUNTIME_BINARY_NAME_REJECTED' }
    $file = Join-Path $runtime ('bin/' + $entry.Name)
    if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) { throw ('MEDIA_RUNTIME_BINARY_MISMATCH:' + $entry.Name) }
    $checked++
}
if (-not (Test-Path -LiteralPath (Join-Path $runtime 'LICENSE.txt'))) { throw 'MEDIA_RUNTIME_LICENSE_MISSING' }
[ordered]@{ verified = $true; release = $config.release; binaries = $checked; browserOperations = 0 } | ConvertTo-Json -Compress
