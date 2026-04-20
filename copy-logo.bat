@echo off
where /r "C:\MAMP\htdocs" logo_mangoi.png > C:\temp-cf-deploy\logo_path.txt 2>nul
for /f "delims=" %%i in (C:\temp-cf-deploy\logo_path.txt) do (
    copy "%%i" "C:\temp-cf-deploy\public\images\logo_mangoi.png" /Y
    echo Copied from %%i
    goto :done
)
:done
