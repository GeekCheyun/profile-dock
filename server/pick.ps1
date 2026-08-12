param(
  [Parameter(Mandatory=$true)][ValidateSet('folder','file')][string]$Kind,
  [string]$Title = '请选择'
)

# 弹出原生选择对话框，返回所选路径（取消则为空）。供后端 /api/pick 调用。
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true

if ($Kind -eq 'folder') {
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = $Title
  $dlg.ShowNewFolderButton = $true
  $res = $dlg.ShowDialog($form)
  if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dlg.SelectedPath
  }
} else {
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.Title = $Title
  $dlg.Filter = '程序 (*.exe)|*.exe|所有文件 (*.*)|*.*'
  $dlg.CheckFileExists = $true
  $res = $dlg.ShowDialog($form)
  if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dlg.FileName
  }
}
