param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference = 'Stop'
# Assign this supervisor before it can launch the shell. Descendants inherit
# the job even when cmd.exe exits first. Only the supervisor owns the job handle.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class NeutrinoCommandJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long a,b,c,d; public uint PageFaults,TotalProcesses,ActiveProcesses,TerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint length, IntPtr returned);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static void Check(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  public static int Run(string command, string cwd) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    Check(job != IntPtr.Zero);
    var limits = new ExtendedLimits(); limits.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
    Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
    Check(AssignProcessToJobObject(job, GetCurrentProcess()));
    var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe", "/d /s /c \"" + command + "\"");
    start.WorkingDirectory = cwd; start.UseShellExecute = false; start.CreateNoWindow = true;
    start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
    using (var process = Process.Start(start)) {
      process.StandardInput.Close();
      var stdout = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
      var stderr = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
      process.WaitForExit();
      int code = process.ExitCode;
      // Keep the supervisor alive until all descendants have exited. Killing
      // this supervisor closes the sole job handle and terminates descendants.
      while (true) {
        Accounting accounting;
        Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (accounting.ActiveProcesses <= 1) { System.Threading.Tasks.Task.WaitAll(stdout, stderr); return code; }
        System.Threading.Thread.Sleep(20);
      }
    }
    // The handle deliberately lives until supervisor exit, including exceptions.
  }
}
'@
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
exit [NeutrinoCommandJob]::Run($request.command, $request.cwd)
