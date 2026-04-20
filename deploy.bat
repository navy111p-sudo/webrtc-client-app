@echo off
set PATH=C:\Program Files\nodejs;%PATH%
cd /d C:\temp-cf-deploy
"C:\Program Files\nodejs\node.exe" "node_modules\wrangler\bin\wrangler.js" deploy 2>&1