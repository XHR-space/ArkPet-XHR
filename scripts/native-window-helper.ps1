$ErrorActionPreference = "Stop"

$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

$dpiBootstrapSource = @'
using System;
using System.Runtime.InteropServices;

public static class NativeWindowDpiBootstrap
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiAwarenessContext);

    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int awareness);

    public static string Enable()
    {
        try
        {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
            if (SetProcessDpiAwarenessContext(new IntPtr(-4)))
            {
                return "PerMonitorV2";
            }
        }
        catch (EntryPointNotFoundException)
        {
        }

        try
        {
            int result = SetProcessDpiAwareness(2);
            return result == 0 ? "PerMonitor" : "AlreadySetOrUnavailable";
        }
        catch (EntryPointNotFoundException)
        {
            return "Unavailable";
        }
    }
}
'@

Add-Type -TypeDefinition $dpiBootstrapSource -Language CSharp
$dpiAwarenessMode = [NativeWindowDpiBootstrap]::Enable()

$nativeSource = @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;

public static class NativeWindowBridge
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
    private const uint SWP_FRAMECHANGED = 0x0020;

    private const uint MONITOR_DEFAULTTOPRIMARY = 1;
    private const int MDT_EFFECTIVE_DPI = 0;
    private const int RGN_DIFF = 4;

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

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachFlag);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);

    [DllImport("gdi32.dll")]
    private static extern int CombineRgn(IntPtr dest, IntPtr src1, IntPtr src2, int mode);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    [DllImport("user32.dll")]
    private static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(POINT point, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO monitorInfo);

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(IntPtr hMonitor, int dpiType, out uint dpiX, out uint dpiY);

    private static IntPtr ParseHandle(string text)
    {
        ulong raw;
        if (!ulong.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out raw))
        {
            throw new ArgumentException("Invalid window handle: " + text);
        }

        return new IntPtr(unchecked((long)raw));
    }

    private static string FormatRect(RECT rect)
    {
        return string.Format(
            CultureInfo.InvariantCulture,
            "{0},{1},{2},{3}",
            rect.Left,
            rect.Top,
            rect.Right,
            rect.Bottom);
    }

    public static bool ApplyPetWindowStyle(string hwndText, out string exStyle, out int win32Error)
    {
        IntPtr hwnd = ParseHandle(hwndText);
        long current = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        long next = current | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;

        IntPtr previous = SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(next));
        win32Error = Marshal.GetLastWin32Error();
        bool changed = previous != IntPtr.Zero || win32Error == 0;
        bool positioned = false;

        if (changed)
        {
            positioned = SetWindowPos(
                hwnd,
                IntPtr.Zero,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            if (!positioned)
            {
                win32Error = Marshal.GetLastWin32Error();
            }
        }

        long actual = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        exStyle = "0x" + actual.ToString("X8", CultureInfo.InvariantCulture);
        return changed && positioned;
    }

    public static bool SetTopmost(string hwndText, bool on, out int win32Error)
    {
        bool result = SetWindowPos(
            ParseHandle(hwndText),
            on ? HWND_TOPMOST : HWND_NOTOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        win32Error = result ? 0 : Marshal.GetLastWin32Error();
        return result;
    }

    public static bool SetNoActivate(
        string hwndText,
        bool on,
        out string exStyle,
        out int win32Error)
    {
        IntPtr hwnd = ParseHandle(hwndText);
        long current = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        long next = on
            ? current | WS_EX_NOACTIVATE
            : current & ~WS_EX_NOACTIVATE;
        IntPtr previous = SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(next));
        win32Error = Marshal.GetLastWin32Error();
        bool changed = previous != IntPtr.Zero || win32Error == 0;
        bool positioned = true;

        if (changed)
        {
            positioned = SetWindowPos(
                hwnd,
                IntPtr.Zero,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            if (!positioned)
            {
                win32Error = Marshal.GetLastWin32Error();
            }
        }

        long actual = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        exStyle = "0x" + actual.ToString("X8", CultureInfo.InvariantCulture);
        return changed && positioned;
    }

    public static bool Raise(string hwndText, out int win32Error)
    {
        bool result = SetWindowPos(
            ParseHandle(hwndText),
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        win32Error = result ? 0 : Marshal.GetLastWin32Error();
        return result;
    }

    public static bool FocusWindow(string hwndText, out string method)
    {
        IntPtr hwnd = ParseHandle(hwndText);
        IntPtr foreground = GetForegroundWindow();
        if (foreground == hwnd)
        {
            method = "alreadyForeground";
            return true;
        }

        if (SetForegroundWindow(hwnd))
        {
            method = "SetForegroundWindow";
            return true;
        }

        uint currentThread = GetCurrentThreadId();
        uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
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

    public static bool Move(string hwndText, int x, int y, out int win32Error)
    {
        bool result = SetWindowPos(
            ParseHandle(hwndText),
            IntPtr.Zero,
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        win32Error = result ? 0 : Marshal.GetLastWin32Error();
        return result;
    }

    public static bool ExcludeTaskbar(
        string hwndText,
        int taskbarLeft,
        int taskbarTop,
        int taskbarRight,
        int taskbarBottom,
        out string detail,
        out int win32Error)
    {
        IntPtr hwnd = ParseHandle(hwndText);
        RECT windowRect;
        if (!GetWindowRect(hwnd, out windowRect))
        {
            detail = "GetWindowRect failed";
            win32Error = Marshal.GetLastWin32Error();
            return false;
        }

        int width = windowRect.Right - windowRect.Left;
        int height = windowRect.Bottom - windowRect.Top;
        if (width <= 0 || height <= 0)
        {
            detail = "Invalid window rectangle";
            win32Error = 0;
            return false;
        }

        int left = Math.Max(taskbarLeft, windowRect.Left) - windowRect.Left;
        int top = Math.Max(taskbarTop, windowRect.Top) - windowRect.Top;
        int right = Math.Min(taskbarRight, windowRect.Right) - windowRect.Left;
        int bottom = Math.Min(taskbarBottom, windowRect.Bottom) - windowRect.Top;

        IntPtr region = CreateRectRgn(0, 0, width, height);
        if (region == IntPtr.Zero)
        {
            detail = "CreateRectRgn failed";
            win32Error = Marshal.GetLastWin32Error();
            return false;
        }

        bool hasOverlap = right > left && bottom > top;
        if (hasOverlap)
        {
            IntPtr cut = CreateRectRgn(left, top, right, bottom);
            if (cut == IntPtr.Zero)
            {
                DeleteObject(region);
                detail = "CreateRectRgn for taskbar failed";
                win32Error = Marshal.GetLastWin32Error();
                return false;
            }

            CombineRgn(region, region, cut, RGN_DIFF);
            DeleteObject(cut);
        }

        bool result = SetWindowRgn(hwnd, region, true) != 0;
        win32Error = result ? 0 : Marshal.GetLastWin32Error();
        if (!result)
        {
            DeleteObject(region);
        }

        detail = string.Format(
            CultureInfo.InvariantCulture,
            "window {0}x{1}, overlap={2}, local={3},{4},{5},{6}",
            width,
            height,
            hasOverlap,
            left,
            top,
            right,
            bottom);
        return result;
    }

    public static bool ClearRegion(string hwndText, out int win32Error)
    {
        bool result = SetWindowRgn(ParseHandle(hwndText), IntPtr.Zero, true) != 0;
        win32Error = result ? 0 : Marshal.GetLastWin32Error();
        return result;
    }

    public static bool GetTaskbarRect(out string hwndText, out string rectText, out int win32Error)
    {
        IntPtr hwnd = FindWindow("Shell_TrayWnd", null);
        hwndText = hwnd == IntPtr.Zero ? "" : hwnd.ToInt64().ToString(CultureInfo.InvariantCulture);
        rectText = "";
        win32Error = hwnd == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
        if (hwnd == IntPtr.Zero)
        {
            return false;
        }

        RECT rect;
        if (!GetWindowRect(hwnd, out rect))
        {
            win32Error = Marshal.GetLastWin32Error();
            return false;
        }

        rectText = FormatRect(rect);
        return true;
    }

    public static bool GetPrimaryMetrics(
        out string bounds,
        out string workArea,
        out uint dpiX,
        out uint dpiY,
        out int win32Error)
    {
        POINT point;
        point.X = 0;
        point.Y = 0;

        IntPtr monitor = MonitorFromPoint(point, MONITOR_DEFAULTTOPRIMARY);
        if (monitor == IntPtr.Zero)
        {
            bounds = "";
            workArea = "";
            dpiX = 96;
            dpiY = 96;
            win32Error = Marshal.GetLastWin32Error();
            return false;
        }

        MONITORINFO info = new MONITORINFO();
        info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(monitor, ref info))
        {
            bounds = "";
            workArea = "";
            dpiX = 96;
            dpiY = 96;
            win32Error = Marshal.GetLastWin32Error();
            return false;
        }

        uint effectiveX = 96;
        uint effectiveY = 96;
        int dpiResult = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, out effectiveX, out effectiveY);
        if (dpiResult != 0 || effectiveX == 0 || effectiveY == 0)
        {
            effectiveX = 96;
            effectiveY = 96;
        }

        bounds = FormatRect(info.rcMonitor);
        workArea = FormatRect(info.rcWork);
        dpiX = effectiveX;
        dpiY = effectiveY;
        win32Error = 0;
        return true;
    }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp

function Write-JsonLine {
    param([Parameter(Mandatory = $true)][hashtable]$Message)

    [Console]::Out.WriteLine(($Message | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
}

function ConvertFrom-RectText {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $null
    }

    $parts = $Text.Split(",")
    if ($parts.Count -ne 4) {
        return $null
    }

    $left = [int]$parts[0]
    $top = [int]$parts[1]
    $right = [int]$parts[2]
    $bottom = [int]$parts[3]
    return @{
        left = $left
        top = $top
        right = $right
        bottom = $bottom
        width = $right - $left
        height = $bottom - $top
    }
}

Write-JsonLine @{
    kind = "ready"
    pid = $PID
    dpiAwareness = $dpiAwarenessMode
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
    if ([string]::IsNullOrWhiteSpace($line)) {
        continue
    }

    $request = $null
    $ack = $true
    try {
        $request = $line | ConvertFrom-Json
        if ($null -ne $request.ack) {
            $ack = [bool]$request.ack
        }

        $op = [string]$request.op
        $id = $request.id

        if ($op -eq "exit") {
            if ($ack) {
                Write-JsonLine @{
                    kind = "result"
                    id = $id
                    op = "exit"
                    ok = $true
                }
            }
            break
        }

        $response = @{
            kind = "result"
            id = $id
            op = $op
            ok = $true
        }

        switch ($op) {
            "applyPetWindowStyle" {
                $exStyle = ""
                $win32Error = 0
                $response.ok = [NativeWindowBridge]::ApplyPetWindowStyle(
                    [string]$request.hwnd,
                    [ref]$exStyle,
                    [ref]$win32Error)
                $response.exStyle = $exStyle
                $response.win32Error = $win32Error
            }
            "setTopmost" {
                $win32Error = 0
                $response.ok = [NativeWindowBridge]::SetTopmost(
                    [string]$request.hwnd,
                    [bool]$request.on,
                    [ref]$win32Error)
                $response.win32Error = $win32Error
            }
            "setNoActivate" {
                $exStyle = ""
                $win32Error = 0
                $response.ok = [NativeWindowBridge]::SetNoActivate(
                    [string]$request.hwnd,
                    [bool]$request.on,
                    [ref]$exStyle,
                    [ref]$win32Error)
                $response.exStyle = $exStyle
                $response.win32Error = $win32Error
            }
            "raise" {
                $win32Error = 0
                $response.ok = [NativeWindowBridge]::Raise(
                    [string]$request.hwnd,
                    [ref]$win32Error)
                $response.win32Error = $win32Error
            }
            "focus" {
                $method = ""
                $response.ok = [NativeWindowBridge]::FocusWindow(
                    [string]$request.hwnd,
                    [ref]$method)
                $response.method = $method
            }
            "move" {
                $win32Error = 0
                $response.ok = [NativeWindowBridge]::Move(
                    [string]$request.hwnd,
                    [int]$request.x,
                    [int]$request.y,
                    [ref]$win32Error)
                $response.win32Error = $win32Error
            }
            "excludeTaskbar" {
                $detail = ""
                $win32Error = 0
                $response.ok = [NativeWindowBridge]::ExcludeTaskbar(
                    [string]$request.hwnd,
                    [int]$request.taskbarLeft,
                    [int]$request.taskbarTop,
                    [int]$request.taskbarRight,
                    [int]$request.taskbarBottom,
                    [ref]$detail,
                    [ref]$win32Error)
                $response.detail = $detail
                $response.win32Error = $win32Error
            }
            "clearRegion" {
                $win32Error = 0
                $response.ok = [NativeWindowBridge]::ClearRegion(
                    [string]$request.hwnd,
                    [ref]$win32Error)
                $response.win32Error = $win32Error
            }
            "getTaskbarRect" {
                $hwnd = ""
                $rectText = ""
                $win32Error = 0
                $response.ok = [NativeWindowBridge]::GetTaskbarRect(
                    [ref]$hwnd,
                    [ref]$rectText,
                    [ref]$win32Error)
                $response.hwnd = $hwnd
                $response.rect = ConvertFrom-RectText -Text $rectText
                $response.win32Error = $win32Error
            }
            "getPrimaryMetrics" {
                $boundsText = ""
                $workAreaText = ""
                $dpiX = 96
                $dpiY = 96
                $win32Error = 0
                $response.ok = [NativeWindowBridge]::GetPrimaryMetrics(
                    [ref]$boundsText,
                    [ref]$workAreaText,
                    [ref]$dpiX,
                    [ref]$dpiY,
                    [ref]$win32Error)
                $response.bounds = ConvertFrom-RectText -Text $boundsText
                $response.workArea = ConvertFrom-RectText -Text $workAreaText
                $response.dpi = @{
                    x = [int]$dpiX
                    y = [int]$dpiY
                }
                $response.scaleFactor = [double]$dpiX / 96.0
                $response.win32Error = $win32Error
            }
            default {
                $response.ok = $false
                $response.error = "unsupported op: $op"
            }
        }

        if ($ack) {
            Write-JsonLine $response
        } elseif (-not $response.ok) {
            Write-JsonLine @{
                kind = "error"
                id = $id
                op = $op
                message = "operation failed: $op"
                win32Error = $response.win32Error
            }
        }
    }
    catch {
        if ($ack) {
            Write-JsonLine @{
                kind = "error"
                id = $request.id
                op = $request.op
                message = $_.Exception.Message
            }
        } else {
            Write-JsonLine @{
                kind = "error"
                id = $request.id
                op = $request.op
                message = $_.Exception.Message
            }
        }
    }
}
