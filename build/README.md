# build/ — recursos de empacotamento

Esta pasta é o `buildResources` do electron-builder. **Nenhum binário de ícone
está versionado neste repositório na versão 0.1.0.** Não há `icon.ico` nem
`icon.png` aqui, e o `electron-builder.yml` foi escrito para não falhar por causa
disso.

## Arquivos esperados (opcionais)

| Arquivo | Usado por | Formato recomendado |
|---|---|---|
| `build/icon.ico` | Ícone do `Openclod.exe` e do instalador NSIS | ICO com 16, 24, 32, 48, 64, 128 e 256 px |
| `build/icon.png` | Ícone da janela em produção (`extraResources` → `resources/icon.png`) | PNG 512×512 (fundo transparente) |

## Comportamento sem os arquivos

- `win.icon` está comentado no YAML: o electron-builder usa o ícone padrão do
  Electron e o build **não falha**.
- `extraResources` também está comentado: a janela usa o ícone padrão do
  Electron; o build **não falha**.

## Para gerar com ícone próprio

1. Coloque `icon.ico` e `icon.png` nesta pasta.
2. Em `electron-builder.yml`, descomente `win.icon` e `extraResources`.
3. Rode `npm run dist`.

Alternativa sem editar o YAML (CI):

```powershell
npx electron-builder --win nsis --x64 --config.win.icon=build/icon.ico
```

O `src/main/index.ts` procura o ícone da janela, nesta ordem:

1. `build/icon.png` relativo ao diretório de trabalho (desenvolvimento);
2. `build/icon.png` dentro de `app.getAppPath()`;
3. `icon.png` em `process.resourcesPath` (produção, via `extraResources`).

Não versione binários grandes desnecessários; prefira gerar os ícones no pipeline
de release a partir do SVG/fonte da marca.
