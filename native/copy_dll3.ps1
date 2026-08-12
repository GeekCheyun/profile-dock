$src = Join-Path $env:TEMP 'mo_hook_build\out\multiopen_hook.dll'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dst = Join-Path $root 'native\build\multiopen_hook.dll'

if (Test-Path $src) {
    # Try rename old file first, then copy new
    $old = "$dst.old"
    if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
    if (Test-Path $dst) {
        try {
            Rename-Item $dst $old -Force
            Write-Host "Renamed old DLL"
        } catch {
            Write-Host "Rename failed: $_"
        }
    }
    [System.IO.File]::Copy($src, $dst, $true)
    $f = Get-Item $dst
    Write-Host "SUCCESS: Size=$($f.Length) Modified=$($f.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))"
    # Cleanup old
    if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
} else {
    Write-Host "FAIL: Source DLL not found"
}
