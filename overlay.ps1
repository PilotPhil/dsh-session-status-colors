<#
  dsh-session-status-colors —— 桌面红绿灯（独立的原生置顶窗口）。

  由插件 Host 半拉起：powershell.exe -Sta -File overlay.ps1 <statePath> <positionPath>

  - 一个无边框、半透明、始终置顶的圆角矩形，里面竖排三个圆形指示灯；
  - 每盏灯的数字是该状态下的会话数量，0 时灯变暗且不显示数字；
  - 没有任何交互控件，只用鼠标左键拖动可以移动位置；
  - 每 400ms 读一次 Host 写出的状态文件；启用状态被关掉、或状态文件长时间
    不再更新（说明 DSH 已经不在了）时自行退出，不会留下孤儿窗口。
#>
param(
  [Parameter(Mandatory = $true)][string]$StatePath,
  [Parameter(Mandatory = $true)][string]$PositionPath
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$PanelColor = '#F7F9FA'
$FallbackColors = @('#E5484D', '#D9A300', '#2F9E44')
$LampSize = 30
$PollMs = 400
$StaleMs = 20000
$MissingLimit = 12

$brushConverter = New-Object System.Windows.Media.BrushConverter

function Convert-Brush([string]$hex) {
  if ([string]::IsNullOrWhiteSpace($hex)) { $hex = '#9AA0A6' }
  try {
    return $brushConverter.ConvertFromString($hex)
  } catch {
    return $brushConverter.ConvertFromString('#9AA0A6')
  }
}

function Read-OverlayState {
  try {
    if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
    $raw = Get-Content -LiteralPath $StatePath -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Save-Position([double]$left, [double]$top) {
  try {
    $payload = [ordered]@{ left = [math]::Round($left, 1); top = [math]::Round($top, 1) } | ConvertTo-Json -Compress
    $temp = "$PositionPath.tmp"
    Set-Content -LiteralPath $temp -Value $payload -Encoding UTF8 -ErrorAction Stop
    Move-Item -LiteralPath $temp -Destination $PositionPath -Force -ErrorAction Stop
  } catch {
    # 位置存不下只影响下次启动的位置，不影响窗口本身。
  }
}

function Read-Position {
  try {
    if (-not (Test-Path -LiteralPath $PositionPath)) { return $null }
    $raw = Get-Content -LiteralPath $PositionPath -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

# ---- 窗口骨架 ----------------------------------------------------------------

$window = New-Object System.Windows.Window
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ResizeMode = 'NoResize'
$window.SizeToContent = 'WidthAndHeight'
$window.ShowActivated = $false
$window.Title = 'dsh-session-status-colors'

# 外边距给阴影留出空间：AllowsTransparency 下阴影画在窗口内，不外扩。
$frame = New-Object System.Windows.Controls.Border
$frame.CornerRadius = New-Object System.Windows.CornerRadius(20)
$frame.Padding = New-Object System.Windows.Thickness(14, 15, 14, 15)
$frame.Margin = New-Object System.Windows.Thickness(20)
$frame.Background = Convert-Brush $PanelColor

$shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
$shadow.Color = [System.Windows.Media.Color]::FromRgb(15, 23, 42)
$shadow.BlurRadius = 20
$shadow.ShadowDepth = 4
$shadow.Direction = 270
$shadow.Opacity = 0.22
$frame.Effect = $shadow

$stack = New-Object System.Windows.Controls.StackPanel

$ellipses = @()
$labels = @()
$texts = @()

for ($index = 0; $index -lt 3; $index++) {
  $row = New-Object System.Windows.Controls.Grid
  $row.Width = $LampSize
  $row.Height = $LampSize
  $row.Margin = New-Object System.Windows.Thickness(0, 4, 0, 4)

  $ellipse = New-Object System.Windows.Shapes.Ellipse
  $ellipse.Width = $LampSize
  $ellipse.Height = $LampSize
  $ellipse.Fill = Convert-Brush $FallbackColors[$index]
  $ellipse.Opacity = 0.18

  $text = New-Object System.Windows.Controls.TextBlock
  $text.Text = ''
  $text.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe UI')
  $text.FontSize = 14
  $text.FontWeight = 'Bold'
  $text.Foreground = [System.Windows.Media.Brushes]::White
  $text.HorizontalAlignment = 'Center'
  $text.VerticalAlignment = 'Center'
  $text.TextAlignment = 'Center'
  $text.Visibility = 'Collapsed'

  [void]$row.Children.Add($ellipse)
  [void]$row.Children.Add($text)
  [void]$stack.Children.Add($row)

  $ellipses += $ellipse
  $texts += $text
}

$frame.Child = $stack
$window.Content = $frame

# ---- 位置 --------------------------------------------------------------------

$saved = Read-Position
$virtualLeft = [System.Windows.SystemParameters]::VirtualScreenLeft
$virtualTop = [System.Windows.SystemParameters]::VirtualScreenTop
$virtualRight = $virtualLeft + [System.Windows.SystemParameters]::VirtualScreenWidth
$virtualBottom = $virtualTop + [System.Windows.SystemParameters]::VirtualScreenHeight

$defaultLeft = $virtualRight - 140
$defaultTop = $virtualTop + 160

if ($null -ne $saved -and $null -ne $saved.left -and $null -ne $saved.top) {
  $window.Left = [double]$saved.left
  $window.Top = [double]$saved.top
} else {
  $window.Left = $defaultLeft
  $window.Top = $defaultTop
}

# 换过显示器/分辨率后旧坐标可能落在屏幕外，夹回可见区域。
$window.Left = [math]::Min([math]::Max($window.Left, $virtualLeft), $virtualRight - 60)
$window.Top = [math]::Min([math]::Max($window.Top, $virtualTop), $virtualBottom - 60)

$positionTimer = New-Object System.Windows.Threading.DispatcherTimer
$positionTimer.Interval = [TimeSpan]::FromMilliseconds(600)
$positionTimer.Add_Tick({
  $positionTimer.Stop()
  Save-Position $window.Left $window.Top
})

$window.Add_LocationChanged({
  $positionTimer.Stop()
  $positionTimer.Start()
})

# ---- 拖动（唯一的交互） -------------------------------------------------------

$frame.Add_PreviewMouseLeftButtonDown({
  param($sender, $event)
  try {
    $window.DragMove()
  } catch {
    # 放开鼠标的瞬间偶尔会抛，忽略即可。
  }
})

# ---- 轮询状态文件 ------------------------------------------------------------

$state = @{
  signature = ''
  missing = 0
}

$pollTimer = New-Object System.Windows.Threading.DispatcherTimer
$pollTimer.Interval = [TimeSpan]::FromMilliseconds($PollMs)
$pollTimer.Add_Tick({
  $snapshot = Read-OverlayState

  if ($null -eq $snapshot) {
    $state.missing++
    if ($state.missing -ge $MissingLimit) {
      $pollTimer.Stop()
      $positionTimer.Stop()
      $window.Close()
    }
    return
  }
  $state.missing = 0

  if ($snapshot.enabled -ne $true) {
    $pollTimer.Stop()
    $positionTimer.Stop()
    $window.Close()
    return
  }

  $stamp = 0
  if ($null -ne $snapshot.ts) { $stamp = [double]$snapshot.ts }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($stamp -gt 0 -and ($now - $stamp) -gt $StaleMs) {
    $pollTimer.Stop()
    $positionTimer.Stop()
    $window.Close()
    return
  }

  $counts = @($snapshot.counts)
  $colors = @($snapshot.colors)
  $signature = "$($counts -join ',')|$($colors -join ',')"
  if ($signature -eq $state.signature) { return }
  $state.signature = $signature

  for ($index = 0; $index -lt 3; $index++) {
    $count = 0
    if ($counts.Count -gt $index -and $null -ne $counts[$index]) {
      $count = [int]$counts[$index]
    }

    $hex = $FallbackColors[$index]
    if ($colors.Count -gt $index -and -not [string]::IsNullOrWhiteSpace([string]$colors[$index])) {
      $hex = [string]$colors[$index]
    }

    $ellipses[$index].Fill = Convert-Brush $hex
    if ($count -gt 0) {
      $ellipses[$index].Opacity = 1.0
      $texts[$index].Text = [string]$count
      $texts[$index].Visibility = 'Visible'
    } else {
      # 0 个会话：灯变暗、不显示数字。
      $ellipses[$index].Opacity = 0.18
      $texts[$index].Visibility = 'Collapsed'
    }
  }
})

$window.Add_Closed({
  $pollTimer.Stop()
  $positionTimer.Stop()
})

$pollTimer.Start()
$window.ShowDialog() | Out-Null
