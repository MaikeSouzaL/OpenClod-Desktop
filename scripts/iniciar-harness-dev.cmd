@echo off
cd /d "C:\Users\Administrator\Desktop\Openclaudedescktop"
set "ELECTRON_RUN_AS_NODE="
title Openclod Desktop (dev)
echo Iniciando o Openclod Desktop em modo dev...
echo Mantenha esta janela aberta enquanto usa o app; feche-a para encerrar.
echo.
call npm run dev
echo.
echo O app encerrou. Pressione uma tecla para fechar esta janela.
pause >nul