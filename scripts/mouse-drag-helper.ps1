param(
  [int]$ParentPid = 0
)

$mouseStateSource = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class MouseDragState
{
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("winmm.dll")]
    public static extern uint timeBeginPeriod(uint period);

    [DllImport("winmm.dll")]
    public static extern uint timeEndPeriod(uint period);

    public static void Run(int parentPid)
    {
        timeBeginPeriod(1);
        bool wasDown = false;
        DateTime parentCheckAt = DateTime.UtcNow;
        Console.Out.WriteLine("0");
        Console.Out.Flush();
        try
        {
            while (true)
            {
                DateTime now = DateTime.UtcNow;
                if (parentPid > 0 && (now - parentCheckAt).TotalMilliseconds >= 500)
                {
                    parentCheckAt = now;
                    try
                    {
                        using (Process.GetProcessById(parentPid)) { }
                    }
                    catch (ArgumentException)
                    {
                        break;
                    }
                }

                bool isDown = (GetAsyncKeyState(0x01) & 0x8000) != 0;
                if (isDown)
                {
                    Console.Out.WriteLine(wasDown ? "1" : "DOWN");
                    Console.Out.Flush();
                }
                else if (wasDown)
                {
                    Console.Out.WriteLine("UP");
                    Console.Out.Flush();
                }

                wasDown = isDown;
                Thread.Sleep(isDown ? 4 : 48);
            }
        }
        finally
        {
            timeEndPeriod(1);
        }
    }
}
'@

Add-Type -TypeDefinition $mouseStateSource
[MouseDragState]::Run($ParentPid)
