$ErrorActionPreference = 'Stop'

# Find the project folder with Korean name
$claudeBase = $null
$possiblePaths = @(
    'C:\Users\Administrator\Claude',
    'C:\Users\Admin\Claude',
    'D:\Claude',
    'C:\Claude'
)
foreach($p in $possiblePaths) {
    if([System.IO.Directory]::Exists($p)) { $claudeBase = $p; break }
}

if(-not $claudeBase) {
    # Search more broadly
    $drives = [System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -eq 'Fixed' }
    foreach($drv in $drives) {
        $testPath = [System.IO.Path]::Combine($drv.RootDirectory.FullName, 'Users')
        if([System.IO.Directory]::Exists($testPath)) {
            foreach($userDir in [System.IO.Directory]::GetDirectories($testPath)) {
                $claudeDir = [System.IO.Path]::Combine($userDir, 'Claude')
                if([System.IO.Directory]::Exists($claudeDir)) {
                    $claudeBase = $claudeDir
                    Write-Output "Found Claude at: $claudeBase"
                    break
                }
            }
            if($claudeBase) { break }
        }
    }
}

if(-not $claudeBase) {
    Write-Output "ERROR: Claude folder not found"
    exit 1
}

Write-Output "Claude base: $claudeBase"

# Find the Korean project folder
$projDir = $null
foreach($d in [System.IO.Directory]::GetDirectories($claudeBase)) {
    $name = [System.IO.Path]::GetFileName($d)
    Write-Output "  Checking: $name"
    if($name -match 'proj' -or $name -match 'main' -or $name.Length -gt 5) {
        $adminPath = [System.IO.Path]::Combine($d, 'cloudflare-deploy', 'public', 'admin.html')
        if([System.IO.File]::Exists($adminPath)) {
            $projDir = $d
            Write-Output "  -> Found project with admin.html!"
            break
        }
    }
}

if(-not $projDir) {
    Write-Output "ERROR: Project folder with admin.html not found"
    exit 1
}

# Copy admin.html
$src = [System.IO.Path]::Combine($projDir, 'cloudflare-deploy', 'public', 'admin.html')
$dst = 'C:\temp-cf-deploy\public\admin.html'
[System.IO.File]::Copy($src, $dst, $true)
$info = New-Object System.IO.FileInfo($dst)
Write-Output "admin.html copied: $($info.Length) bytes"
