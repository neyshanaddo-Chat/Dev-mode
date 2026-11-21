# Dev mode launcher
# Runs the Dev mode app at http://localhost:5178 (only this PC can reach it)
# and opens it in its own Microsoft Edge window. Close this window to stop it.
param([int]$Port = 5178)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
$log  = Join-Path $root 'devmode-log.txt'
$url  = "http://localhost:$Port/"
function Log($m) { $t = (Get-Date).ToString('HH:mm:ss'); Write-Host "  $m"; try { Add-Content -LiteralPath $log -Value "$t $m" } catch {} }

function Open-DevMode {
  $edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($edge) { Start-Process -FilePath $edge -ArgumentList "--app=$url" } else { Start-Process $url }
}

$types = @{
  '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.webmanifest' = 'application/manifest+json'
  '.png' = 'image/png'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'; '.md' = 'text/plain; charset=utf-8'
}

function Send($stream, [int]$code, [string]$status, [string]$type, [byte[]]$body) {
  $head = "HTTP/1.1 $code $status`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
  $hb = [Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($hb, 0, $hb.Length)
  if ($body.Length) { $stream.Write($body, 0, $body.Length) }
  $stream.Flush()
}

function Serve($client) {
  try {
    $s = $client.GetStream()
    $s.ReadTimeout = 2000
    $buf = New-Object byte[] 8192
    $req = ''
    while ($req -notmatch "`r`n`r`n") {
      $n = $s.Read($buf, 0, $buf.Length)
      if ($n -le 0) { return }
      $req += [Text.Encoding]::ASCII.GetString($buf, 0, $n)
      if ($req.Length -gt 65536) { break }
    }
    $first = ($req -split "`r`n")[0]
    $target = ($first -split ' ')[1]
    if (-not $target) { return }
    $path = [Uri]::UnescapeDataString(($target -split '\?')[0]).TrimStart('/')
    if ($path -eq '') { $path = 'index.html' }
    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($root, ($path -replace '/', '\')))
    $name = [IO.Path]::GetFileName($full)
    if ($full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and -not $name.StartsWith('.') -and [IO.File]::Exists($full)) {
      $ext = [IO.Path]::GetExtension($full).ToLower()
      $type = 'application/octet-stream'
      if ($types.ContainsKey($ext)) { $type = $types[$ext] }
      Send $s 200 'OK' $type ([IO.File]::ReadAllBytes($full))
    } else {
      Send $s 404 'Not Found' 'text/plain' ([Text.Encoding]::UTF8.GetBytes('Not found'))
    }
  } catch {
  } finally {
    try { $client.Close() } catch {}
  }
}

try {
  Write-Host ""
  $listener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
  try { $listener.Start() } catch {
    # Something is already using the port: if it's Dev mode, just open it.
    try { $null = Invoke-WebRequest -UseBasicParsing -Uri ($url + 'manifest.webmanifest') -TimeoutSec 3; Log "Dev mode is already running - opening it."; Open-DevMode; Start-Sleep 2; exit 0 }
    catch { throw "Port $Port is being used by another program. ($($_.Exception.Message))" }
  }
  Log "Dev mode is running at $url"
  Write-Host "  Close this window to stop it."
  Write-Host ""
  Open-DevMode

  $waiting = New-Object System.Collections.ArrayList
  while ($true) {
    while ($listener.Pending()) { [void]$waiting.Add(@{ c = $listener.AcceptTcpClient(); t = [DateTime]::Now }) }
    foreach ($w in @($waiting)) {
      if ($w.c.Available -gt 0) { [void]$waiting.Remove($w); Serve $w.c }
      elseif (([DateTime]::Now - $w.t).TotalSeconds -gt 20) { [void]$waiting.Remove($w); try { $w.c.Close() } catch {} }
    }
    if (-not $listener.Pending()) { Start-Sleep -Milliseconds 15 }
  }
} catch {
  Log ("PROBLEM: " + $_.Exception.Message)
  Write-Host ""
  Write-Host "  Dev mode couldn't start. The message above is saved in devmode-log.txt."
  Read-Host "  Press Enter to close"
}
