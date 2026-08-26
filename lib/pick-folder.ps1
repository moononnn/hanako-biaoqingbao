# 表情包 · 导出文件夹选择
# 用 Windows 原生 FolderBrowserDialog 选择 ZIP 导出目录，把选中路径写到 stdout。
# 由 Node 侧 spawn 调用；-STA 是 FolderBrowserDialog 的必要条件。
param(
  [string]$InitialDir = ""
)

# Windows PowerShell 默认编码可能随系统区域变化；统一成无 BOM UTF-8，保证中文路径回到 Node 不乱码。
$utf8 = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = "选择表情包 ZIP 的保存文件夹"
if ($InitialDir -and (Test-Path -LiteralPath $InitialDir -PathType Container)) {
  $f.SelectedPath = (Resolve-Path -LiteralPath $InitialDir).Path
}
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $f.SelectedPath
}
