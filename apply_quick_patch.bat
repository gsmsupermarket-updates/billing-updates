@echo off
:: Check for permissions
>nul 2>&1 "%SYSTEMROOT%\system32\cacls.exe" "%SYSTEMROOT%\system32\config\system"
if '%errorlevel%' NEQ '0' (
    echo Requesting administrative privileges...
    goto UACPrompt
) else ( goto gotAdmin )

:UACPrompt
    echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\getadmin.vbs"
    set params= %*
    echo UAC.ShellExecute "cmd.exe", "/c ""%~s0"" %params:"=""%", "", "runas", 1 >> "%temp%\getadmin.vbs"
    "%temp%\getadmin.vbs"
    del "%temp%\getadmin.vbs"
    exit /B

:gotAdmin
    pushd "%CD%"
    CD /D "%~dp0"

title GSM Super Market - Quick Patch v1.0.13
echo.
echo  ================================================
echo   GSM SUPER MARKET - Quick Patch Installer
echo   Version 1.0.13
echo  ================================================
echo.
echo  This patch includes:
echo    [1] License Fix (no repeat activation)
echo    [2] AI Smart Scan improvements
echo    [3] Purchase Cart scroll fix (no item limit)
echo    [4] Bill-Wise Sales Report (Cash/UPI/Card/Credit)
echo    [5] F2 shortcut to edit quantity
echo    [6] F4-F7 Payment Shortcuts
echo    [7] Keyboard Navigation in search
echo    [8] Purchase Invoice Number displaying correctly
echo    [9] Removed Admin Pill and GSM Branding
echo    [10] Fixed Cart Scrolling Issue
echo    [11] Added Edit Button for Saved Customer Bills
echo.

rem === Find the app installation path ===
set APP_PATH=

rem Check user-level install (most common)
if exist "%LOCALAPPDATA%\Programs\GSM Super Market\resources\app\index.html" (
  set APP_PATH=%LOCALAPPDATA%\Programs\GSM Super Market\resources\app
  goto found
)

rem Check machine-level install
if exist "%PROGRAMFILES%\GSM Super Market\resources\app\index.html" (
  set APP_PATH=%PROGRAMFILES%\GSM Super Market\resources\app
  goto found
)

if exist "%PROGRAMFILES(X86)%\GSM Super Market\resources\app\index.html" (
  set APP_PATH=%PROGRAMFILES(X86)%\GSM Super Market\resources\app
  goto found
)

rem Not found automatically - ask user
echo  App not found automatically.
echo  Please enter the full path to your GSM app folder.
echo  Example: C:\Users\John\AppData\Local\Programs\GSM Super Market\resources\app
echo.
set /p APP_PATH=Enter path: 
if not exist "%APP_PATH%\index.html" (
  echo.
  echo  ERROR: Invalid path. index.html not found there.
  echo.
  pause
  goto done
)

:found
echo.
echo  Found app at: %APP_PATH%
echo.
pause

echo.
echo  Step 1 - Creating backups...
copy /Y "%APP_PATH%\index.html"   "%APP_PATH%\index_backup.html"
copy /Y "%APP_PATH%\main.js"      "%APP_PATH%\main_backup.js"
copy /Y "%APP_PATH%\preload.js"   "%APP_PATH%\preload_backup.js"
echo  Backups created.

echo.
echo  Step 2 - Applying patch files...
copy /Y "%~dp0patch_files\index.html"   "%APP_PATH%\index.html"
if %errorlevel% NEQ 0 goto error
echo  - index.html   updated OK
copy /Y "%~dp0patch_files\main.js"      "%APP_PATH%\main.js"
if %errorlevel% NEQ 0 goto error
echo  - main.js      updated OK
copy /Y "%~dp0patch_files\preload.js"   "%APP_PATH%\preload.js"
if %errorlevel% NEQ 0 goto error
echo  - preload.js   updated OK

echo.
echo  ================================================
echo   PATCH APPLIED SUCCESSFULLY!
echo   Please CLOSE and RE-OPEN the GSM app now.
echo  ================================================
echo.
pause
goto done

:error
echo.
echo  ERROR: Could not copy patch files!
echo  Check that the GSM app is closed and try again.
echo.
pause

:done
