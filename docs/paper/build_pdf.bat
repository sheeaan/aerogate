@echo off
rem Rebuilds aerogate_paper.pdf from aerogate_paper.tex. Double-click this file after editing the .tex.
cd /d "%~dp0"
set TEX="%LOCALAPPDATA%\Programs\MiKTeX\miktex\bin\x64\pdflatex.exe"
echo Building aerogate_paper.pdf ...
%TEX% -interaction=nonstopmode -halt-on-error -aux-directory=build aerogate_paper.tex >nul 2>&1
%TEX% -interaction=nonstopmode -halt-on-error -aux-directory=build aerogate_paper.tex >nul 2>&1
if errorlevel 1 (
  echo Build failed. The error is near the end of build\aerogate_paper.log
  pause
  exit /b 1
)
echo Done.
if "%~1"=="--no-open" exit /b 0
start "" aerogate_paper.pdf
