$src = Join-Path $env:TEMP 'mo_hook_build\out\multiopen_hook.dll'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dst = Join-Path $root 'native\build\multiopen_hook.dll'
Write-Host "Source: $src"
Write-Host "Dest: $dst"
if (Test-Path $src) {
    [System.IO.File]::Copy($src, $dst, $true)
    $f = Get-Item $dst
    Write-Host "SUCCESS: Size=$($f.Length) Modified=$($f.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))"
} else {
    Write-Host "FAIL: Source DLL not found"
}
