param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$Destination,
  [Parameter(Mandatory=$true)][string]$Evidence
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable CI only' }
$full = [IO.Path]::GetFullPath($Destination)
$temp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (!$full.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)) { throw 'Refuse non-fixture installation' }
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
$folderKey = 'Software\Classes\Directory\shell\LocalView.Open'
$backgroundKey = 'Software\Classes\Directory\Background\shell\LocalView.Open'
$sentinelKey = 'Software\Classes\Directory\shell\LocalView.Acceptance.' + [guid]::NewGuid().ToString('N')
$cases = @()
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LocalViewArgvTest {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CommandLineToArgvW(string value, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  public static string[] Parse(string command) {
    int count; IntPtr result=CommandLineToArgvW(command,out count);
    if(result==IntPtr.Zero) throw new InvalidOperationException("Command line parsing failed");
    try { var args=new string[count]; for(int i=0;i<count;i++) args[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(result,i*IntPtr.Size)); return args; }
    finally { LocalFree(result); }
  }
}
'@
function Read-FixtureValue([string]$Key,[string]$Name) {
  $handle=$base.OpenSubKey($Key)
  if ($null -eq $handle) { throw "Missing fixture key: $Key" }
  try { return $handle.GetValue($Name) } finally { $handle.Dispose() }
}
function Set-FixtureValue([string]$Key,[string]$Name,[string]$Value) {
  $handle=$base.CreateSubKey($Key)
  try { $handle.SetValue($Name,$Value) } finally { $handle.Dispose() }
}
function Test-FixtureKey([string]$Key) {
  $handle=$base.OpenSubKey($Key)
  if ($null -eq $handle) { return $false }
  $handle.Dispose()
  return $true
}
function Invoke-FixtureUninstall {
  $uninstallers = @(Get-ChildItem $Destination -File -Filter '*uninstall*.exe')
  if ($uninstallers.Count -ne 1) { throw 'Expected one owned uninstaller' }
  $p=Start-Process -FilePath $uninstallers[0].FullName -ArgumentList @('/S',"_?=$Destination") -PassThru -Wait
  if ($p.ExitCode -ne 0) { throw "Uninstall failed: $($p.ExitCode)" }
}
try {
  foreach ($entry in @(@($folderKey,'%1'),@($backgroundKey,'%V'))) {
    $command=Read-FixtureValue ($entry[0]+'\command') ''
    foreach ($target in @('C:\','D:\Folder with spaces\','C:\中文 & folder','C:\path\100% complete')) {
      $parsed=[LocalViewArgvTest]::Parse($command.Replace($entry[1],$target))
      if ($parsed.Length -ne 2 -or $parsed[0] -ne (Join-Path $Destination 'localview.exe') -or $parsed[1] -ne ($target+'\.')) { throw "Unsafe shell argument quoting: $target" }
    }
  }
  $cases+='Windows command-line parsing preserves drive roots, spaces, Unicode, ampersands and percent signs'
  Set-FixtureValue $sentinelKey '' 'untouched'
  $foreign='C:\Other LocalView\localview.exe'
  Set-FixtureValue $folderKey 'LocalViewOwner' $foreign
  Set-FixtureValue ($folderKey+'\command') '' ('"'+$foreign+'" "%1\."')
  Invoke-FixtureUninstall
  if (Test-FixtureKey $backgroundKey) { throw 'Owned background entry survived uninstall' }
  if ((Read-FixtureValue $folderKey 'LocalViewOwner') -ne $foreign) { throw 'Uninstaller removed foreign registration' }
  if ((Read-FixtureValue $sentinelKey '') -ne 'untouched') { throw 'Uninstaller modified unrelated shell entry' }
  $cases+='Uninstall removes its owned entry while preserving another installation and unrelated shell entries'
  $p=Start-Process -FilePath $Installer -ArgumentList @('/S',"/D=$Destination") -Wait -PassThru
  if ($p.ExitCode -notin @(0,3010)) { throw 'Fixture reinstall failed' }
  foreach ($key in @($folderKey,$backgroundKey)) {
    if ((Read-FixtureValue $key 'LocalViewOwner') -ne (Join-Path $Destination 'localview.exe')) { throw 'Reinstall failed to restore owned verb' }
  }
  $cases+='Reinstallation updates both registrations to the actual installed executable'
  Invoke-FixtureUninstall
  foreach ($key in @($folderKey,$backgroundKey)) {
    if (Test-FixtureKey $key) { throw 'Menu entry survived clean uninstall' }
  }
  $cases+='Final clean uninstall removes both LocalView menu entries'
  @{status='passed';cases=$cases} | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $Evidence 'shell-lifecycle.json')
} catch {
  @{status='failed';cases=$cases;error=$_.Exception.Message} | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $Evidence 'shell-lifecycle.json')
  throw
} finally {
  $base.DeleteSubKeyTree($sentinelKey,$false)
  $base.Dispose()
}
