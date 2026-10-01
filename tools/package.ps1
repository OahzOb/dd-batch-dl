# 打包成可直接分发的 zip
#
# 用法（在 dd-batch-dl 目录下）：
#   pwsh -NoProfile -File tools/package.ps1
#
# 产出 dist/dingtalk-folder-downloader-<version>.zip
# 对方解压后在 chrome://extensions/ 里「加载已解压的扩展程序」即可使用。
#
# 只打包运行必需的文件：manifest.json + src/。
# README.md、tools/、测试脚本都不进包，发行说明单独写一份给收货人看的。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "找不到 manifest.json：$manifestPath" }

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
$name = 'dingtalk-folder-downloader'

# 校验：manifest 引用的每个文件都必须存在，否则装上去会直接报错
$referenced = @(
  $manifest.background.service_worker
  $manifest.side_panel.default_path
)
if ($manifest.content_scripts) {
  foreach ($cs in $manifest.content_scripts) { $referenced += $cs.js }
}
if ($manifest.web_accessible_resources) {
  foreach ($war in $manifest.web_accessible_resources) { $referenced += $war.resources }
}
foreach ($f in $referenced) {
  $p = Join-Path $root $f
  if (-not (Test-Path $p)) { throw "manifest 引用了不存在的文件：$f" }
}
Write-Host "manifest 引用校验通过（$($referenced.Count) 个文件）"

# sidepanel.html 引用的脚本/样式也要在
$html = Get-Content (Join-Path $root 'src/sidepanel.html') -Raw
foreach ($m in [regex]::Matches($html, '(?:src|href)="([^"]+)"')) {
  $rel = $m.Groups[1].Value
  if ($rel -match '^https?:|^//') { continue }
  $p = Join-Path (Join-Path $root 'src') $rel
  if (-not (Test-Path $p)) { throw "sidepanel.html 引用了不存在的文件：src/$rel" }
}
Write-Host 'sidepanel.html 引用校验通过'

# 组装暂存目录
$stage = Join-Path $env:TEMP "dd-pkg-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$pkgRoot = Join-Path $stage $name
New-Item -ItemType Directory -Force -Path (Join-Path $pkgRoot 'src') | Out-Null

Copy-Item $manifestPath (Join-Path $pkgRoot 'manifest.json')
Copy-Item (Join-Path $root 'src/*') (Join-Path $pkgRoot 'src') -Recurse -Force

# 给收货人看的安装说明（放在包里，和扩展同级）
$installText = @"
$($manifest.name) v$version
========================================

【安装】

1. 把整个文件夹解压到一个固定位置，例如 D:\chrome-ext\dingtalk-folder-downloader
   ⚠️ 不要放在临时目录，也不要在装好之后移动或删除这个文件夹——
      扩展是直接从这个文件夹运行的，移走了就会失效。

2. 打开 Chrome，地址栏输入：chrome://extensions/
   （Edge 用 edge://extensions/）

3. 打开右上角的「开发者模式」开关。

4. 点左上角「加载已解压的扩展程序」，选择第 1 步解压出来的那个文件夹
   （里面应该直接能看到 manifest.json）。

5. 装好后建议点扩展图标旁边的图钉，把它固定到工具栏。

【使用】

1. 在浏览器里打开你的钉钉文档文件夹页面（确认已登录、能看到文件列表）。
2. 点扩展图标打开侧边栏。
3. 页面地址会自动填入，直接点「扫描目录树」。
4. 点文件夹左边的小三角展开想看的内容（展开哪个才读哪个，打开很快）。
5. 勾选要下载的文件/文件夹，点「下载选中的文件」。

文件会存到下载目录，并保持原来的文件夹结构。
也可以勾选「打包成一个 zip」把选中的内容打成一个压缩包。

【常见提示】

* Chrome 可能弹出「请停用以开发者模式运行的扩展程序」。
  点「取消」即可；这个扩展不是从应用商店安装的，属于正常提示。

* 侧边栏会一直显示在标签页上，这是 Chrome 侧边栏本身的行为。
  点侧边栏右上角（或面板自带的）✕ 可以关掉。

* 「在线文档」（钉钉里的文档/表格/思维导图）没有公开的导出接口，
  会被跳过并在面板底部列出，需要你在钉钉里手动导出。
  上传的文件（PDF / Word / Excel / 图片 / 压缩包 等）都能正常批量下载。

* 本扩展调用的是钉钉文档自身的接口，如果钉钉改动接口，可能会失效。
  届时需要更新扩展。

* 本扩展不会上传你的任何数据；登录态用的是你自己浏览器的钉钉会话，
  不读取也不存储你的账号凭据。
"@
Set-Content -Path (Join-Path $pkgRoot '安装说明.txt') -Value $installText -Encoding UTF8

# 压缩
$distDir = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$zipPath = Join-Path $distDir "$name-$version.zip"
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Compress-Archive -Path $pkgRoot -DestinationPath $zipPath -Force
Remove-Item $stage -Recurse -Force

# 结果
$zipItem = Get-Item $zipPath
Write-Host ''
Write-Host "已打包：$zipPath"
Write-Host "  版本  : $version"
Write-Host "  体积  : $([math]::Round($zipItem.Length / 1KB, 1)) KB"
Write-Host ''
Write-Host '包内结构：'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  foreach ($e in $zip.Entries | Sort-Object FullName) {
    Write-Host ("  {0,-46} {1,7} B" -f $e.FullName, $e.Length)
  }
} finally { $zip.Dispose() }
