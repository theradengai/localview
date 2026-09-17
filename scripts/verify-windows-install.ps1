param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$Evidence
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable CI runner only' }
$Installer = (Resolve-Path $Installer).Path
New-Item -ItemType Directory -Force $Evidence | Out-Null
$Evidence = (Resolve-Path $Evidence).Path
$destination = Join-Path $env:RUNNER_TEMP ('LocalViewInstalled-' + [guid]::NewGuid().ToString('N'))
$p = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$destination") -Wait -PassThru
if ($p.ExitCode -notin @(0,3010)) { throw "NSIS installation failed: $($p.ExitCode)" }
$apps = @(Get-ChildItem $destination -Filter 'localview.exe' -Recurse)
if ($apps.Count -ne 1) { throw "Expected one installed application, found $($apps.Count)" }
$exe = $apps[0].FullName
$bytes = [IO.File]::ReadAllBytes($exe)
$pe = [BitConverter]::ToInt32($bytes,0x3c)
if ([BitConverter]::ToUInt16($bytes,$pe+4) -ne 0x8664) { throw 'Installed application is not x64' }
foreach ($name in @('LICENSE','THIRD_PARTY_NOTICES.md')) {
  $copies = @(Get-ChildItem $destination -Recurse -File -Filter $name)
  if ($copies.Count -ne 1) { throw "Missing/duplicate bundled notice $name" }
  if ((Get-FileHash $copies[0].FullName).Hash -ne (Get-FileHash $name).Hash) { throw "Bundled $name differs from verified source" }
}
$tools = Join-Path $env:RUNNER_TEMP 'localview-native-browser'
npm install --prefix $tools --ignore-scripts --save-exact playwright@1.58.2
if ($LASTEXITCODE -ne 0) { throw 'Could not install isolated browser tools' }
$report = @{
  sourceCommit=(git rev-parse HEAD)
  sourceTree=(git rev-parse 'HEAD^{tree}')
  version=(Get-Content package.json | ConvertFrom-Json).version
  os=[Environment]::OSVersion.VersionString
  architecture='x86_64'
  installer=(Split-Path $Installer -Leaf)
  installerSHA256=(Get-FileHash $Installer).Hash.ToLower()
  executableSHA256=(Get-FileHash $exe).Hash.ToLower()
  signature=(Get-AuthenticodeSignature $exe).Status.ToString()
  installExitCode=$p.ExitCode
  checks=@('NSIS current-user installation','x64 PE architecture','original LICENSE bundled','exact dependency notices bundled')
}
$report | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $Evidence 'install.json')
node scripts/verify-windows-shell.mjs (Join-Path $tools 'package.json') $exe $Evidence
if ($LASTEXITCODE -ne 0) { throw 'Explorer folder menu acceptance failed' }
node scripts/verify-windows-native.mjs (Join-Path $tools 'package.json') $exe $Evidence 2>&1 | Tee-Object (Join-Path $Evidence 'native-ui.log')
if ($LASTEXITCODE -ne 0) { throw 'Installed native UI acceptance failed; inspect native-ui.json' }
