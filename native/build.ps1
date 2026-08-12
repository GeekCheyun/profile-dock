# 编译 hook DLL —— 将源码复制到纯 ASCII 临时目录编译，规避中文路径编码问题
# 背景：项目路径含中文（多开工具/工作空间），cl.exe 在非中文代码页下无法解析中文路径。
#       且 D: 盘 8.3 短文件名生成被禁用，ShortPath 仍返回长路径，故改用临时目录复制法。
# 通过脚本自身路径定位项目根目录（不依赖工作目录，避免 cwd 未继承问题）
$nativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $nativeDir
Write-Host "Project root: $root"

# 计算临时目录基路径（多重回退，确保非空且为 ASCII）
$tempBase = $env:TEMP
if (-not $tempBase) { $tempBase = $env:TMP }
if (-not $tempBase) { $tempBase = Join-Path $env:USERPROFILE "AppData\Local\Temp" }
if (-not $tempBase) { $tempBase = "C:\Windows\Temp" }
# 纯 ASCII 临时构建目录
$buildTmp = Join-Path $tempBase "mo_hook_build"
Write-Host "Build temp: $buildTmp"

# 清理并创建临时目录
if (Test-Path $buildTmp) { Remove-Item -Recurse -Force $buildTmp }
New-Item -ItemType Directory -Force -Path $buildTmp | Out-Null
New-Item -ItemType Directory -Force -Path "$buildTmp\hook_dll" | Out-Null
New-Item -ItemType Directory -Force -Path "$buildTmp\minhook" | Out-Null
New-Item -ItemType Directory -Force -Path "$buildTmp\out" | Out-Null

# 复制源码到临时目录（使用 robocopy，对 Unicode 中文路径比 Copy-Item 更可靠）
# 注意：robocopy 退出码 0-7 为成功，>=8 才是错误
& robocopy "$root\native\hook_dll" "$buildTmp\hook_dll" /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "ERROR: robocopy hook_dll failed exit=$LASTEXITCODE"; exit 1 }
& robocopy "$root\native\minhook" "$buildTmp\minhook" /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "ERROR: robocopy minhook failed exit=$LASTEXITCODE"; exit 1 }
Write-Host "Sources copied to temp build dir"

# 确保项目输出目录存在
New-Item -ItemType Directory -Force -Path "$root\native\build" | Out-Null

# 定位 Visual Studio
$vsCandidates = @(
    "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools",
    "C:\Program Files\Microsoft Visual Studio\2022\Community",
    "C:\Program Files\Microsoft Visual Studio\2022\Professional",
    "C:\Program Files\Microsoft Visual Studio\2022\Enterprise"
)
$vs = $vsCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vs) {
    Write-Host "ERROR: Visual Studio 2022 (BuildTools/Community) not found"
    exit 1
}
$vcvars = "$vs\VC\Auxiliary\Build\vcvars64.bat"
Write-Host "Using VS: $vs"

# 构建纯 ASCII 路径的 cmd 脚本
$srcHook = "$buildTmp\hook_dll"
$srcMinhook = "$buildTmp\minhook"
$outDir = "$buildTmp\out"

$cl = "cl /nologo /O2 /MT /W3 /utf-8 /D_CRT_SECURE_NO_WARNINGS /DWIN32 /D_WINDOWS /D_USRDLL"
$cl += " /I `"$srcMinhook\include`" /I `"$srcHook`""
$cl += " `"$srcHook\hook_dll.c`""
$cl += " `"$srcMinhook\src\buffer.c`" `"$srcMinhook\src\hook.c`" `"$srcMinhook\src\trampoline.c`""
$cl += " `"$srcMinhook\src\hde\hde32.c`" `"$srcMinhook\src\hde\hde64.c`""
$cl += " /link /nologo /DLL /OUT:`"$outDir\multiopen_hook.dll`" /SUBSYSTEM:WINDOWS /MACHINE:X64 /DEF:`"$srcHook\multiopen_hook.def`""

$cmd = "@echo off`r`n"
$cmd += "call `"$vcvars`"`r`n"
$cmd += "if errorlevel 1 exit /b 1`r`n"
$cmd += "cd /d `"$buildTmp`"`r`n"
$cmd += "echo Compiling...`r`n"
$cmd += $cl + "`r`n"
$cmd += "exit /b %errorlevel%"

$cmdFile = "$buildTmp\build.cmd"
[System.IO.File]::WriteAllText($cmdFile, $cmd, [System.Text.Encoding]::ASCII)

Write-Host "Compiling..."
$buildOutput = & cmd.exe /d /s /c "`"$cmdFile`"" 2>&1
$buildExitCode = $LASTEXITCODE
$buildOutput | Set-Content -LiteralPath "$buildTmp\out.txt" -Encoding UTF8
New-Item -ItemType File -Force -Path "$buildTmp\err.txt" | Out-Null
$buildOutput | ForEach-Object { Write-Host $_ }

if (Test-Path "$outDir\multiopen_hook.dll") {
    # 复制产物回项目（用 .NET File.Copy，原生支持 Unicode 路径，Copy-Item 在中文路径下会静默失败）
    try {
        [System.IO.File]::Copy("$outDir\multiopen_hook.dll", "$root\native\build\multiopen_hook.dll", $true)
        if (Test-Path "$outDir\multiopen_hook.lib") {
            [System.IO.File]::Copy("$outDir\multiopen_hook.lib", "$root\native\build\multiopen_hook.lib", $true)
        }
    } catch {
        Write-Host "BUILD OUTPUT COPY FAILED: $($_.Exception.Message)"
        Write-Host "Close all running multiopen instances and retry."
        Write-Host "Build dir kept for inspection: $buildTmp"
        exit 2
    }
    # 同步一份编译日志到项目 tmp 便于排查
    New-Item -ItemType Directory -Force -Path "$root\native\tmp" | Out-Null
    [System.IO.File]::Copy("$buildTmp\out.txt", "$root\native\tmp\out.txt", $true)
    [System.IO.File]::Copy("$buildTmp\err.txt", "$root\native\tmp\err.txt", $true)
    Write-Host ""
    Write-Host "BUILD SUCCESS"
    $dllInfo = Get-Item "$outDir\multiopen_hook.dll"
    Write-Host ("DLL: {0}  Size: {1} bytes" -f $dllInfo.Name, $dllInfo.Length)
    Write-Host "Copied to: $root\native\build\multiopen_hook.dll"
    # 清理临时目录
    Remove-Item -Recurse -Force $buildTmp -ErrorAction SilentlyContinue
} else {
    Write-Host ""
    Write-Host "BUILD FAILED exit=$buildExitCode"
    Write-Host "Build dir kept for inspection: $buildTmp"
    exit $buildExitCode
}
