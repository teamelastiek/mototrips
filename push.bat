@echo off
setlocal
rem Publiceert je wijzigingen: opslaan in git, naar GitHub sturen, en GitHub zet de app online.
cd /d "%~dp0"

echo.
echo  === MotoTrips publiceren ===
echo.

set "CHANGES="
for /f "delims=" %%i in ('git status --porcelain') do set CHANGES=1

if not defined CHANGES (
  echo Geen nieuwe wijzigingen gevonden.
  goto push
)

echo Gewijzigde bestanden:
git status --short
echo.
set "MSG="
set /p MSG=Beschrijf kort wat je hebt veranderd (Enter = "Update"):
if not defined MSG set "MSG=Update"

git add -A
git commit -q -m "%MSG%"
if errorlevel 1 goto fout

:push
echo.
echo Versturen naar GitHub...
git push
if errorlevel 1 goto fout

echo.
echo Klaar! Over 1 a 2 minuten staat de nieuwe versie online:
echo https://teamelastiek.github.io/mototrips/
echo.
pause
exit /b 0

:fout
echo.
echo Er ging iets mis, zie de melding hierboven.
pause
exit /b 1
