# Client ID Metadata Documents (CIMD): possibilidade futura

**Estado: não implementado, de propósito.** Este arquivo registra a ideia para uma decisão
futura. Hoje os conectores `oauth-static` (o servidor de autorização não aceita registro
dinâmico) usam o aplicativo OAuth do próprio usuário: veja "Conectores oauth-static" em
`docs/MCP_OAUTH.md`.

## O que é

A especificação do MCP de 2026-07-28 prefere os Client ID Metadata Documents ao registro
dinâmico de cliente (RFC 7591). Em vez de pedir um `client_id` ao servidor, o cliente usa
como `client_id` uma **URL HTTPS pública** que ele mesmo hospeda. O servidor de autorização
busca essa URL e lê o documento JSON do cliente:

```json
{
  "client_id": "https://exemplo.openclod.app/oauth/client.json",
  "client_name": "Openclod Desktop",
  "redirect_uris": ["http://127.0.0.1:38565/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

O servidor anuncia o suporte no documento de metadados com
`client_id_metadata_document_supported: true`.

## Por que valeria a pena

- A sondagem de 2026-10-27 (`docs/mcp/SONDAGEM-2026-10-27.md`) encontrou **32 servidores de
  autorização** que anunciam esse suporte. Para esses, o conector `oauth-static` deixaria de
  exigir que o usuário crie um aplicativo OAuth.
- O Openclod teria **um** client id para todos os provedores que aceitam CIMD, sem segredo
  (cliente público com PKCE) e sem registrar nada por usuário.
- A URL de retorno `http://127.0.0.1:38565/callback` (porta fixa, veja `MCP_OAUTH_REDIRECT_URI`)
  já é a que o documento listaria em `redirect_uris`.

## O que exigiria

1. **Hospedar um documento HTTPS público e estável** (um domínio do projeto, certificado
   válido, disponibilidade sem login). Isso é infraestrutura que o Openclod não tem hoje: o
   app roda só na máquina do usuário.
2. Decidir o que o documento declara (nome, logo, URI de política) e quem o mantém. Alguns
   provedores exibem esses dados na tela de consentimento e podem exigir lista de permissão.
3. No cliente, em `chooseClient` (`src/main/mcp-oauth.ts`): quando o servidor anuncia
   `client_id_metadata_document_supported` e não há client id do usuário nem do diretório,
   usar a URL do documento como `client_id` (antes do registro dinâmico, que a especificação
   nova depreca). O resto do fluxo (PKCE, `resource`, porta fixa) já está pronto.
4. O ensaio (`prepareAuthorization`) ganharia um passo que confirma que o servidor aceita o
   `client_id` por URL, sem concluir o login.

## Riscos e dúvidas

- Servidores que anunciam o suporte mas ainda exigem aprovação do documento por um
  administrador ou lista de permissão do provedor.
- O documento precisa listar **exatamente** a URL de retorno; a porta fixa existe por isso.
  Se a porta estiver ocupada o login cai em outra porta e o provedor recusa: o aviso de
  `redirectUriFallback` já cobre o caso para aplicativos próprios e cobriria este.
- Se o domínio do documento cair, todos os logins por CIMD falham ao mesmo tempo.

## Decisão de hoje

Não implementar. Quem precisa de um conector `oauth-static` cria o aplicativo OAuth no
serviço, cadastra a URL de retorno que a interface mostra e informa o client id (e o segredo,
se houver). O segredo vai para o cofre do sistema.
