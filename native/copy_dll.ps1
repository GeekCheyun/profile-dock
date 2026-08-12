$src = 'C:\Users\cheyu\AppData\Local\Temp\mo_hook_build\out\multiopen_hook.dll'
$dst = 'd:\ProgramFiles\WorkBudy\WorkBuddy工作空间\多开工具\native\build\multiopen_hook.dll'
if (Test-Path $src) {
    [System.IO.File]::Copy($src, $dst, $true)
    Write-Host "DLL copied successfully"
    $f = Get-Item $dst
    Write-Host "Size: $($f.Length) bytes, Modified: $($f.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))"
} else {
    Write-Host "Temp DLL not found - checking if build dir was cleaned"
}
