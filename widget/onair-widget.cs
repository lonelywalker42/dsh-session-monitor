// onair-widget.cs — DSH 会话监控桌面件（原生 C# WPF，编译为独立 .exe，无需 powershell）
// 与 onair-widget.ps1 同功能：ON AIR 胶囊 + 展开面板 + 429 告警 + 自动继续开关。
// 数据源 http://127.0.0.1:8091/api/state（主机侧监控，独立于 webui）。
// 编译（.NET Framework 4.8 csc）：node widget/build.mjs
// 同时编译 glass-window.cs，并内嵌共享 onair-widget.xaml。
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
        static bool SettingsPending;
        static string InstanceId = "", ExpectedInstance = "";
        static int PollInFlight;

        class TimeoutWebClient : WebClient
        {
            protected override WebRequest GetWebRequest(Uri address)
            {
                var request = base.GetWebRequest(address);
                request.Timeout = 3500;
                return request;
            }
        }

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
        static bool capDown, expanded, autoRetry;
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
            if (expanded) { W.Width = 400; W.Height = 520; }
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
            if (CapGlow != null) { CapGlow.Color = col; CapGlow.Opacity = text == "429" ? 0.35 : 0.15; }
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
            if (string.IsNullOrEmpty(raw)) { BtnAuto.IsEnabled = false; ApplyIndicator("OFFLINE", "#FDA4AF"); Foot.Text = "宿主离线 · 列表为上次同步结果"; return; }
            Dictionary<string, object> st;
            try { st = Json.Deserialize<Dictionary<string, object>>(raw); }
            catch { BtnAuto.IsEnabled = false; ApplyIndicator("OFFLINE", "#FDA4AF"); Foot.Text = "状态解析失败"; return; }

            var identity = Safe(st, "instance", null) as Dictionary<string, object>;
            string receivedId = Convert.ToString(Safe(identity, "id", ""));
            if (receivedId == "" || (ExpectedInstance != "" && receivedId != ExpectedInstance) || (InstanceId != "" && receivedId != InstanceId))
            {
                BtnAuto.IsEnabled = false; ApplyIndicator("UNBOUND", "#FDA4AF");
                Foot.Text = "宿主身份不匹配，请从对应宿主重新打开桌面件"; return;
            }
            InstanceId = receivedId; BtnAuto.IsEnabled = !SettingsPending;

            var settings = st.ContainsKey("settings") ? st["settings"] as Dictionary<string, object> : null;
            autoRetry = Convert.ToBoolean(Safe(settings, "autoRetry", false));
            UpdateAutoButton();

            // 主机关闭桌面显示 → 自动退出
            if (settings != null && settings.ContainsKey("desktopDisplay") && Convert.ToBoolean(settings["desktopDisplay"]) == false)
            { W.Close(); return; }

            var sessions = st.ContainsKey("sessions") ? st["sessions"] as ArrayList : new ArrayList();
            bool any429 = false, anyError = false, anyWait = false, anyAct = false, anyDone = false;
            foreach (var o in sessions)
            {
                var s = o as Dictionary<string, object>; if (s == null) continue;
                string rawState = Convert.ToString(Safe(s, "state", ""));
                if (rawState == "error429") any429 = true;
                else if (rawState == "error") anyError = true;
                else if (rawState == "waiting-answer" || rawState == "waiting-approval") anyWait = true;
                else if (rawState == "active") anyAct = true;
                else if (rawState == "complete") anyDone = true;
            }
            SCnt.Text = sessions.Count > 0 ? sessions.Count + " 个会话" : "";
            CapCount.Text = sessions.Count > 0 ? Convert.ToString(sessions.Count) : "";
            EmptyTxt.Visibility = sessions.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

            string state, stateColor;
            if (any429) { state = "429"; stateColor = "#FDA4AF"; }
            else if (anyError) { state = "ERROR"; stateColor = "#FDA4AF"; }
            else if (anyWait) { state = "WAITING"; stateColor = "#93C5FD"; }
            else if (anyAct) { state = "ON AIR"; stateColor = "#6EE7B7"; }
            else if (anyDone) { state = "DONE"; stateColor = "#C4B5FD"; }
            else { state = "STANDBY"; stateColor = "#AAB8D2"; }
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

                string rowState = Convert.ToString(Safe(s, "state", ""));
                string rowColor = rowState == "active" ? "#6EE7B7" : rowState.StartsWith("waiting") ? "#93C5FD"
                    : rowState == "complete" ? "#C4B5FD" : rowState.StartsWith("error") ? "#FDA4AF" : "#AAB8D2";
                var row = new Border { Margin = new Thickness(0, 4, 0, 4), Background = Brush("#0EBDD0FF"), BorderBrush = Brush("#20BDD0FF"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(12), Padding = new Thickness(12), ToolTip = title + " · " + Convert.ToString(Safe(s, "cwd", "")) };
                var col = new StackPanel();
                var t1 = new TextBlock { Text = title, FontSize = 12.5, FontWeight = FontWeights.SemiBold, Foreground = Brush("#E8EEFB"), TextTrimming = TextTrimming.CharacterEllipsis };
                var pathText = new TextBlock { Text = cwd, FontSize = 11, Foreground = Brush("#AAB8D2"), Margin = new Thickness(0, 4, 0, 0), TextTrimming = TextTrimming.CharacterEllipsis };
                var t2 = new TextBlock { Text = "● " + stt + " · " + act + (retries != "0" ? " · 已继续 " + retries + " 次" : ""), FontSize = 11, Foreground = Brush(rowColor), Margin = new Thickness(0, 8, 0, 0), TextTrimming = TextTrimming.CharacterEllipsis };
                col.Children.Add(t1); col.Children.Add(pathText); col.Children.Add(t2);
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
            BtnAuto.Background = autoRetry ? Brush("#257598F1") : Brush("#12BDD0FF");
            BtnAuto.Foreground = autoRetry ? Brush("#BDD0FF") : Brush("#DCE6FA");
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
            if (Interlocked.CompareExchange(ref PollInFlight, 1, 0) != 0) return;
            try
            {
                using (var wc = new TimeoutWebClient { Encoding = Encoding.UTF8 })
                {
                    wc.Headers[HttpRequestHeader.UserAgent] = "onair-widget";
                    string raw = wc.DownloadString(Api + "/api/state");
                    W.Dispatcher.Invoke(new Action(() => UpdateUI(raw)));
                }
            }
            catch { if (!W.Dispatcher.HasShutdownStarted) { try { W.Dispatcher.Invoke(new Action(() => UpdateUI(null))); } catch { } } }
            finally { Interlocked.Exchange(ref PollInFlight, 0); }
        }

        [STAThread]
        static void Main(string[] args)
        {
            if (args.Length > 0) { int p; if (int.TryParse(args[0], out p)) Port = p; }
            int instanceArgument = Array.IndexOf(args, "--instance");
            if (instanceArgument >= 0 && instanceArgument + 1 < args.Length) ExpectedInstance = args[instanceArgument + 1];
            Api = "http://127.0.0.1:" + Port;

            string xaml = LoadXaml();
            var app = new Application();
            using (var reader = new XmlNodeReader(new XmlDocument { InnerXml = xaml }))
            {
                W = (Window)System.Windows.Markup.XamlReader.Load(reader);
            }
            if (W == null) { MessageBox.Show("XAML 加载失败"); return; }
            GlassWindow.Attach(W);

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
                capDown = true;
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
                                capDown = false;
                                try { W.DragMove(); } catch { }
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
            };
            PanelHeader.MouseLeftButtonDown += (s, e) => { if (e.ButtonState == MouseButtonState.Pressed) { try { W.DragMove(); } catch { } } };
            BtnAuto.Click += (s, e) =>
            {
                if (InstanceId == "") return;
                bool next = !autoRetry; SettingsPending = true; BtnAuto.IsEnabled = false;
                new Thread(() => {
                    try {
                        using (var wc = new TimeoutWebClient { Encoding = Encoding.UTF8 }) {
                            wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                            wc.Headers["X-DSH-Monitor-Instance"] = InstanceId;
                            var result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(wc.UploadString(Api + "/api/settings", "POST", "{\"autoRetry\":" + (next ? "true" : "false") + "}"));
                            var responseInstance = Safe(result, "instance", null) as Dictionary<string, object>;
                            if (responseInstance == null || Convert.ToString(Safe(responseInstance, "id", "")) != InstanceId) throw new Exception("宿主身份不匹配");
                            if (!Convert.ToBoolean(Safe(result, "ok", false))) throw new Exception("设置未保存");
                            W.Dispatcher.Invoke(new Action(() => { SettingsPending = false; autoRetry = next; UpdateAutoButton(); BtnAuto.IsEnabled = true; }));
                        }
                    } catch { if (!W.Dispatcher.HasShutdownStarted) W.Dispatcher.Invoke(new Action(() => { SettingsPending = false; Foot.Text = "设置保存失败，请重试"; BtnAuto.IsEnabled = false; })); }
                }) { IsBackground = true }.Start();
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
            W.Closed += (s, e) => { PollTimer.Stop(); if (DragTimer != null) DragTimer.Stop(); };

            var wa = SystemParameters.WorkArea;
            W.Left = wa.Right - W.Width - 16;
            W.Top = wa.Bottom - W.Height - 16;

            if (Array.IndexOf(args, "--expanded") >= 0) SetExpanded(true);

            UpdateAutoButton();
            new Thread(InvokeState) { IsBackground = true }.Start();
            app.Run(W);
        }

        static string LoadXaml()
        {
            // 读取同目录 XAML 文件；缺失则用相同布局的内嵌资源。
            string dir = System.IO.Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            string file = System.IO.Path.Combine(dir, "onair-widget.xaml");
            if (File.Exists(file)) return File.ReadAllText(file, Encoding.UTF8);
            using (var stream = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("DshOnAir.onair-widget.xaml"))
            {
                if (stream == null) throw new FileNotFoundException("缺少桌面件布局资源，请使用 widget/build.mjs 编译。");
                using (var reader = new StreamReader(stream, Encoding.UTF8)) return reader.ReadToEnd();
            }
        }
    }
}
