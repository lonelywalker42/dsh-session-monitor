# onair-widget.ps1 — DSH 会话监控桌面件（演播室指示标风格，独立于 webui）
#
# 功能：
#   · 默认仅显示紧凑的 [● ON AIR] 胶囊（置顶、可拖动）；点击胶囊展开全窗口，再收起
#   · 大号演播室指示标：ON AIR（活动中，红色）/ WAITING（等待）/ 429（闪烁红）/ DONE / STANDBY
#   · 全部会话列表：标题 - 工作目录（便于区分同目录多会话）+ 状态 + 活动时间 + 自动继续次数
#   · 最近 429 告警横幅 + 自动继续开关
#   · 遵循主机监控的 desktopDisplay 设置：关闭时本桌面件自动退出
#   · 数据源：http://127.0.0.1:<Port>/api/state（主机侧监控，与 webui 无关）
#
# 启动：onair-widget.bat（powershell.exe -STA -WindowStyle Hidden）
# 需要：Windows PowerShell 5.1 + WPF（Windows 自带）；脚本编码须为 UTF-8 with BOM

param([int]$Port = 8091, [string]$Instance = "")
$script:instanceId = $Instance

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml
Add-Type -AssemblyName System.Windows.Forms

$api = "http://127.0.0.1:$Port"

$xaml = Get-Content -LiteralPath (Join-Path $PSScriptRoot "onair-widget.xaml") -Raw -Encoding UTF8

[xml]$xamlDoc = $xaml
$reader = New-Object System.Xml.XmlNodeReader $xamlDoc
$window = [System.Windows.Markup.XamlReader]::Load($reader)
Add-Type -Path (Join-Path $PSScriptRoot "glass-window.cs") -ReferencedAssemblies @("PresentationFramework", "PresentationCore", "WindowsBase")
[DshOnAir.GlassWindow]::Attach($window)
if ($null -eq $window) {
  Write-Error 'XAML 加载失败（XamlReader.Load 返回 null），桌面件无法启动'
  exit 1
}
function F($name) { $window.FindName($name) }
$capsule = F 'Capsule'; $capGlow = F 'CapGlow'; $capDot = F 'CapDot'; $capDotGlow = F 'CapDotGlow'; $capText = F 'CapText'; $capCount = F 'CapCount'; $capClose = F 'CapClose'
$panel = F 'Panel'; $panelHeader = F 'PanelHeader'
$tally = F 'TallyLight'; $ind = F 'IndicatorText'; $scount = F 'SessionCount'
$btnAuto = F 'BtnAuto'; $btnCollapse = F 'BtnCollapse'; $btnClose = F 'BtnClose'; $alertBar = F 'AlertBar'; $alertText = F 'AlertText'
$list = F 'SessionList'; $empty = F 'EmptyText'; $foot = F 'Foot'

$script:autoRetry = $false
$script:alertShown = $false
$script:offline = $false
$script:expanded = $false
$script:capDown = $false
$script:dragging = $false
$script:dragStart = $null

function Set-Font([string]$hex) {
  $bv = New-Object System.Windows.Media.BrushConverter
  return $bv.ConvertFromString($hex)
}

function Set-WindowSize {
  if ($script:expanded) {
    $right = $window.Left + $window.Width
    $bottom = $window.Top + $window.Height
    $window.Width = 400; $window.Height = 520
    $window.Left = [Math]::Max(0, $right - 400)
    $window.Top = [Math]::Max(0, $bottom - 520)
  } else {
    $right = $window.Left + $window.Width
    $bottom = $window.Top + $window.Height
    $window.Width = 180; $window.Height = 44
    $window.Left = [Math]::Max(0, $right - 180)
    $window.Top = [Math]::Max(0, $bottom - 44)
  }
}

function Set-Expanded($on) {
  $script:expanded = $on
  if ($on) { $capsule.Visibility = 'Collapsed'; $panel.Visibility = 'Visible' }
  else     { $capsule.Visibility = 'Visible';    $panel.Visibility = 'Collapsed' }
  Set-WindowSize
}

function Set-Color([string]$hex) {
  return [System.Windows.Media.ColorConverter]::ConvertFromString($hex)
}

function Apply-Indicator($stateText, $hex) {
  $c = Set-Font $hex
  $col = Set-Color $hex
  $capText.Text = $stateText; $capText.Foreground = $c
  $capsule.BorderBrush = $c
  if ($capGlow) { try { $capGlow.Color = $col; $capGlow.Opacity = if ($stateText -eq 'ON AIR' -or $stateText -eq '429') { 0.85 } else { 0.5 } } catch { } }
  if ($capDot) { try { $capDot.Fill = $c; $capDotGlow.Color = $col } catch { } }
  $ind.Text = $stateText; $ind.Foreground = $c
  $tally.Foreground = $c
}

function Update-UI($state) {
  if (-not $state) {
    Apply-Indicator 'OFFLINE' '#FF7050'
    $btnAuto.IsEnabled = $false
    $script:offline = $true
    $foot.Text = "主机监控离线（$api 无响应）"
    return
  }
  if (-not $state.instance.id -or ($script:instanceId -and $state.instance.id -ne $script:instanceId)) { $btnAuto.IsEnabled = $false; $foot.Text = "宿主身份不匹配，请重新打开"; return }
  $script:instanceId = $state.instance.id
  $btnAuto.IsEnabled = $true
  $script:offline = $false
  $script:autoRetry = [bool]$state.settings.autoRetry
  Update-AutoButton

  # 主机关闭了桌面显示 → 本桌面件自动退出
  if ($state.settings.desktopDisplay -eq $false) {
    try { $window.Close() } catch { }
    return
  }

  $sessions = @($state.sessions)
  $scount.Text = if ($sessions.Count -gt 0) { "$($sessions.Count) 个会话" } else { '' }
  $capCount.Text = if ($sessions.Count -gt 0) { "$($sessions.Count)" } else { '' }
  if ($sessions.Count -eq 0) { $empty.Visibility = 'Visible' } else { $empty.Visibility = 'Collapsed' }

  # 演播室指示标：429 > 等待 > ON AIR > DONE > STANDBY
  $any429  = $sessions | Where-Object { $_.state -eq 'error429' } | Select-Object -First 1
  $anyError = $sessions | Where-Object { $_.state -eq 'error' } | Select-Object -First 1
  $anyWait = $sessions | Where-Object { $_.state -eq 'waiting-answer' -or $_.state -eq 'waiting-approval' } | Select-Object -First 1
  $anyAct  = $sessions | Where-Object { $_.state -eq 'active' } | Select-Object -First 1
  $anyDone = $sessions | Where-Object { $_.state -eq 'complete' } | Select-Object -First 1
  if ($any429) { Apply-Indicator '429' '#FDA4AF' }
  elseif ($anyError) { Apply-Indicator 'ERROR' '#FDA4AF' }
  elseif ($anyWait) { Apply-Indicator 'WAITING' '#93C5FD' }
  elseif ($anyAct) { Apply-Indicator 'ON AIR' '#6EE7B7' }
  elseif ($anyDone) { Apply-Indicator 'DONE' '#C4B5FD' }
  else { Apply-Indicator 'STANDBY' '#666' }

  # 告警横幅（最新 429/报错）
  $allAlerts = @()
  foreach ($s in $sessions) { foreach ($a in @($s.alerts)) { $allAlerts += $a } }
  $last429 = $allAlerts | Where-Object { $_.kind -eq '429' } | Sort-Object ts -Descending | Select-Object -First 1
  if ($last429) {
    $alertBar.Visibility = 'Visible'
    $alertText.Text = "[429] " + $last429.code + " · " + $last429.message
    $script:alertShown = $true
  } elseif ($script:alertShown) {
    $alertBar.Visibility = 'Collapsed'; $script:alertShown = $false
  }

  # 会话列表（标题 - 工作目录）
  $list.Children.Clear()
  foreach ($s in $sessions) {
    $row = New-Object System.Windows.Controls.Border
    $row.Margin = New-Object System.Windows.Thickness(0, 4, 0, 4)
    $row.Background = Set-Font '#0EBDD0FF'
    $row.BorderBrush = Set-Font '#20BDD0FF'
    $row.BorderThickness = New-Object System.Windows.Thickness(1)
    $row.CornerRadius = New-Object System.Windows.CornerRadius(12)
    $row.Padding = New-Object System.Windows.Thickness(12)
    $col = New-Object System.Windows.Controls.StackPanel
    $title = New-Object System.Windows.Controls.TextBlock
    $shortCwd = Short-Cwd $s.cwd
    $title.Text = $s.title
    $pathText = New-Object System.Windows.Controls.TextBlock
    $pathText.Text = $shortCwd; $pathText.FontSize = 11; $pathText.Foreground = Set-Font "#AAB8D2"
    $pathText.Margin = New-Object System.Windows.Thickness(0, 4, 0, 0)
    $pathText.TextTrimming = "CharacterEllipsis"
    $title.FontSize = 12.5; $title.FontWeight = 'SemiBold'; $title.Foreground = Set-Font '#E8EEFB'
    $title.TextTrimming = 'CharacterEllipsis'
    $meta = New-Object System.Windows.Controls.TextBlock
    $act = if ($s.state -eq 'active' -and $s.activeSince) { "已持续 " + (Format-Elapsed $s.activeSince) } else { Format-Time $s.lastActivity }
    $meta.Text = "[$($s.stateText)] · $act · 自动继续 $($s.retries)次"
    $meta.FontSize = 11; $meta.Foreground = Set-Font '#AAB8D2'; $meta.Margin = New-Object System.Windows.Thickness(0, 2, 0, 0)
    [void]$col.Children.Add($title); [void]$col.Children.Add($pathText); [void]$col.Children.Add($meta)
    $row.Child = $col
    [void]$list.Children.Add($row)
  }

  $foot.Text = "主机侧监控 · 更新于 " + (Get-Date -Format 'HH:mm:ss') + " · $api"
}

function Short-Cwd($cwd) {
  if (-not $cwd) { return '' }
  $p = ($cwd -replace '[\\/]+$', '') -split '[\\/]'
  $last = $p[$p.Count - 1]
  if ($p.Count -ge 2) { return $p[$p.Count - 2] + '\' + $last }
  return $last
}

function Format-Elapsed($ts) {
  if (-not $ts) { return '' }
  $s = [Math]::Max(0, [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$ts) / 1000))
  if ($s -lt 60) { return "$s" + 's' }
  $m = [Math]::Floor($s / 60)
  if ($m -lt 60) { return "$m" + 'm' + ($s % 60) + 's' }
  return [Math]::Floor($m / 60) + 'h' + ($m % 60) + 'm'
}

function Format-Time($ts) {
  if (-not $ts) { return '' }
  try { return ([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$ts)).ToLocalTime().ToString('HH:mm:ss') } catch { return '' }
}

function Update-AutoButton {
  $btnAuto.Background = if ($script:autoRetry) { Set-Font '#257598F1' } else { Set-Font '#22FFFFFF' }
  $btnAuto.Foreground = if ($script:autoRetry) { Set-Font '#BDD0FF' } else { Set-Font '#DCE6FA' }
  $btnAuto.Content = if ($script:autoRetry) { '自动继续: 开' } else { '自动继续: 关' }
}

function Invoke-State {
  if ($null -eq $window -or $null -eq $window.Dispatcher) { return }
  try {
    $state = Invoke-RestMethod -Uri "$api/api/state" -Method Get -TimeoutSec 3 -ErrorAction Stop
    $null = $window.Dispatcher.Invoke([Action]{ Update-UI $state })
  } catch {
    $null = $window.Dispatcher.Invoke([Action]{ Update-UI $null })
  }
}

# 事件
$btnClose.Add_Click({ $window.Close() })
$btnCollapse.Add_Click({ Set-Expanded $false })
$capClose.Add_Click({ $window.Close() })
# 胶囊：点击展开；按下拖动 → 用 WPF 原生 DragMove 移动窗口。
# 说明：透明窗口（AllowsTransparency+辉光）逐事件改 Left/Top 会因渲染滞后产生
# 反馈误差 → 抖动/不跟手。改用 DragMove()（OS 模态拖动循环，与面板头部一致，最顺滑），
# 用 120ms 重入计时器 + 6px 阈值区分「点击展开」与「拖动」。
$capsule.Add_MouseLeftButtonDown({
  $script:capDown = $true
  $script:dragging = $false
  $pt = [System.Windows.Forms.Control]::MousePosition
  $script:downX = $pt.X; $script:downY = $pt.Y
  if (-not $script:dragTimer) {
    $script:dragTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:dragTimer.Interval = [TimeSpan]::FromMilliseconds(120)
    $script:dragTimer.Add_Tick({
      $script:dragTimer.Stop()
      if ($script:capDown) {
        $pt = [System.Windows.Forms.Control]::MousePosition
        if ([Math]::Abs($pt.X - $script:downX) -gt 6 -or [Math]::Abs($pt.Y - $script:downY) -gt 6) {
          $script:dragging = $true
          $script:capDown = $false
          try { $null = $window.DragMove() } catch { }
          $script:dragging = $false
        } else {
          $script:dragTimer.Start()
        }
      }
    })
  }
  $script:dragTimer.Start()
})
$capsule.Add_MouseLeftButtonUp({
  if ($script:dragTimer) { $script:dragTimer.Stop() }
  if ($script:capDown) { $script:capDown = $false; Set-Expanded $true }
  $script:dragging = $false
})
$btnAuto.Add_Click({
  if (-not $script:instanceId) { return }
  $btnAuto.IsEnabled = $false
  try {
    $next = -not $script:autoRetry
    $body = @{ autoRetry = $next } | ConvertTo-Json -Compress
    $result = Invoke-RestMethod -Uri "$api/api/settings" -Method Post -Body $body -Headers @{ 'X-DSH-Monitor-Instance' = $script:instanceId } -ContentType 'application/json' -TimeoutSec 3 -ErrorAction Stop
    if (-not $result.ok -or $result.instance.id -ne $script:instanceId) { throw '设置未确认' }
    $script:autoRetry = [bool]$result.settings.autoRetry
    Update-AutoButton
  } catch { $foot.Text = '设置保存失败，请重试' }
})
$panelHeader.Add_MouseLeftButtonDown({ if ($_.ButtonState -eq 'Pressed') { try { $window.DragMove() } catch { } } })

# 定时轮询（DispatcherTimer，本地 API 毫秒级）
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(1)
$timer.Add_Tick({ Invoke-State })
$timer.Start()

# 发光状态指示灯：慢速脉冲（仿 aiPulse 1.8s 循环）
if ($capDot) {
  try {
    $pulse = New-Object System.Windows.Media.Animation.DoubleAnimation
    $pulse.From = 1.0
    $pulse.To = 0.25
    $pulse.Duration = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(900))
    $pulse.AutoReverse = $true
    $pulse.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
    $capDot.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $pulse)
  } catch { }
}

# 初始定位：屏幕右下角
$wa = [System.Windows.SystemParameters]::WorkArea
$window.Left = $wa.Right - $window.Width - 16
$window.Top = $wa.Bottom - $window.Height - 16

Update-AutoButton
Invoke-State
$app = New-Object System.Windows.Application
$app.Run($window) | Out-Null