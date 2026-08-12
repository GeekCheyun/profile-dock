# 清理历史遗留的 *.deleting-* 残留实例目录
#
# 背景：旧版本的多开工具以管理员权限启动 WorkBuddy 实例，实例日志目录
# （config\logs\<date>）带当前用户的“拒绝删除(Deny)”ACE，导致删除实例后留下
# `*.deleting-*` 残留目录，普通权限（甚至管理员）直接 rd/Remove-Item 都会被拒绝。
#
# 修复：先用 icacls /remove:d 移除当前用户在子对象上的显式 Deny ACE，再删除。
# 当前用户是这些目录的属主，普通权限即可完成，无需 UAC/管理员。
#
# 用法（任选其一）：
#   1. 双击 scripts\清理残留实例数据.bat
#   2. 右键本文件 → “使用 PowerShell 运行”
#   3. powershell -NoProfile -ExecutionPolicy Bypass -File cleanup-stale-instances.ps1
#
# 安全边界：只处理 engine\instances\**\*.deleting-* 目录，绝不触碰活动实例目录
# （无 .deleting- 后缀）和 shared/ 共享的真实文件夹（Junction 会先被移除）。

$ErrorActionPreference = 'Continue'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
$user = "$env:USERDOMAIN\$env:USERNAME"
$forceElevated = $args -contains '-ForceElevated'

Write-Host "当前用户: $user  管理员权限: $isAdmin"

$root = Split-Path -Parent $PSScriptRoot
$instancesRoot = Join-Path $root 'engine\instances'
if (-not (Test-Path -LiteralPath $instancesRoot)) {
    Write-Host '未找到 engine\instances，无需清理。'
    exit 0
}

$dirs = Get-ChildItem -LiteralPath $instancesRoot -Directory | ForEach-Object {
    Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue
} | Where-Object { $_.Name -match '\.deleting-' }

if ($dirs.Count -eq 0) {
    Write-Host '没有发现 *.deleting-* 残留目录。'
    exit 0
}

$instancesRootFull = (Resolve-Path -LiteralPath $instancesRoot).Path.TrimEnd('\')
$cleaned = 0
$failed = 0
$failedDirs = @()

foreach ($d in $dirs) {
    $target = (Resolve-Path -LiteralPath $d.FullName).Path
    # 双重校验：必须位于 engine\instances 内且名字匹配 .deleting-
    if (-not $target.StartsWith($instancesRootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
        Write-Warning "跳过越界路径: $target"
        continue
    }
    if ($d.Name -notmatch '\.deleting-') {
        Write-Warning "跳过非残留目录: $target"
        continue
    }

    Write-Host ""
    Write-Host "清理: $($d.Name)"

    # 1) 先移除 Junction（防止跟随链接删除共享的真实文件夹）
    cmd /c "dir /AL /S /B `"$target`" 2>nul" | ForEach-Object {
        if ($_ -and (Test-Path -LiteralPath $_)) {
            cmd /c "rmdir `"$($_.Trim())`" 2>nul"
        }
    }

    # 2) 递归移除当前用户在所有子对象上的显式 Deny ACE（关键步骤）
    icacls $target /remove:d $user /t /c /q 2>&1 | Out-Null
    Write-Host "  已解除拒绝删除权限 (icacls /remove:d /t)"

    # 3) 删除整个目录（\\?\ 长路径前缀，避免 260 字符路径限制）
    $longTarget = '\\?\' + $target
    try {
        [System.IO.Directory]::Delete($longTarget, $true)
    } catch {
        # 个别文件可能被进程占用，逐个重试
        $null = [System.IO.Directory]::Delete($longTarget, $true)
    }

    if (Test-Path -LiteralPath $target) {
        $failed++
        $failedDirs += $target
        Write-Warning "  仍无法删除: $target（可能有进程占用，请关闭 WorkBuddy/多开工具窗口后重试）"
    } else {
        $cleaned++
        Write-Host "  已删除。"
    }
}

Write-Host ""
Write-Host "清理完成：成功 $cleaned 个，失败 $failed 个。"
if ($failed -gt 0) {
    Write-Host "失败项可能由旧版管理员实例遗留（目录属主为 Administrators）或进程占用导致。"
    # 非管理员且失败目录存在时，自动请求一次 UAC 用管理员权限重试
    if (-not $isAdmin -and -not $forceElevated -and $failedDirs.Count -gt 0) {
        Write-Host ""
        Write-Host "正在请求管理员权限重试失败目录..."
        $argList = '-NoProfile -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '" -ForceElevated'
        Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs
    }
}
