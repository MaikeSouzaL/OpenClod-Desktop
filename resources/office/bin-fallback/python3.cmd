@echo off
rem python3 (reserva): ver python.cmd.
setlocal
for %%I in ("%~dp0..\..\runtime\python\python.exe") do set "OPENCLOD_PY=%%~fI"
if not exist "%OPENCLOD_PY%" (
  echo python3: o Python embutido do Openclod nao foi encontrado em "%OPENCLOD_PY%" 1>&2
  exit /b 9009
)
"%OPENCLOD_PY%" -X utf8 %*
exit /b %ERRORLEVEL%
