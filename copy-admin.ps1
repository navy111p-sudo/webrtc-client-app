$dirs = [System.IO.Directory]::GetDirectories('C:\Users\Administrator\AppData')
Write-Output "AppData dirs found"
# Try common Cowork/Claude paths
$searchPaths = @(
    'C:\Users\Administrator',
    'C:\Users\Admin', 
    'D:\',
    'E:\'
)
foreach($base in $searchPaths) {
    if(-not [System.IO.Directory]::Exists($base)) { continue }
    Write-Output "Checking $base..."
}
