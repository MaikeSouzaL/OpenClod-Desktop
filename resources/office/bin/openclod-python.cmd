@echo off
rem openclod-python: o Python embutido do Openclod (python-docx, openpyxl, python-pptx, XlsxWriter, Pillow, lxml).
rem O run_command coloca esta pasta no PATH. Nada vem do Python do computador do usuario.
setlocal
for %%I in ("%~dp0..\..\runtime\python\python.exe") do set "OPENCLOD_PY=%%~fI"
if not exist "%OPENCLOD_PY%" (
  echo openclod-python: o Python embutido nao foi encontrado em "%OPENCLOD_PY%" 1>&2
  exit /b 9009
)
"%OPENCLOD_PY%" -X utf8 %*
exit /b %ERRORLEVEL%
