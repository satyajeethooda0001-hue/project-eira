@echo off
title AI Companion - Tanya ^& Kian (Project Eira v3)
color 0B

echo.
echo  ==========================================
echo     Project Eira v3.0 - AI Companion
echo  ==========================================
echo.

cd /d "C:\Users\Satyajeet\OneDrive\Desktop\Antigravity\ai-companion"

:: Check if Node.js is available
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found! Please install Node.js.
    pause
    exit /b
)

:: Check if node_modules exists
if not exist "node_modules" (
    echo  Installing dependencies...
    npm install
    echo.
)

:: Kill any existing server on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>nul
)

:: Start the server
echo  Starting server...
start /min cmd /c "node server.js"

:: Wait for server to actually be ready (check port, max 10 seconds)
set /a tries=0
:waitloop
timeout /t 1 /nobreak >nul
set /a tries+=1
netstat -aon | findstr ":3000" | findstr "LISTENING" >nul 2>nul
if %errorlevel% neq 0 (
    if %tries% lss 10 (
        echo  Waiting for server... (%tries%/10)
        goto waitloop
    ) else (
        echo  [ERROR] Server failed to start! Check logs.
        pause
        exit /b
    )
)

:: Server is ready — open browser
echo  Server is ready!
echo  Opening browser...
start http://localhost:3000

echo.
echo  ==========================================
echo     AI Companion is running!
echo     URL: http://localhost:3000
echo     Close server: close the minimized cmd
echo  ==========================================
echo.
timeout /t 4 /nobreak >nul
exit
