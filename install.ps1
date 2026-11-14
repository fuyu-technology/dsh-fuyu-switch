# dsh-fuyu-switch 安装脚本
#
# 做的事：
#   1. 把插件包复制到 %USERPROFILE%\.dsh\plugins\dsh-fuyu-switch
#   2. 把托盘脚本复制到 %USERPROFILE%\DeepSeekTray（面板的休眠/唤醒/关闭靠它执行）
#   3. 在 %USERPROFILE%\.dsh\profiles\desktop\package.json 里登记 link 依赖与 bundle
#   4. 在 profiles\desktop\node_modules 下建目录联接（junction）
#   所有被覆盖的文件都会先备份成 <文件名>.bak-<时间戳>
#
# 不写注册表、不改 ACL、不新增服务或端口；失败会明确报出是哪个文件没写进去。
#
# 注意：本文件必须保存为「UTF-8 带 BOM」。Windows PowerShell 5.1 会把无 BOM 的 UTF-8
# 按 ANSI 解析，中文串被打断后直接语法报错（install.bat 用 -File 调它时会当场失败）。
# 修改本文件后请确认前 3 个字节是 EF BB BF，不要用会去掉 BOM 的编辑器另存。

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$src = $PSScriptRoot
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$pluginDir = Join-Path $dshHome 'plugins\dsh-fuyu-switch'
$profileDir = Join-Path $dshHome 'profiles\desktop'
$profilePkg = Join-Path $profileDir 'package.json'
$nodeModules = Join-Path $profileDir 'node_modules'
$junction = Join-Path $nodeModules 'dsh-fuyu-switch'
$trayDir = Join-Path $env:USERPROFILE 'DeepSeekTray'

# 与 index.js 同一套顺序找 pythonw：环境变量 -> %LOCALAPPDATA%\Programs\Python\Python*
# -> C:\Python* / D:\Python* -> py -3 解释器同级 -> PATH 裸名
function Resolve-Pythonw {
    $candidates = @()
    if ($env:DSH_SWITCH_PYTHONW) { $candidates += $env:DSH_SWITCH_PYTHONW }

    $roots = @()
    if ($env:LOCALAPPDATA) { $roots += (Join-Path $env:LOCALAPPDATA 'Programs\Python') }
    $roots += 'C:\'
    $roots += 'D:\'
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $dirs = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^Python\d' } |
            Sort-Object { [int]($_.Name -replace '\D', '') } -Descending
        foreach ($d in $dirs) { $candidates += (Join-Path $d.FullName 'pythonw.exe') }
    }

    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) {
        try {
            $exe = & $py.Source -3 -c "import sys;print(sys.executable)" 2>$null
            if ($exe) { $candidates += (Join-Path (Split-Path $exe) 'pythonw.exe') }
        } catch {}
    }

    $candidates += 'pythonw.exe'
    foreach ($c in $candidates) {
        if ($c -eq 'pythonw.exe') {
            $cmd = Get-Command $c -ErrorAction SilentlyContinue
            if ($cmd) { return $cmd.Source }
            continue
        }
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

function Backup-File([string]$path) {
    if (Test-Path -LiteralPath $path) {
        $bak = "$path.bak-$stamp"
        Copy-Item -LiteralPath $path -Destination $bak -Force
        Write-Host ("  备份 -> " + $bak)
    }
}

try {
    Write-Host '== dsh-fuyu-switch 安装 =='

    if (-not (Test-Path -LiteralPath $dshHome)) {
        throw "没找到 DSH 目录：$dshHome（请先确认 DeepSeek Harness 已运行过一次）"
    }
    if (-not (Test-Path -LiteralPath $profilePkg)) {
        throw "没找到配置：$profilePkg"
    }

    # 1) 插件包
    Write-Host '[1/5] 复制插件包'
    New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
    foreach ($f in @('package.json', 'cordis.patch.yml', 'index.js', 'client.js', 'icon.svg')) {
        $target = Join-Path $pluginDir $f
        Backup-File $target
        Copy-Item -LiteralPath (Join-Path $src $f) -Destination $target -Force
        Write-Host ("  " + $f)
    }

    # 2) 托盘脚本
    Write-Host '[2/5] 安装托盘控制脚本'
    New-Item -ItemType Directory -Force -Path $trayDir | Out-Null
    foreach ($f in @('deepseek_tray.pyw', 'deepseek_tray.ico')) {
        $target = Join-Path $trayDir $f
        Backup-File $target
        Copy-Item -LiteralPath (Join-Path $src ("tray\" + $f)) -Destination $target -Force
        Write-Host ("  " + $target)
    }

    # 3) 登记到 profile
    Write-Host '[3/5] 登记到 profiles\desktop\package.json'
    Backup-File $profilePkg
    $raw = Get-Content -LiteralPath $profilePkg -Raw -Encoding UTF8
    $pkg = $raw | ConvertFrom-Json
    $linkValue = 'link:C:/Users/' + $env:USERNAME + '/.dsh/plugins/dsh-fuyu-switch'
    if (-not $pkg.dependencies.PSObject.Properties['dsh-fuyu-switch']) {
        $pkg.dependencies | Add-Member -NotePropertyName 'dsh-fuyu-switch' -NotePropertyValue $linkValue
        Write-Host ('  dependencies += dsh-fuyu-switch')
    } else {
        $pkg.dependencies.'dsh-fuyu-switch' = $linkValue
        Write-Host '  dependencies 已存在，覆盖链接'
    }
    $bundles = @($pkg.dsh.profile.bundles)
    if ($bundles -notcontains 'dsh-fuyu-switch') {
        $pkg.dsh.profile.bundles = @($bundles + 'dsh-fuyu-switch')
        Write-Host '  bundles += dsh-fuyu-switch'
    } else {
        Write-Host '  bundles 已包含'
    }
    $json = $pkg | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($profilePkg, $json, (New-Object Text.UTF8Encoding($false)))

    # 4) node_modules 联接
    Write-Host '[4/5] 建立 node_modules 目录联接'
    if (Test-Path -LiteralPath $junction) {
        $item = Get-Item -LiteralPath $junction -Force
        if ($item.LinkType -eq 'Junction') {
            Write-Host '  已存在，跳过'
        } else {
            throw "已存在同名项但不是 Junction：$junction（请手动删掉后重跑）"
        }
    } else {
        New-Item -ItemType Junction -Path $junction -Target $pluginDir | Out-Null
        Write-Host ("  " + $junction + " -> " + $pluginDir)
    }

    # 5) 自检
    Write-Host '[5/5] 自检'
    $trayPy = Join-Path $trayDir 'deepseek_tray.pyw'
    if (-not (Test-Path -LiteralPath $trayPy)) { throw "托盘脚本缺失：$trayPy" }
    $pyw = Resolve-Pythonw
    if (-not $pyw) {
        Write-Host '  提示：没找到 pythonw.exe。已查 DSH_SWITCH_PYTHONW、%LOCALAPPDATA%\Programs\Python\Python*、'
        Write-Host '       C:\Python*、D:\Python*、py -3、PATH。装好 Python 3 或设置 DSH_SWITCH_PYTHONW 后重跑即可。'
        Write-Host '       面板点击时会返回同一条错误，不会静默失败。'
    } else {
        Write-Host ('  pythonw: ' + $pyw)
        $status = & $pyw $trayPy --ctl status 2>&1
        if ($status) {
            Write-Host ('  控制通道自检：' + ($status -join ' '))
        } else {
            Write-Host '  提示：控制脚本没有返回状态，面板点击时会再报具体原因'
        }
    }

    Write-Host ''
    Write-Host '安装完成。请完全退出 DeepSeek Harness（托盘图标退出），再重新打开。'
    Write-Host '打开后进入：设置 -> 通用，最上面会多出「DeepSeek 开关」一行。'
} catch {
    Write-Host ''
    Write-Host ('安装失败：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host '常见原因：1) DeepSeek Harness 正在运行并占用了文件；2) 当前账户没有该目录写权限。'
    Write-Host '处理完可原样重跑本脚本（会自动再备份一次）。'
    exit 1
}
