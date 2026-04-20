$ErrorActionPreference = 'Stop'
$dirs = [System.IO.Directory]::GetDirectories('C:\Users\navy1\Claude')
$projDir = $null
foreach($d in $dirs) {
    $name = [System.IO.Path]::GetFileName($d)
    if($name -match '\uBA54\uC778') { $projDir = $d; break }
}
if(-not $projDir) {
    Write-Output "Searching all subdirs..."
    $dirs2 = [System.IO.Directory]::GetDirectories('C:\Users\navy1\Claude')
    foreach($d in $dirs2) { Write-Output "  Dir: $d" }
    exit
}
$src = [System.IO.Path]::Combine($projDir, 'cloudflare-deploy', 'public', 'images', 'logo_mangoi.png')
$dst = 'C:\temp-cf-deploy\public\images\logo_mangoi.png'
Write-Output "Source: $src"
Write-Output "Exists: $([System.IO.File]::Exists($src))"
if([System.IO.File]::Exists($src)) {
    [System.IO.File]::Copy($src, $dst, $true)
    Write-Output "Copied!"
} else {
    Write-Output "File not found, copying admin.html instead..."
    $admSrc = [System.IO.Path]::Combine($projDir, 'cloudflare-deploy', 'public', 'admin.html')
    $admDst = 'C:\temp-cf-deploy\public\admin.html'
    if([System.IO.File]::Exists($admSrc)) {
        [System.IO.File]::Copy($admSrc, $admDst, $true)
        Write-Output "admin.html copied!"
    }
}
