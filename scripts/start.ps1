$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
# Node 运行时预检:版本不够或构建未启用 TypeScript 支持时给出指引,而不是 ERR_UNKNOWN_FILE_EXTENSION(#38)
& node (Join-Path $root "scripts\check-node.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$api = $null
$ui = $null
function Stop-ProcessTree($Process) {
  if (-not $Process) { return }
  $rootId = [int]$Process.Id
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId)
  $pending = [System.Collections.Generic.Queue[int]]::new()
  $seen = [System.Collections.Generic.HashSet[int]]::new()
  $descendants = [System.Collections.Generic.List[int]]::new()
  $pending.Enqueue($rootId)
  [void]$seen.Add($rootId)
  while ($pending.Count -gt 0) {
    $parentId = $pending.Dequeue()
    foreach ($child in $all) {
      $childId = [int]$child.ProcessId
      if ([int]$child.ParentProcessId -eq $parentId -and $seen.Add($childId)) {
        $descendants.Add($childId)
        $pending.Enqueue($childId)
      }
    }
  }
  # 父进程已退出时 taskkill /PID <parent> /T 找不到树根；
  # CIM 快照里的 ParentProcessId 仍能让我们定位遗留子孙。
  foreach ($targetId in @($descendants | Sort-Object -Descending)) {
    & taskkill.exe /PID $targetId /T /F *> $null
  }
  $Process.Refresh()
  if (-not $Process.HasExited) {
    & taskkill.exe /PID $rootId /T /F *> $null
  }
}
try {
  $api = Start-Process -FilePath node -ArgumentList @("orchestrator\src\api.ts", "--port", "8765", "--host", "127.0.0.1") -WorkingDirectory $root -PassThru -NoNewWindow
  # UI 由 Vite 按 VRA_LAN 决定绑定；默认回环，API 的回环绑定不变。
  $ui = Start-Process -FilePath npm.cmd -ArgumentList @("run", "dev", "--prefix", "desktop") -WorkingDirectory $root -PassThru -NoNewWindow
  $ready = $false
  $readyDeadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $readyDeadline) {
    $api.Refresh()
    $ui.Refresh()
    if ($api.HasExited) { throw "API 启动失败（退出码 $($api.ExitCode)），请检查 8765 端口和产品配置。" }
    if ($ui.HasExited) { throw "界面启动失败（退出码 $($ui.ExitCode)）。" }
    # 经界面代理验证后端鉴权；令牌仍只留在本地服务，不传到浏览器或命令参数。
    & node (Join-Path $root "orchestrator\src\startup_health.ts")
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw "启动等待超过 60 秒。请检查上方日志、8765/5930 端口以及产品配置；浏览器尚未打开。" }
  $api.Refresh()
  $ui.Refresh()
  if ($api.HasExited) { throw "API 启动失败（退出码 $($api.ExitCode)），请检查 8765 端口和产品配置。" }
  if ($ui.HasExited) { throw "界面启动失败（退出码 $($ui.ExitCode)）。" }
  Start-Process "http://127.0.0.1:5930"
  while (-not $api.HasExited -and -not $ui.HasExited) {
    Start-Sleep -Milliseconds 250
    $api.Refresh()
    $ui.Refresh()
  }
  if ($api.HasExited) { throw "API 已停止（退出码 $($api.ExitCode)），界面同步关闭。" }
  if ($ui.HasExited) { throw "界面已提前停止（退出码 $($ui.ExitCode)）。" }
} finally {
  Stop-ProcessTree $ui
  Stop-ProcessTree $api
}
