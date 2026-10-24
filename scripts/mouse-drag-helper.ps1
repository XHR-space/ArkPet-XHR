param(
  [int]$ParentPid = 0
)

$mouseStateSource = @'
using System;
using System.Runtime.InteropServices;

public static class MouseDragState
{
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int virtualKey);
}
'@

Add-Type -TypeDefinition $mouseStateSource

function Write-MouseState([string]$value) {
    [Console]::Out.WriteLine($value)
    [Console]::Out.Flush()
}

Write-MouseState "0"

$wasDown = $false
$parentCheckAt = [Environment]::TickCount

while ($true) {
    if ($ParentPid -gt 0) {
        $now = [Environment]::TickCount
        if (($now - $parentCheckAt) -ge 500) {
            $parentCheckAt = $now
            try {
                $null = [System.Diagnostics.Process]::GetProcessById($ParentPid)
            } catch {
                break
            }
        }
    }

    $state = [MouseDragState]::GetAsyncKeyState(0x01)
    $isDown = (($state -band 0x8000) -ne 0)

    if ($isDown) {
        if ($wasDown) {
            Write-MouseState "1"
        } else {
            Write-MouseState "DOWN"
        }
    } elseif ($wasDown) {
        Write-MouseState "UP"
    }

    $wasDown = $isDown
    if ($isDown) {
        Start-Sleep -Milliseconds 12
    } else {
        Start-Sleep -Milliseconds 48
    }
}
