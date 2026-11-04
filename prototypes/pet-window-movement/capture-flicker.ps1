param(
    [string]$WindowTitle = "Pet Window Movement POC",
    [int]$DurationSeconds = 8,
    [int]$TargetHz = 30,
    [int]$Tolerance = 24,
    [int]$FindTimeoutSeconds = 20,
    [bool]$RaiseWindow = $true,
    [string]$DebugImagePath = "",
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path -Path $PSScriptRoot -ChildPath "results-flicker-native.json"
}

$dpiBootstrapSource = @'
using System;
using System.Runtime.InteropServices;

public static class CaptureDpiBootstrap
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
        if (result == 0)
        {
            return "PerMonitor";
        }

        return "AlreadySetOrUnavailable:Win32=" + error + ",HRESULT=" + result;
    }
}
'@

Add-Type -TypeDefinition $dpiBootstrapSource -Language CSharp
$dpiAwarenessMode = [CaptureDpiBootstrap]::Enable()

Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;

public sealed class FlickerFrameResult
{
    public bool WindowFound;
    public bool CaptureSucceeded;
    public bool PrintWindowReturnedTrue;
    public int PrintWindowError;
    public bool PrintWindowMarkerDetected;
    public bool UsedFallback;
    public bool MarkerDetected;
    public int MarkerPixelCount;
    public int Width;
    public int Height;
    public string CapturePath;
    public string Error;
}

public static class WindowFlickerCapture
{
    private const uint PW_RENDERFULLCONTENT = 0x00000002;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const int MarkerR = 255;
    private const int MarkerG = 0;
    private const int MarkerB = 255;
    private const int MinimumMarkerPixels = 16;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr hwnd,
        IntPtr hwndInsertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags);

    public static IntPtr Find(string windowTitle)
    {
        return FindWindow(null, windowTitle);
    }

    public static bool Raise(IntPtr hwnd)
    {
        return SetWindowPos(
            hwnd,
            IntPtr.Zero,
            0,
            0,
            0,
            0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    }

    public static FlickerFrameResult Capture(IntPtr hwnd, int tolerance, string debugImagePath)
    {
        FlickerFrameResult result = new FlickerFrameResult();
        result.WindowFound = IsWindow(hwnd);
        result.CapturePath = "None";

        if (!result.WindowFound)
        {
            result.Error = "Window handle is no longer valid.";
            return result;
        }

        RECT rect;
        if (!GetWindowRect(hwnd, out rect))
        {
            result.Error = "GetWindowRect failed with Win32 error " + Marshal.GetLastWin32Error();
            return result;
        }

        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        result.Width = width;
        result.Height = height;

        if (width <= 0 || height <= 0)
        {
            result.Error = "Window rectangle is empty.";
            return result;
        }

        Bitmap bitmap = null;
        Graphics graphics = null;
        try
        {
            bitmap = new Bitmap(width, height);
            graphics = Graphics.FromImage(bitmap);

            bool printWindowReturned = false;
            int printWindowError = 0;
            IntPtr hdc = graphics.GetHdc();
            try
            {
                printWindowReturned = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT);
                printWindowError = printWindowReturned ? 0 : Marshal.GetLastWin32Error();
            }
            finally
            {
                graphics.ReleaseHdc(hdc);
            }

            result.PrintWindowReturnedTrue = printWindowReturned;
            result.PrintWindowError = printWindowError;

            if (result.PrintWindowReturnedTrue)
            {
                SaveDebugImage(bitmap, debugImagePath + ".printwindow.png");
                result.MarkerPixelCount = CountMarkerPixels(bitmap, tolerance);
                result.PrintWindowMarkerDetected = result.MarkerPixelCount >= MinimumMarkerPixels;
                if (result.PrintWindowMarkerDetected)
                {
                    result.CaptureSucceeded = true;
                    result.MarkerDetected = true;
                    result.CapturePath = "PrintWindow";
                    return result;
                }
            }

            graphics.CopyFromScreen(
                rect.Left,
                rect.Top,
                0,
                0,
                new Size(width, height),
                CopyPixelOperation.SourceCopy);

            result.UsedFallback = true;
            SaveDebugImage(bitmap, debugImagePath + ".fallback.png");
            result.MarkerPixelCount = CountMarkerPixels(bitmap, tolerance);
            result.MarkerDetected = result.MarkerPixelCount >= MinimumMarkerPixels;
            result.CaptureSucceeded = true;
            result.CapturePath = "CopyFromScreen";
            return result;
        }
        catch (Exception error)
        {
            result.Error = error.GetType().Name + ": " + error.Message;
            return result;
        }
        finally
        {
            if (graphics != null)
            {
                graphics.Dispose();
            }

            if (bitmap != null)
            {
                bitmap.Dispose();
            }
        }
    }

    private static int CountMarkerPixels(Bitmap bitmap, int tolerance)
    {
        int scanWidth = Math.Min(bitmap.Width, 64);
        int scanHeight = Math.Min(bitmap.Height, 64);
        int count = 0;

        for (int y = 0; y < scanHeight; y++)
        {
            for (int x = 0; x < scanWidth; x++)
            {
                Color pixel = bitmap.GetPixel(x, y);
                if (Math.Abs(pixel.R - MarkerR) <= tolerance &&
                    Math.Abs(pixel.G - MarkerG) <= tolerance &&
                    Math.Abs(pixel.B - MarkerB) <= tolerance)
                {
                    count++;
                }
            }
        }

        return count;
    }

    private static void SaveDebugImage(Bitmap bitmap, string path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return;
        }

        bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies System.Drawing

$findDeadline = [DateTime]::UtcNow.AddSeconds($FindTimeoutSeconds)
$hwnd = [IntPtr]::Zero

while ([DateTime]::UtcNow -lt $findDeadline) {
    $hwnd = [WindowFlickerCapture]::Find($WindowTitle)
    if ($hwnd.ToInt64() -ne 0) {
        break
    }

    Start-Sleep -Milliseconds 100
}

if ($hwnd.ToInt64() -eq 0) {
    throw "Timed out waiting for window title '$WindowTitle'."
}

$raiseWindowSucceeded = $false
if ($RaiseWindow) {
    $raiseWindowSucceeded = [WindowFlickerCapture]::Raise($hwnd)
    Start-Sleep -Milliseconds 100
}

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$stopwatchFrequency = [System.Diagnostics.Stopwatch]::Frequency
$frameIntervalTicks = $stopwatchFrequency / [double]$TargetHz
$nextFrameTick = 0.0
$previousFrameStartTick = -1L
$samples = [System.Collections.Generic.List[object]]::new()

while ($stopwatch.Elapsed.TotalSeconds -lt $DurationSeconds) {
    $frameStartTick = $stopwatch.ElapsedTicks
    $intervalMs = 0.0
    if ($previousFrameStartTick -ge 0) {
        $intervalMs = (($frameStartTick - $previousFrameStartTick) * 1000.0) / $stopwatchFrequency
    }
    $previousFrameStartTick = $frameStartTick

    $debugPath = ""
    if ($samples.Count -eq 0 -and -not [string]::IsNullOrWhiteSpace($DebugImagePath)) {
        $debugPath = $DebugImagePath
    }

    $capture = [WindowFlickerCapture]::Capture($hwnd, $Tolerance, $debugPath)
    $samples.Add([pscustomobject]@{
        index = $samples.Count
        elapsedMs = [Math]::Round(($frameStartTick * 1000.0) / $stopwatchFrequency, 3)
        intervalMs = [Math]::Round($intervalMs, 3)
        markerDetected = [bool]$capture.MarkerDetected
        markerPixelCount = [int]$capture.MarkerPixelCount
        captureSucceeded = [bool]$capture.CaptureSucceeded
        capturePath = [string]$capture.CapturePath
        printWindowReturnedTrue = [bool]$capture.PrintWindowReturnedTrue
        printWindowError = [int]$capture.PrintWindowError
        printWindowMarkerDetected = [bool]$capture.PrintWindowMarkerDetected
        usedFallback = [bool]$capture.UsedFallback
        width = [int]$capture.Width
        height = [int]$capture.Height
        error = [string]$capture.Error
    })

    $nextFrameTick += $frameIntervalTicks
    while ($stopwatch.ElapsedTicks -lt $nextFrameTick) {
        Start-Sleep -Milliseconds 1
    }

    if ($stopwatch.ElapsedTicks -gt ($nextFrameTick + ($frameIntervalTicks * 2))) {
        $nextFrameTick = $stopwatch.ElapsedTicks
    }
}

$stopwatch.Stop()

$detectedFrames = @($samples | Where-Object { $_.markerDetected }).Count
$missingFrames = @($samples | Where-Object { -not $_.markerDetected }).Count
$captureErrorFrames = @($samples | Where-Object { -not $_.captureSucceeded }).Count
$printWindowFrames = @($samples | Where-Object { $_.capturePath -eq "PrintWindow" }).Count
$fallbackFrames = @($samples | Where-Object { $_.capturePath -eq "CopyFromScreen" }).Count
$intervals = @($samples | Where-Object { $_.index -gt 0 } | ForEach-Object { [double]$_.intervalMs })
$averageIntervalMs = if ($intervals.Count -gt 0) {
    [Math]::Round((($intervals | Measure-Object -Average).Average), 3)
} else {
    0
}
$maxIntervalMs = if ($intervals.Count -gt 0) {
    [Math]::Round((($intervals | Measure-Object -Maximum).Maximum), 3)
} else {
    0
}

$summary = [pscustomobject]@{
    windowTitle = $WindowTitle
    hwnd = $hwnd.ToInt64()
    durationSeconds = $DurationSeconds
    targetHz = $TargetHz
    tolerance = $Tolerance
    dpiAwarenessMode = $dpiAwarenessMode
    raiseWindowRequested = $RaiseWindow
    raiseWindowSucceeded = $raiseWindowSucceeded
    debugImagePath = $DebugImagePath
    expectedMarkerFrames = $samples.Count
    detectedMarkerFrames = $detectedFrames
    missingMarkerFrames = $missingFrames
    missingMarkerRate = if ($samples.Count -gt 0) {
        [Math]::Round(($missingFrames / [double]$samples.Count), 6)
    } else {
        0
    }
    captureErrorFrames = $captureErrorFrames
    printWindowFrames = $printWindowFrames
    copyFromScreenFrames = $fallbackFrames
    averageSamplingIntervalMs = $averageIntervalMs
    maxSamplingIntervalMs = $maxIntervalMs
    actualDurationSeconds = [Math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
    samples = $samples
}

$json = $summary | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText(
    $OutputPath,
    $json + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false))

Write-Output $json

