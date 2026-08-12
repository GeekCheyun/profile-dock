' 应用多开工具 - 默认启动器
' 双击此文件可直接打开应用窗口（不弹 cmd 黑窗）。
' 首次运行会自动在桌面创建快捷方式「应用多开工具」。之后双击桌面图标即可。
'
' 说明：本工具与 WorkBuddy 实例都以当前用户权限（非管理员）运行。
' 不要使用「以管理员身份运行」：高完整性进程无法连接 Windows 输入法(TSF)，
' 会导致实例内无法使用中文输入法、无法切换中英文，并拖慢 WorkBuddy 的
' 认证/网络服务（专家市场等）。DLL 注入同用户同权限进程不需要管理员权限。
Option Explicit

Dim sh, fso, scriptDir, electronExe, desktopPath, shortcutPath
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = scriptDir & "\node_modules\electron\dist\electron.exe"

' ---- 每次启动都强制更新桌面快捷方式（覆盖旧的 Description 等属性，避免残留旧提示）----
desktopPath = sh.SpecialFolders("Desktop")
shortcutPath = desktopPath & "\应用多开工具.lnk"
Dim sc
Set sc = sh.CreateShortcut(shortcutPath)
sc.TargetPath = WScript.ScriptFullName
sc.WorkingDirectory = scriptDir
sc.IconLocation = electronExe & ",0"
sc.Description = "应用多开工具"
sc.Save

' ---- 前置检查：electron 是否就位 ----
If Not fso.FileExists(electronExe) Then
    MsgBox "未找到 electron，请先运行「多开工具.bat」完成首次初始化安装。", vbExclamation, "应用多开工具"
    WScript.Quit 1
End If

' ---- 首次初始化：若未构建前后端，按默认流程静默构建（可能耗时较长）----
If Not fso.FolderExists(scriptDir & "\node_modules") Then
    MsgBox "首次使用，请先双击「多开工具.bat」完成依赖安装与构建。", vbInformation, "应用多开工具"
    WScript.Quit 1
End If
If Not fso.FolderExists(scriptDir & "\dist-server") Then
    sh.Run "cmd /c cd /d """ & scriptDir & """ && call npm run build:server", 0, True
End If
If Not fso.FileExists(scriptDir & "\dist-server\index.js") Then
    MsgBox "后端构建失败，请双击「多开工具.bat」查看错误信息。", vbExclamation, "应用多开工具"
    WScript.Quit 1
End If
If Not fso.FolderExists(scriptDir & "\dist") Then
    sh.Run "cmd /c cd /d """ & scriptDir & """ && call npm run build", 0, True
End If
If Not fso.FileExists(scriptDir & "\dist\index.html") Then
    MsgBox "前端构建失败，请双击「多开工具.bat」查看错误信息。", vbExclamation, "应用多开工具"
    WScript.Quit 1
End If

' ---- 以当前用户权限启动 electron（无 UAC；保证输入法/剪贴板/文本服务可用）----
CreateObject("Shell.Application").ShellExecute electronExe, Chr(34) & scriptDir & Chr(34), scriptDir, "open", 1
