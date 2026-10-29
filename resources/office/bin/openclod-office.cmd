@echo off
rem openclod-office: confere o ambiente de documentos e inspeciona .docx/.xlsx/.pptx (check, inspect, pdf, recalc).
setlocal
for %%I in ("%~dp0..\..\runtime\python\python.exe") do set "OPENCLOD_PY=%%~fI"
for %%I in ("%~dp0..\openclod_office_cli.py") do set "OPENCLOD_ENGINE=%%~fI"
if not exist "%OPENCLOD_PY%" (
  echo openclod-office: o Python embutido nao foi encontrado em "%OPENCLOD_PY%" 1>&2
  exit /b 9009
)
"%OPENCLOD_PY%" -I -X utf8 "%OPENCLOD_ENGINE%" %*
exit /b %ERRORLEVEL%
