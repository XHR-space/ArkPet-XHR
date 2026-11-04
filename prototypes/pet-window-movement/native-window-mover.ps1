$ErrorActionPreference = "Stop"

$source = @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;

public static class NativeWindowMover
{
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_ASYNCWINDOWPOS = 0x4000;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags);

    public static bool Move(string hwndText, int x, int y, out int win32Error)
    {
        ulong rawHandle = ulong.Parse(hwndText, CultureInfo.InvariantCulture);
        IntPtr hwnd = new IntPtr(unchecked((long)rawHandle));
        uint flags = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
        bool result = SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0, flags);
        win32Error = result ? 0 : Marshal.GetLastWin32Error();
        return result;
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

function Write-JsonLine {
    param([Parameter(Mandatory = $true)][hashtable]$Message)

    [Console]::Out.WriteLine(($Message | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

Write-JsonLine @{ kind = "ready"; pid = $PID }

while (($line = [Console]::In.ReadLine()) -ne $null) {
    if ([string]::IsNullOrWhiteSpace($line)) {
        continue
    }

    try {
        $message = $line | ConvertFrom-Json

        if ($message.kind -eq "exit") {
            Write-JsonLine @{ kind = "exit" }
            break
        }

        if ($message.kind -ne "move") {
            continue
        }

        $win32Error = 0
        $moved = [NativeWindowMover]::Move(
            [string]$message.hwnd,
            [int]$message.x,
            [int]$message.y,
            [ref]$win32Error)

        if (-not $moved) {
            Write-JsonLine @{
                kind = "error"
                op = "move"
                win32Error = $win32Error
                x = [int]$message.x
                y = [int]$message.y
            }
        }
    }
    catch {
        Write-JsonLine @{
            kind = "error"
            op = "parse"
            message = $_.Exception.Message
        }
    }
}

