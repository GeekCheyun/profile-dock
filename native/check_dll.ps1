$dllPath = Join-Path $PSScriptRoot 'build\multiopen_hook.dll'
Write-Host "Checking processes using: $dllPath"

# Find processes that have the DLL loaded
$found = @()
Get-Process | ForEach-Object {
    try {
        $mods = $_.Modules
        if ($mods) {
            foreach ($m in $mods) {
                if ($m.FileName -ieq $dllPath) {
                    $found += $_
                    Write-Host "  PID=$($_.Id) Name=$($_.ProcessName)"
                    break
                }
            }
        }
    } catch {}
}

if ($found.Count -eq 0) {
    Write-Host "No process has this DLL loaded"
} else {
    Write-Host "$($found.Count) process(es) using the DLL"
}
