# Minimal static file server for local testing (127.0.0.1:8093)
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://127.0.0.1:8093/')
$listener.Start()
Write-Host "Serving on http://127.0.0.1:8093/"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$mime = @{
  '.html' = 'text/html'; '.css' = 'text/css'; '.js' = 'text/javascript'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.svg' = 'image/svg+xml'
  '.ico' = 'image/x-icon'; '.json' = 'application/json'; '.txt' = 'text/plain'
}
while ($true) {
  $ctx = $listener.GetContext()
  $path = $ctx.Request.Url.LocalPath
  if ($path -eq '/') { $path = '/index.html' }
  $file = Join-Path $root ($path.TrimStart('/').Replace('/', '\'))
  if (-not (Test-Path $file -PathType Leaf)) { $file = Join-Path $root 'index.html' }
  try {
    $bytes = [IO.File]::ReadAllBytes($file)
    $ext = [IO.Path]::GetExtension($file).ToLower()
    if (-not $mime.ContainsKey($ext)) { $ext = '.txt' }
    $ctx.Response.ContentType = $mime[$ext]
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch {
    $ctx.Response.StatusCode = 500
  }
  $ctx.Response.OutputStream.Close()
}
