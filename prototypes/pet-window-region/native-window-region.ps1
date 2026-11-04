$ErrorActionPreference = "Stop"

$dpiBootstrapSource = @'
using System;
using System.Runtime.InteropServices;

public static class RegionDpiBootstrap
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiAwarenessContext);

    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int awareness);

    public static string Enable()
    {
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
        if (SetProcessDpiAwarenessContext(new IntPtr(-4)))
        {
            return "PerMonitorV2";
        }

        int error = Marshal.GetLastWin32Error();
        int result = SetProcessDpiAwareness(2);
        return result == 0 ? "PerMonitor" : "AlreadySetOrUnavailable:Win32=" + error + ",HRESULT=" + result;
    }
}
'@

Add-Type -TypeDefinition $dpiBootstrapSource -Language CSharp
$dpiAwarenessMode = [RegionDpiBootstrap]::Enable()


Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;

public static class NativeWindowRegion
{
    private const int GWL_EXSTYLE = -20;

    private const long WS_EX_TOPMOST = 0x00000008L;
    private const long WS_EX_TOOLWINDOW = 0x00000080L;
    private const long WS_EX_NOACTIVATE = 0x08000000L;

    private static readonly IntPtr HWND_TOP = IntPtr.Zero;
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_SHOWWINDOW = 0x0040;

    private const uint GW_HWNDPREV = 3;
    private const uint GA_ROOT = 2;

    private const uint SW_HIDE = 0;
    private const uint SW_SHOWNOACTIVATE = 4;

    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, uint cmdShow);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachFlag);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetCursorPos(out POINT point);

    public static string Format(IntPtr handle)
    {
        return handle.ToInt64().ToString(CultureInfo.InvariantCulture);
    }

    private static IntPtr Parse(string text)
    {
        long raw = long.Parse(text, CultureInfo.InvariantCulture);
        return new IntPtr(raw);
    }

    public static string Root(string hwndText)
    {
        IntPtr root = GetAncestor(Parse(hwndText), GA_ROOT);
        return root == IntPtr.Zero ? "0" : Format(root);
    }

    public static string Foreground()
    {
        return Format(GetForegroundWindow());
    }

    public static string WindowFromPointRoot(int x, int y)
    {
        POINT point;
        point.X = x;
        point.Y = y;
        IntPtr hit = WindowFromPoint(point);
        if (hit == IntPtr.Zero)
        {
            return "0";
        }

        IntPtr root = GetAncestor(hit, GA_ROOT);
        return Format(root == IntPtr.Zero ? hit : root);
    }

    public static string TaskbarWindow()
    {
        return Format(FindWindow("Shell_TrayWnd", null));
    }

    public static string GetRect(string hwndText)
    {
        RECT rect;
        if (!GetWindowRect(Parse(hwndText), out rect))
        {
            return null;
        }

        return string.Format(
            CultureInfo.InvariantCulture,
            "{0},{1},{2},{3}",
            rect.Left,
            rect.Top,
            rect.Right,
            rect.Bottom);
    }

    public static bool ApplyExStyle(
        string hwndText,
        bool toolWindow,
        bool noActivate,
        bool clearTopmost,
        out string after)
    {
        IntPtr hwnd = Parse(hwndText);
        long value = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();

        if (toolWindow)
        {
            value |= WS_EX_TOOLWINDOW;
        }

        if (noActivate)
        {
            value |= WS_EX_NOACTIVATE;
        }
        else
        {
            value &= ~WS_EX_NOACTIVATE;
        }

        if (clearTopmost)
        {
            value &= ~WS_EX_TOPMOST;
        }

        SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(value));
        long actual = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        after = "0x" + actual.ToString("X8", CultureInfo.InvariantCulture);
        return (actual & WS_EX_NOACTIVATE) == (noActivate ? WS_EX_NOACTIVATE : 0L);
    }

    public static bool Raise(string hwndText, out int win32Error)
    {
        bool result = SetWindowPos(
            Parse(hwndText),
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        win32Error = result ? 0 : Marshal.GetLastWin32Error();
        return result;
    }

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);

    [DllImport("gdi32.dll")]
    private static extern int CombineRgn(IntPtr dest, IntPtr src1, IntPtr src2, int mode);

    [DllImport("user32.dll")]
    private static extern int SetWindowRgn(IntPtr hwnd, IntPtr region, bool redraw);

    public static bool ApplyRegion(
        string hwndText,
        bool clipTaskbar,
        int taskbarLeft,
        int taskbarTop,
        int taskbarRight,
        int taskbarBottom,
        out string detail)
    {
        IntPtr hwnd = Parse(hwndText);
        RECT windowRect;
        if (!GetWindowRect(hwnd, out windowRect))
        {
            detail = "GetWindowRect failed";
            return false;
        }

        int width = windowRect.Right - windowRect.Left;
        int height = windowRect.Bottom - windowRect.Top;

        if (!clipTaskbar)
        {
            // Passing a null region removes the clip entirely.
            detail = SetWindowRgn(hwnd, IntPtr.Zero, true) != 0 ? "region cleared" : "region clear failed";
            return true;
        }

        int left = Math.Max(taskbarLeft, windowRect.Left) - windowRect.Left;
        int top = Math.Max(taskbarTop, windowRect.Top) - windowRect.Top;
        int right = Math.Min(taskbarRight, windowRect.Right) - windowRect.Left;
        int bottom = Math.Min(taskbarBottom, windowRect.Bottom) - windowRect.Top;

        IntPtr region = CreateRectRgn(0, 0, width, height);
        if (right > left && bottom > top)
        {
            IntPtr cut = CreateRectRgn(left, top, right, bottom);
            CombineRgn(region, region, cut, 4 /* RGN_DIFF */);
            detail = string.Format(CultureInfo.InvariantCulture, "window {0}x{1}, cut {2},{3},{4},{5}", width, height, left, top, right, bottom);
        }
        else
        {
            detail = string.Format(CultureInfo.InvariantCulture, "window {0}x{1}, no overlap with the taskbar band", width, height);
        }

        return SetWindowRgn(hwnd, region, true) != 0;
    }

    public static bool TopMost(string hwndText, bool on, out int win32Error)
    {
        bool result = SetWindowPos(
            Parse(hwndText),
            on ? HWND_TOPMOST : HWND_NOTOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        win32Error = result ? 0 : Marshal.GetLastWin32Error();
        return result;
    }

    public static bool Move(string hwndText, int x, int y, out int win32Error)
    {
        bool result = SetWindowPos(
            Parse(hwndText),
            IntPtr.Zero,
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        win32Error = result ? 0 : Marshal.GetLastWin32Error();
        return result;
    }

    public static void SetVisible(string hwndText, bool visible)
    {
        ShowWindow(Parse(hwndText), visible ? SW_SHOWNOACTIVATE : SW_HIDE);
    }

    public static int CompareZ(string aText, string bText)
    {
        IntPtr a = Parse(aText);
        IntPtr b = Parse(bText);

        IntPtr cursor = a;
        for (int guard = 0; cursor != IntPtr.Zero && guard < 5000; guard++)
        {
            if (cursor == b)
            {
                return -1;
            }

            cursor = GetWindow(cursor, GW_HWNDPREV);
        }

        cursor = b;
        for (int guard = 0; cursor != IntPtr.Zero && guard < 5000; guard++)
        {
            if (cursor == a)
            {
                return 1;
            }

            cursor = GetWindow(cursor, GW_HWNDPREV);
        }

        return 0;
    }

    public static bool FocusWindow(string hwndText, out string method)
    {
        IntPtr hwnd = Parse(hwndText);

        if (GetForegroundWindow() == hwnd)
        {
            method = "alreadyForeground";
            return true;
        }

        if (SetForegroundWindow(hwnd))
        {
            method = "SetForegroundWindow";
            return true;
        }

        // Attaching to the *foreground* thread (not the target thread) is what
        // lifts the foreground lock for a background process.
        uint currentThread = GetCurrentThreadId();
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        if (foregroundThread != 0 && AttachThreadInput(currentThread, foregroundThread, true))
        {
            bool attached = SetForegroundWindow(hwnd);
            AttachThreadInput(currentThread, foregroundThread, false);
            if (attached)
            {
                method = "AttachThreadInput";
                return true;
            }
        }

        // Windows foreground lock: a synthetic ALT press makes the calling
        // process count as recently interacted with, which unlocks
        // SetForegroundWindow for a background overlay process.
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        if (SetForegroundWindow(hwnd) || GetForegroundWindow() == hwnd)
        {
            method = "altKeyUnlock";
            return true;
        }

        method = "failed";
        return GetForegroundWindow() == hwnd;
    }

    public static bool Click(int x, int y)
    {
        POINT previous;
        bool hasPrevious = GetCursorPos(out previous);

        if (!SetCursorPos(x, y))
        {
            return false;
        }

        System.Threading.Thread.Sleep(60);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(60);

        if (hasPrevious)
        {
            SetCursorPos(previous.X, previous.Y);
        }

        return true;
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

function Write-JsonLine {
    param([Parameter(Mandatory = $true)][hashtable]$Message)

    [Console]::Out.WriteLine(($Message | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
}

function Get-ScreenPixel {
    param([int]$X, [int]$Y)

    $bitmap = New-Object System.Drawing.Bitmap 1, 1
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size 1, 1))
        $pixel = $bitmap.GetPixel(0, 0)
        return @{
            r = [int]$pixel.R
            g = [int]$pixel.G
            b = [int]$pixel.B
            hex = ("#{0:X2}{1:X2}{2:X2}" -f $pixel.R, $pixel.G, $pixel.B)
        }
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

Write-JsonLine @{ kind = "ready"; pid = $PID; dpiAwareness = $dpiAwarenessMode }

while (($line = [Console]::In.ReadLine()) -ne $null) {
    if ([string]::IsNullOrWhiteSpace($line)) {
        continue
    }

    $request = $null
    try {
        $request = $line | ConvertFrom-Json

        if ($request.op -eq "exit") {
            Write-JsonLine @{ kind = "result"; id = $request.id; op = "exit"; ok = $true }
            break
        }

        $response = @{
            kind = "result"
            id = $request.id
            op = $request.op
            ok = $true
        }

        switch ($request.op) {
            "style" {
                $after = ""
                $ok = [NativeWindowRegion]::ApplyExStyle(
                    [string]$request.hwnd,
                    [bool]$request.toolWindow,
                    [bool]$request.noActivate,
                    [bool]$request.clearTopmost,
                    [ref]$after)
                $response.ok = $ok
                $response.exStyle = $after
            }
            "region" {
                $detail = ""
                $response.ok = [NativeWindowRegion]::ApplyRegion(
                    [string]$request.hwnd,
                    [bool]$request.clipTaskbar,
                    [int]$request.taskbarLeft,
                    [int]$request.taskbarTop,
                    [int]$request.taskbarRight,
                    [int]$request.taskbarBottom,
                    [ref]$detail)
                $response.detail = $detail
            }
            "topmost" {
                $win32Error = 0
                $response.ok = [NativeWindowRegion]::TopMost([string]$request.hwnd, [bool]$request.on, [ref]$win32Error)
                $response.win32Error = $win32Error
            }
            "raise" {
                $win32Error = 0
                $response.ok = [NativeWindowRegion]::Raise([string]$request.hwnd, [ref]$win32Error)
                $response.win32Error = $win32Error
            }
            "move" {
                $win32Error = 0
                $response.ok = [NativeWindowRegion]::Move(
                    [string]$request.hwnd,
                    [int]$request.x,
                    [int]$request.y,
                    [ref]$win32Error)
                $response.win32Error = $win32Error
            }
            "visible" {
                [NativeWindowRegion]::SetVisible([string]$request.hwnd, [bool]$request.visible)
            }
            "rect" {
                $response.rect = [NativeWindowRegion]::GetRect([string]$request.hwnd)
                $response.ok = $null -ne $response.rect
            }
            "foreground" {
                $response.hwnd = [NativeWindowRegion]::Foreground()
            }
            "root" {
                $response.hwnd = [NativeWindowRegion]::Root([string]$request.hwnd)
            }
            "taskbar" {
                $hwnd = [NativeWindowRegion]::TaskbarWindow()
                $response.hwnd = $hwnd
                $response.ok = ($hwnd -ne "0")
                if ($hwnd -ne "0") {
                    $response.rect = [NativeWindowRegion]::GetRect($hwnd)
                }
            }
            "compareZ" {
                $response.value = [NativeWindowRegion]::CompareZ([string]$request.hwndA, [string]$request.hwndB)
            }
            "windowFromPoint" {
                $response.hwnd = [NativeWindowRegion]::WindowFromPointRoot([int]$request.x, [int]$request.y)
            }
            "focus" {
                $method = ""
                $response.ok = [NativeWindowRegion]::FocusWindow([string]$request.hwnd, [ref]$method)
                $response.method = $method
                $response.foreground = [NativeWindowRegion]::Foreground()
            }
            "pixel" {
                $response.pixel = Get-ScreenPixel -X ([int]$request.x) -Y ([int]$request.y)
            }
            "click" {
                $response.ok = [NativeWindowRegion]::Click([int]$request.x, [int]$request.y)
                $response.foreground = [NativeWindowRegion]::Foreground()
            }
            default {
                $response.ok = $false
                $response.error = "unsupported op: $($request.op)"
            }
        }

        Write-JsonLine $response
    }
    catch {
        Write-JsonLine @{
            kind = "error"
            id = $request.id
            op = $request.op
            message = $_.Exception.Message
        }
    }
}
