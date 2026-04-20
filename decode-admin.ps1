$b64 = Get-Content -Path 'C:\temp-cf-deploy\admin_b64.txt' -Raw
$bytes = [System.Convert]::FromBase64String($b64)
[System.IO.File]::WriteAllBytes('C:\temp-cf-deploy\public\admin.html', $bytes)
Write-Output "admin.html written: $($bytes.Length) bytes"
