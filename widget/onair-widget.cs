// onair-widget.cs — DSH 会话监控桌面件（原生 C# WPF，编译为独立 .exe，无需 powershell）
// 与 onair-widget.ps1 同功能：ON AIR 胶囊 + 展开面板 + 429 告警 + 自动继续开关。
// 数据源 http://127.0.0.1:8091/api/state（主机侧监控，独立于 webui）。
// 编译（.NET Framework 4.8 csc）：
//   csc /nologo /target:winexe /out:onair-widget.exe /r:System.dll /r:System.Web.Extensions.dll \
//       /r:PresentationFramework.dll /r:PresentationCore.dll /r:WindowsBase.dll /r:System.Xaml.dll onair-widget.cs
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Shapes;
using System.Windows.Threading;
using System.Xml;
using System.Web.Script.Serialization;

namespace DshOnAir
{
    public static class Program
    {
        static int Port = 8091;
        static string Api;

        static Window W;
        static Border Capsule, Panel, PanelHeader;
        static Ellipse CapDot;
        static DropShadowEffect CapGlow, CapDotGlow;
        static TextBlock CapText, CapCount;
        static TextBlock Tally, Ind, SCnt, EmptyTxt, Foot, AlertText;
        static Border AlertBar;
        static StackPanel SessionList;
        static Button BtnAuto, BtnClose;

        static DispatcherTimer PollTimer, DragTimer;
        static bool capDown, dragging, expanded, alertShown, autoRetry;
        static double downX, downY;
        static string prevState = "STANDBY";
        static Window ToastW;

        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        static T Find<T>(string name) where T : DependencyObject
        {
            return (T)W.FindName(name);
        }

        static SolidColorBrush Brush(string hex)
        {
            try { return (SolidColorBrush)new BrushConverter().ConvertFromString(hex); }
            catch { return Brushes.White; }
        }
        static Color ColorOf(string hex)
        {
            try { return (Color)ColorConverter.ConvertFromString(hex); }
            catch { return Colors.White; }
        }

        static void SetWindowSize()
        {
            double right = W.Left + W.Width, bottom = W.Top + W.Height;
            if (expanded) { W.Width = 380; W.Height = 560; }
            else { W.Width = 180; W.Height = 44; }
            W.Left = Math.Max(0, right - W.Width);
            W.Top = Math.Max(0, bottom - W.Height);
        }

        static void SetExpanded(bool on)
        {
            expanded = on;
            Capsule.Visibility = on ? Visibility.Collapsed : Visibility.Visible;
            Panel.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
            SetWindowSize();
        }

        static void ApplyIndicator(string text, string hex)
        {
            var c = Brush(hex);
            var col = ColorOf(hex);
            CapText.Text = text; CapText.Foreground = c;
            Capsule.BorderBrush = c;
            if (CapGlow != null) { CapGlow.Color = col; CapGlow.Opacity = (text == "ON AIR" || text == "429") ? 0.85 : 0.5; }
            if (CapDot != null) { CapDot.Fill = c; if (CapDotGlow != null) CapDotGlow.Color = col; }
            Ind.Text = text; Ind.Foreground = c;
            Tally.Foreground = c;
        }

        static string StateText(Dictionary<string, object> s) { return (string)Safe(s, "stateText", ""); }

        static object Safe(Dictionary<string, object> d, string k, object def)
        {
            object v; if (d != null && d.TryGetValue(k, out v) && v != null) return v; return def;
        }

        static void UpdateUI(string raw)
        {
            if (string.IsNullOrEmpty(raw)) { ApplyIndicator("OFFLINE", "#FF7050"); Foot.Text = "主机监控离线（" + Api + " 无响应）"; return; }
            Dictionary<string, object> st;
            try { st = Json.Deserialize<Dictionary<string, object>>(raw); }
            catch { ApplyIndicator("OFFLINE", "#FF7050"); Foot.Text = "解析失败"; return; }

            var settings = st.ContainsKey("settings") ? st["settings"] as Dictionary<string, object> : null;
            autoRetry = Convert.ToBoolean(Safe(settings, "autoRetry", false));
            UpdateAutoButton();

            // 主机关闭桌面显示 → 自动退出
            if (settings != null && settings.ContainsKey("desktopDisplay") && Convert.ToBoolean(settings["desktopDisplay"]) == false)
            { W.Close(); return; }

            var sessions = st.ContainsKey("sessions") ? st["sessions"] as ArrayList : new ArrayList();
            bool any429 = false, anyWait = false, anyAct = false, anyDone = false;
            foreach (var o in sessions)
            {
                var s = o as Dictionary<string, object>; if (s == null) continue;
                string rawState = Convert.ToString(Safe(s, "state", ""));
                if (rawState == "error429") any429 = true;
                else if (rawState == "waiting-answer" || rawState == "waiting-approval") anyWait = true;
                else if (rawState == "active") anyAct = true;
                else if (rawState == "complete") anyDone = true;
            }
            SCnt.Text = sessions.Count > 0 ? sessions.Count + " 个会话" : "";
            CapCount.Text = sessions.Count > 0 ? Convert.ToString(sessions.Count) : "";
            EmptyTxt.Visibility = sessions.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

            string state, stateColor;
            if (any429) { state = "429"; stateColor = "#FF2A2A"; }
            else if (anyWait) { state = "WAITING"; stateColor = "#4DA6FF"; }
            else if (anyAct) { state = "ON AIR"; stateColor = "#FF3B30"; }
            else if (anyDone) { state = "DONE"; stateColor = "#F5A623"; }
            else { state = "STANDBY"; stateColor = "#666"; }
            ApplyIndicator(state, stateColor);

            // 状态变化提示：ON AIR → WAITING/DONE 提示；429 仅在未开自动继续时提示
            if (state != prevState)
            {
                bool notify = false;
                string msg = null, color = stateColor;
                if (prevState == "ON AIR" && (state == "WAITING" || state == "DONE"))
                {
                    notify = true;
                    msg = state == "WAITING" ? "WAITING · 等待回答 / 批准" : "DONE · 工作完成";
                }
                else if (state == "429" && !autoRetry)
                {
                    notify = true;
                    msg = "429 · 限流中断（未自动继续）";
                }
                prevState = state;
                if (notify) { ShowToast(msg, color); FlashCapsule(); }
            }

            // 告警横幅
            // 告警横幅：仅在「当前存在 429 中断会话」时显示最新 429 告警，恢复即隐藏
            // （避免历史告警残留导致横幅持续显示）
            if (any429)
            {
                Dictionary<string, object> last429 = null;
                foreach (var o in sessions)
                {
                    var s = o as Dictionary<string, object>; if (s == null) continue;
                    if (Convert.ToString(Safe(s, "state", "")) != "error429") continue;
                    var al = s.ContainsKey("alerts") ? s["alerts"] as ArrayList : null;
                    if (al == null) continue;
                    foreach (var a in al)
                    {
                        var d = a as Dictionary<string, object>; if (d == null) continue;
                        if (Convert.ToString(Safe(d, "kind", "")) == "429") { last429 = d; break; }
                    }
                    if (last429 != null) break;
                }
                if (last429 != null)
                {
                    AlertBar.Visibility = Visibility.Visible;
                    AlertText.Text = "[429] " + Safe(last429, "code", "") + " · " + Safe(last429, "message", "");
                }
                else AlertBar.Visibility = Visibility.Collapsed;
            }
            else
            {
                AlertBar.Visibility = Visibility.Collapsed;
            }

            // 会话列表（标题 - 工作目录）
            SessionList.Children.Clear();
            foreach (var o in sessions)
            {
                var s = o as Dictionary<string, object>; if (s == null) continue;
                string title = Convert.ToString(Safe(s, "title", ""));
                string cwd = ShortCwd(Convert.ToString(Safe(s, "cwd", "")));
                string stt = Convert.ToString(Safe(s, "stateText", ""));
                string act = s.ContainsKey("activeSince") && Convert.ToInt64(Safe(s, "activeSince", 0L)) > 0
                    ? "已持续 " + Elapsed(Convert.ToInt64(Safe(s, "activeSince", 0L)))
                    : TimeText(Convert.ToInt64(Safe(s, "lastActivity", 0L)));
                string retries = Convert.ToString(Safe(s, "retries", 0));

                var row = new Border { Margin = new Thickness(0, 2, 0, 2), Background = Brush("#22FFFFFF"), CornerRadius = new CornerRadius(8), Padding = new Thickness(8, 6, 8, 6) };
                var col = new StackPanel();
                var t1 = new TextBlock { Text = title + " - " + cwd, FontSize = 12.5, FontWeight = FontWeights.Bold, Foreground = Brush("#E8E8E8"), TextTrimming = TextTrimming.CharacterEllipsis };
                var t2 = new TextBlock { Text = "[" + stt + "] · " + act + " · 自动继续 " + retries + "次", FontSize = 11, Foreground = Brush("#999"), Margin = new Thickness(0, 2, 0, 0) };
                col.Children.Add(t1); col.Children.Add(t2);
                row.Child = col;
                SessionList.Children.Add(row);
            }

            Foot.Text = "主机侧监控 · 更新于 " + DateTime.Now.ToString("HH:mm:ss") + " · " + Api;
        }

        static string ShortCwd(string cwd)
        {
            if (string.IsNullOrEmpty(cwd)) return "";
            var p = cwd.TrimEnd('\\', '/').Split('\\', '/');
            var last = p.Length > 0 ? p[p.Length - 1] : "";
            return p.Length >= 2 ? p[p.Length - 2] + "\\" + last : last;
        }
        static string Elapsed(long ts)
        {
            long s = Math.Max(0, (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - ts) / 1000);
            if (s < 60) return s + "s";
            long m = s / 60; if (m < 60) return m + "m" + (s % 60) + "s";
            return (m / 60) + "h" + (m % 60) + "m";
        }
        static string TimeText(long ts)
        {
            if (ts <= 0) return "";
            try { return DateTimeOffset.FromUnixTimeMilliseconds(ts).ToLocalTime().ToString("HH:mm:ss"); }
            catch { return ""; }
        }

        static void UpdateAutoButton()
        {
            BtnAuto.Background = autoRetry ? Brush("#33FF5050") : Brush("#22FFFFFF");
            BtnAuto.Foreground = autoRetry ? Brush("#FFB0B0") : Brush("#CCC");
            BtnAuto.Content = autoRetry ? "自动继续: 开" : "自动继续: 关";
        }

        // 状态变化提示：胶囊上方弹出小 toast（2.5s 后淡出）
        static void ShowToast(string text, string hex)
        {
            try
            {
                if (ToastW != null) { try { ToastW.Close(); } catch { } }
                var b = new Border
                {
                    Background = Brush("#E6121820"),
                    BorderBrush = Brush(hex),
                    BorderThickness = new Thickness(1.5),
                    CornerRadius = new CornerRadius(10),
                    Padding = new Thickness(14, 7, 14, 7)
                };
                b.Child = new TextBlock
                {
                    Text = text,
                    Foreground = Brush(hex),
                    FontSize = 14,
                    FontWeight = FontWeights.Bold,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center
                };
                ToastW = new Window
                {
                    WindowStyle = WindowStyle.None,
                    AllowsTransparency = true,
                    Background = Brushes.Transparent,
                    Topmost = true,
                    ShowInTaskbar = false,
                    Width = 260,
                    Height = 42,
                    WindowStartupLocation = WindowStartupLocation.Manual,
                    Content = b
                };
                ToastW.Left = W.Left + (W.Width - 260) / 2;
                ToastW.Top = W.Top - 50;
                ToastW.Show();
                var fade = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(2500) };
                fade.Tick += (s, e) =>
                {
                    fade.Stop();
                    try
                    {
                        var a = new DoubleAnimation { From = 1.0, To = 0.0, Duration = new Duration(TimeSpan.FromMilliseconds(500)) };
                        a.Completed += (s2, e2) => { try { ToastW.Close(); ToastW = null; } catch { } };
                        ToastW.BeginAnimation(UIElement.OpacityProperty, a);
                    }
                    catch { }
                };
                fade.Start();
            }
            catch { }
        }

        // 状态变化提示：胶囊辉光快速闪烁一下
        static void FlashCapsule()
        {
            try
            {
                if (CapGlow != null)
                {
                    var a = new DoubleAnimation { From = 1.0, To = 0.0, Duration = new Duration(TimeSpan.FromMilliseconds(320)), AutoReverse = true };
                    CapGlow.BeginAnimation(DropShadowEffect.OpacityProperty, a);
                }
            }
            catch { }
        }

        static void InvokeState()
        {
            try
            {
                using (var wc = new WebClient { Encoding = Encoding.UTF8 })
                {
                    wc.Headers[HttpRequestHeader.UserAgent] = "onair-widget";
                    string raw = wc.DownloadString(Api + "/api/state");
                    W.Dispatcher.Invoke(new Action(() => UpdateUI(raw)));
                }
            }
            catch { W.Dispatcher.Invoke(new Action(() => UpdateUI(null))); }
        }

        [STAThread]
        static void Main(string[] args)
        {
            if (args.Length > 0) { int p; if (int.TryParse(args[0], out p)) Port = p; }
            Api = "http://127.0.0.1:" + Port;

            string xaml = LoadXaml();
            var app = new Application();
            using (var reader = new XmlNodeReader(new XmlDocument { InnerXml = xaml }))
            {
                W = (Window)System.Windows.Markup.XamlReader.Load(reader);
            }
            if (W == null) { MessageBox.Show("XAML 加载失败"); return; }

            Capsule = Find<Border>("Capsule"); CapDot = Find<Ellipse>("CapDot");
            CapGlow = Capsule.Effect as DropShadowEffect;
            CapDotGlow = CapDot != null ? CapDot.Effect as DropShadowEffect : null;
            CapText = Find<TextBlock>("CapText"); CapCount = Find<TextBlock>("CapCount");
            Panel = Find<Border>("Panel"); PanelHeader = Find<Border>("PanelHeader");
            Tally = Find<TextBlock>("TallyLight"); Ind = Find<TextBlock>("IndicatorText"); SCnt = Find<TextBlock>("SessionCount");
            BtnAuto = Find<Button>("BtnAuto"); BtnClose = Find<Button>("BtnClose");
            AlertBar = Find<Border>("AlertBar"); AlertText = Find<TextBlock>("AlertText");
            SessionList = Find<StackPanel>("SessionList"); EmptyTxt = Find<TextBlock>("EmptyText"); Foot = Find<TextBlock>("Foot");

            BtnClose.Click += (s, e) => W.Close();
            Find<Button>("BtnCollapse").Click += (s, e) => SetExpanded(false);
            Find<Button>("CapClose").Click += (s, e) => W.Close();

            // 胶囊：点击展开；拖动 → 原生 DragMove（120ms 重入计时器 + 6px 阈值）
            Capsule.MouseLeftButtonDown += (s, e) =>
            {
                capDown = true; dragging = false;
                var pt = e.GetPosition(W);
                downX = pt.X; downY = pt.Y;
                if (DragTimer == null)
                {
                    DragTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(120) };
                    DragTimer.Tick += (s2, e2) =>
                    {
                        DragTimer.Stop();
                        if (capDown)
                        {
                            double mx = Mouse.GetPosition(W).X, my = Mouse.GetPosition(W).Y;
                            if (Math.Abs(mx - downX) > 6 || Math.Abs(my - downY) > 6)
                            {
                                dragging = true; capDown = false;
                                try { W.DragMove(); } catch { }
                                dragging = false;
                            }
                            else DragTimer.Start();
                        }
                    };
                }
                DragTimer.Start();
            };
            Capsule.MouseLeftButtonUp += (s, e) =>
            {
                if (DragTimer != null) DragTimer.Stop();
                if (capDown) { capDown = false; SetExpanded(true); }
                dragging = false;
            };
            PanelHeader.MouseLeftButtonDown += (s, e) => { if (e.ButtonState == MouseButtonState.Pressed) { try { W.DragMove(); } catch { } } };
            BtnAuto.Click += (s, e) =>
            {
                autoRetry = !autoRetry; UpdateAutoButton();
                try { using (var wc = new WebClient { Encoding = Encoding.UTF8 }) { wc.Headers[HttpRequestHeader.ContentType] = "application/json"; wc.UploadString(Api + "/api/settings", "POST", "{\"autoRetry\":" + (autoRetry ? "true" : "false") + "}"); } } catch { }
            };

            // 指示灯慢速脉冲（仿 aiPulse 1.8s）
            if (CapDot != null)
            {
                var pulse = new DoubleAnimation { From = 1.0, To = 0.25, Duration = new Duration(TimeSpan.FromMilliseconds(900)), AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever };
                CapDot.BeginAnimation(UIElement.OpacityProperty, pulse);
            }

            PollTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            PollTimer.Tick += (s, e) => { new Thread(InvokeState) { IsBackground = true }.Start(); };
            PollTimer.Start();

            var wa = SystemParameters.WorkArea;
            W.Left = wa.Right - W.Width - 16;
            W.Top = wa.Bottom - W.Height - 16;

            UpdateAutoButton();
            InvokeState();
            app.Run(W);
        }

        static string LoadXaml()
        {
            // 读取同目录 XAML 文件；缺失则用内嵌最小 XAML
            string dir = System.IO.Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            string file = System.IO.Path.Combine(dir, "onair-widget.xaml");
            if (File.Exists(file)) return File.ReadAllText(file, Encoding.UTF8);
            return EmbeddedXaml;
        }

        const string EmbeddedXaml = @"
<Window xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation'
        xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml'
        WindowStyle='None' AllowsTransparency='True' Background='Transparent'
        Topmost='True' ShowInTaskbar='False' Width='180' Height='44' WindowStartupLocation='Manual'>
  <Grid>
    <Border x:Name='Capsule' CornerRadius='16' Background='#FF0A0E0A' BorderBrush='#73FF3B30' BorderThickness='1'
            Cursor='Hand' VerticalAlignment='Center' HorizontalAlignment='Center' Padding='14,0' Height='40'>
      <Border.Effect><DropShadowEffect x:Name='CapGlow' Color='#FFFF3B30' BlurRadius='16' ShadowDepth='0' Opacity='0.7'/></Border.Effect>
      <StackPanel Orientation='Horizontal' VerticalAlignment='Center'>
        <Ellipse x:Name='CapDot' Width='9' Height='9' Fill='#FF3B30' VerticalAlignment='Center' Margin='0,0,9,0'>
          <Ellipse.Effect><DropShadowEffect x:Name='CapDotGlow' Color='#FFFF3B30' BlurRadius='9' ShadowDepth='0' Opacity='0.95'/></Ellipse.Effect>
        </Ellipse>
        <TextBlock x:Name='CapText' Text='ON AIR' FontSize='15' FontWeight='Bold' Foreground='#FF3B30' FontFamily='Consolas' VerticalAlignment='Center'/>
        <TextBlock x:Name='CapCount' Text='' FontSize='13' FontWeight='Bold' Foreground='#FF9A3C' FontFamily='Consolas' VerticalAlignment='Center' Margin='9,0,0,0'/>
        <Button x:Name='CapClose' Content='&#x2715;' FontSize='12' Width='20' Height='20' Padding='0' Margin='9,0,-4,0'
                Background='Transparent' Foreground='#999' BorderThickness='0' Cursor='Hand' VerticalAlignment='Center'/>
      </StackPanel>
    </Border>
    <Border x:Name='Panel' CornerRadius='14' Background='#E6101419' BorderBrush='#55FF5050' BorderThickness='1.5' Visibility='Collapsed'>
      <StackPanel>
        <Border x:Name='PanelHeader' CornerRadius='12,12,0,0' Background='#221A1E2A' Padding='12,10,8,10'>
          <Grid>
            <Grid.ColumnDefinitions><ColumnDefinition Width='*'/><ColumnDefinition Width='Auto'/></Grid.ColumnDefinitions>
            <StackPanel Orientation='Horizontal' VerticalAlignment='Center'>
              <TextBlock x:Name='TallyLight' Text='&#x25CF;' FontSize='20' Foreground='#555' Margin='0,0,8,0' VerticalAlignment='Center'/>
              <TextBlock x:Name='IndicatorText' Text='STANDBY' FontSize='22' FontWeight='Bold' Foreground='#555' VerticalAlignment='Center' FontFamily='Consolas'/>
              <TextBlock x:Name='SessionCount' Text='' FontSize='12' Foreground='#999' Margin='8,0,0,0' VerticalAlignment='Center'/>
            </StackPanel>
            <StackPanel Grid.Column='1' Orientation='Horizontal'>
              <Button x:Name='BtnAuto' Content='自动继续' FontSize='11' Height='24' Padding='8,0' Margin='0,0,6,0' Background='#22FFFFFF' Foreground='#CCC' BorderThickness='1' BorderBrush='#44FFFFFF' Cursor='Hand'/>
              <Button x:Name='BtnCollapse' Content='&#x2013;' FontSize='12' Width='24' Height='24' Padding='0' Margin='0,0,6,0' Background='#22FFFFFF' Foreground='#CCC' BorderThickness='1' BorderBrush='#44FFFFFF' Cursor='Hand'/>
              <Button x:Name='BtnClose' Content='&#x2715;' FontSize='12' Width='24' Height='24' Padding='0' Background='#33FF5050' Foreground='#FF9A9A' BorderThickness='0' Cursor='Hand'/>
            </StackPanel>
          </Grid>
        </Border>
        <Border x:Name='AlertBar' Background='#22FF5050' Padding='10,6' Visibility='Collapsed'>
          <TextBlock x:Name='AlertText' Text='' FontSize='12' Foreground='#FFD0D0' TextWrapping='Wrap' MaxHeight='44'/>
        </Border>
        <ScrollViewer VerticalScrollBarVisibility='Auto' MaxHeight='380'>
          <StackPanel x:Name='SessionList' Margin='8'/>
        </ScrollViewer>
        <TextBlock x:Name='EmptyText' Text='暂无进行中的会话。会话进入「活动中」会显示 ON AIR。' FontSize='12' Foreground='#777' Margin='12,4' TextWrapping='Wrap'/>
        <Border BorderThickness='0,1,0,0' BorderBrush='#33FFFFFF' Padding='10,6'>
          <TextBlock x:Name='Foot' FontSize='11' Foreground='#888'/>
        </Border>
      </StackPanel>
    </Border>
  </Grid>
</Window>";
    }
}
