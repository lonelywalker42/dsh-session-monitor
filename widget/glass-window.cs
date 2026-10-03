// Shared native backdrop for the executable and PowerShell fallback.
using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;

namespace DshOnAir
{
    public static class GlassWindow
    {
        [StructLayout(LayoutKind.Sequential)]
        struct AccentPolicy { public int State, Flags, GradientColor, AnimationId; }
        [StructLayout(LayoutKind.Sequential)]
        struct CompositionData { public int Attribute; public IntPtr Data; public int Size; }
        [DllImport("user32.dll")]
        static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref CompositionData data);
        [DllImport("gdi32.dll")]
        static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);
        [DllImport("user32.dll")]
        static extern int SetWindowRgn(IntPtr hwnd, IntPtr region, bool redraw);
        [DllImport("gdi32.dll")]
        static extern bool DeleteObject(IntPtr obj);

        public static void Attach(Window window)
        {
            window.SourceInitialized += delegate { Apply(window); };
            window.SizeChanged += delegate { Round(window); };
        }

        static void Apply(Window window)
        {
            bool enabled = false;
            IntPtr memory = IntPtr.Zero;
            try
            {
                if (!SystemParameters.HighContrast)
                {
                    var policy = new AccentPolicy { State = 3 }; // Native blur behind, never blur text.
                    int size = Marshal.SizeOf(policy);
                    memory = Marshal.AllocHGlobal(size);
                    Marshal.StructureToPtr(policy, memory, false);
                    var data = new CompositionData { Attribute = 19, Data = memory, Size = size };
                    enabled = SetWindowCompositionAttribute(new WindowInteropHelper(window).Handle, ref data) != 0;
                }
            }
            catch (EntryPointNotFoundException) { }
            catch (DllNotFoundException) { }
            finally { if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory); }
            if (!enabled)
            {
                foreach (string name in new[] { "Capsule", "Panel" })
                {
                    var border = window.FindName(name) as Border;
                    if (border != null) border.Background = new SolidColorBrush(Color.FromRgb(28, 38, 61));
                }
            }
            Round(window);
        }

        static void Round(Window window)
        {
            IntPtr hwnd = new WindowInteropHelper(window).Handle;
            if (hwnd == IntPtr.Zero) return;
            var source = PresentationSource.FromVisual(window);
            if (source == null || source.CompositionTarget == null) return;
            var dpi = source.CompositionTarget.TransformToDevice;
            int radius = (int)(40 * dpi.M11);
            // SetWindowRgn owns a successfully assigned region; free only on failure.
            IntPtr region = CreateRoundRectRgn(0, 0, (int)Math.Ceiling(window.ActualWidth * dpi.M11) + 1,
                (int)Math.Ceiling(window.ActualHeight * dpi.M22) + 1, radius, radius);
            if (region != IntPtr.Zero && SetWindowRgn(hwnd, region, true) == 0) DeleteObject(region);
        }
    }
}
