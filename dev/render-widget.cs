// Offscreen QA of the shipped XAML and production UpdateUI; no window is shown.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Xml;

class RenderWidget
{
    [STAThread]
    static void Main(string[] args)
    {
        var assembly = Assembly.LoadFrom(args[0]);
        var program = assembly.GetType("DshOnAir.Program");
        var flags = BindingFlags.NonPublic | BindingFlags.Static;
        var xaml = (string)program.GetMethod("LoadXaml", flags).Invoke(null, null);
        Window window;
        using (var reader = new XmlNodeReader(new XmlDocument { InnerXml = xaml })) window = (Window)XamlReader.Load(reader);
        window.Width = 400; window.Height = 520;
        program.GetField("W", flags).SetValue(null, window);
        var names = new Dictionary<string, string> {
            {"Capsule","Capsule"}, {"Panel","Panel"}, {"PanelHeader","PanelHeader"}, {"CapDot","CapDot"},
            {"CapText","CapText"}, {"CapCount","CapCount"}, {"Tally","TallyLight"}, {"Ind","IndicatorText"},
            {"SCnt","SessionCount"}, {"EmptyTxt","EmptyText"}, {"Foot","Foot"}, {"AlertText","AlertText"},
            {"AlertBar","AlertBar"}, {"SessionList","SessionList"}, {"BtnAuto","BtnAuto"}, {"BtnClose","BtnClose"}
        };
        foreach (var item in names) {
            var element = window.FindName(item.Value);
            if (element == null) throw new Exception("Missing production control: " + item.Key);
            program.GetField(item.Key, flags).SetValue(null, element);
        }
        program.GetField("Api", flags).SetValue(null, "http://127.0.0.1:18091");
        program.GetField("prevState", flags).SetValue(null, "WAITING"); // avoid notification windows
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var sessions = new[] {
            new {id="approval", title="Knowledge · PersonalProject", cwd="D:/PersonalProject/Knowledge", state="waiting-approval", stateText="等待批准", lastActivity=now, activeSince=0L, retries=0},
            new {id="research", title="先充分了解这份代码研究的问题和运行方式", cwd="D:/Research/DeepSeek", state="active", stateText="活动中", lastActivity=now, activeSince=now-93000, retries=0},
            new {id="done", title="会话监控工具 UI 优化", cwd="D:/DshWork/dsh-session-monitor", state="complete", stateText="工作完成", lastActivity=now, activeSince=0L, retries=0}
        };
        string snapshot = new JavaScriptSerializer().Serialize(new { instance=new {id="preview-host",profile="preview"}, settings=new {autoRetry=false,desktopDisplay=true}, sessions=sessions });
        program.GetMethod("UpdateUI", flags).Invoke(null, new object[] { snapshot });
        ((Border)window.FindName("Capsule")).Visibility = Visibility.Collapsed;
        ((Border)window.FindName("Panel")).Visibility = Visibility.Visible;
        var grid = (Grid)window.Content;
        grid.Measure(new Size(400,520)); grid.Arrange(new Rect(0,0,400,520)); grid.UpdateLayout();
        var list = (StackPanel)window.FindName("SessionList");
        if (list.Children.Count != 3) throw new Exception("Production UpdateUI did not render all sessions");
        foreach (FrameworkElement row in list.Children) {
            if (row.ActualWidth < 300 || row.ActualHeight < 60) throw new Exception("Session row layout is clipped");
        }
        var bitmap = new RenderTargetBitmap(400,520,96,96,PixelFormats.Pbgra32);
        bitmap.Render(grid);
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using (var file = File.Create(args[1])) encoder.Save(file);
        window.Close();
        Console.WriteLine("WPF layout verified; foreground preview: " + args[1] + " (system backdrop not captured).");
    }
}
