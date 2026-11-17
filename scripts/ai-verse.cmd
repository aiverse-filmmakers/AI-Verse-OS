@echo off
rem Run Node, Python or Git from AI-Verse OS's own copies. Usage: scripts\ai-verse node scripts\skills-list.mjs
rem Windows version, not yet tested on a real Windows machine. Node does the work, so every
rem argument (empty ones, quotes, percent signs) is passed through untouched and the tool name
rem is checked there against node, python and git.
setlocal DisableDelayedExpansion
if "%AI_VERSE_TOOLCHAIN_DIR%"=="" (set "TC=%USERPROFILE%\.aiverse\toolchain") else (set "TC=%AI_VERSE_TOOLCHAIN_DIR%")
set "BOOT=%TC%\node\node.exe"
if not exist "%BOOT%" set "BOOT=node"
"%BOOT%" "%~dp0toolchain.mjs" run %*
exit /b %ERRORLEVEL%
