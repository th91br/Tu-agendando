# Publicar Tu Agendando na Vercel

## 1. Importar o repositório

Na conta/equipe Vercel `th91br`, importe `github.com/th91br/Tu-agendando`. Use a raiz do repositório como Root Directory, Framework Preset **Other** e Node.js **22.x**. O `vercel.json` define `npm run build`, as funções em `api/`, as rotas `/config.js` e `/oauth/callback` e os cabeçalhos de segurança. O diretório `public/` contém o site estático. Não configure `server.mjs` como entry point de produção.

O nome sugerido para o projeto é `tu-agendando`. Antes do deploy definitivo, escolha o domínio de produção real e use o mesmo endereço em `APP_ORIGIN`, no Google Cloud e no Supabase Auth. O domínio da Vercel e o da versão Sites são origens diferentes.

## 2. Variáveis de ambiente

Defina no projeto Vercel para **Production**. Cadastre as chaves confidenciais como **Sensitive**. Não copie `.env` para o Git e não use chaves de serviço no navegador.

| Variável | Valor | Visibilidade |
| --- | --- | --- |
| `SUPABASE_URL` | `https://lfxqpoccydzlyrtqejpp.supabase.co` | Pública |
| `SUPABASE_PUBLISHABLE_KEY` | Chave `sb_publishable_...` do projeto, disponível em `.env.example` | Pública; enviada ao navegador |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave `service_role` do mesmo projeto Supabase | **Sensitive**, só servidor |
| `GOOGLE_CLIENT_ID` | ID do cliente OAuth Web no Google Cloud | Servidor |
| `GOOGLE_CLIENT_SECRET` | Segredo desse cliente OAuth | **Sensitive**, só servidor |
| `APP_ORIGIN` | `https://DOMINIO-DE-PRODUCAO`, sem barra final | Servidor |
| `OAUTH_STATE_SECRET` | 32 bytes aleatórios em base64url (43 caracteres) | **Sensitive**, só servidor |

Gere `OAUTH_STATE_SECRET` localmente com `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Não publique o resultado. O serviço Google só fica disponível quando todas as variáveis acima estão corretas e a requisição chega por `APP_ORIGIN`. Não reutilize a `service_role` como chave publishable.

Para **Preview**, configure pelo menos `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` se quiser testar autenticação. O Google fica inativo em URLs de preview variáveis. Um ambiente de preview com Google requer domínio estável, `APP_ORIGIN` próprio e URI OAuth correspondente. Se usar a mesma base Supabase no preview, os eventos gravados serão reais.

## 3. Google Cloud e Supabase Auth

Ative a **Google Calendar API** no projeto Google Cloud. Configure a tela de consentimento e um cliente OAuth do tipo **Aplicativo da Web**. Insira em **Authorized redirect URIs** exatamente `https://DOMINIO-DE-PRODUCAO/oauth/callback` e em **Authorized JavaScript origins** o domínio de produção. Solicite os escopos `openid`, `email` e `https://www.googleapis.com/auth/calendar.events.owned`. A disponibilidade para usuários externos depende do estado da tela de consentimento e das políticas do Google.

Em **Supabase → Authentication → URL Configuration**, ajuste **Site URL** para o domínio de produção e inclua o domínio permitido em **Redirect URLs** para fluxos de confirmação e recuperação de conta. Revise as configurações de confirmação de e-mail e proteção de senha no Auth. O projeto Supabase já tem as tabelas e as políticas de acesso; a migração das funções privadas de token foi aplicada em 10/11/2026.

## 4. Validar o deploy

1. Execute `npm ci` e `npm run build` localmente ou confira o workflow de CI no GitHub.
2. Na Vercel, confirme que `/api/health` retorna `status: "ready"` sem expor valores de configuração.
3. Acesse o domínio, entre na conta Supabase e crie um evento PF e outro PJ. Recarregue a página e verifique que permanecem.
4. Teste as visões dia, semana e mês em desktop e celular; edite e exclua um evento.
5. Depois de configurar OAuth, conecte o Google, crie e edite um evento e verifique no Google Agenda. Desconecte e confirme que a agenda PF/PJ continua acessível.
6. Instale a PWA em HTTPS. Faça novo deploy após alterar variáveis na Vercel.

O `/api/health` não prova que as credenciais do Google funcionam; o fluxo OAuth precisa de validação real. A função de importação de arquivo local só roda com `npm start` no computador que contém os dados antigos.

## Segurança e operação

As funções verificam o JWT no Supabase antes de ler o token Google. As RPCs do token estão restritas ao papel `service_role`, e o token fica no esquema `private`. O estado OAuth usa cookie HttpOnly/Secure, PKCE e expiração. Os dados do calendário não são armazenados pelo service worker. `APP_ORIGIN` fixa o destino OAuth e evita ativar a conexão em domínios de preview não autorizados.

Mantenha os segredos só no painel de ambiente da Vercel, com acesso restrito. Se uma chave de serviço ou segredo Google vazar, rotacione no provedor e atualize a Vercel. As funções têm `no-store`, e o cabeçalho CSP limita conexões do navegador ao projeto Supabase especificado. Revise o alerta do Supabase Security Advisor sobre **Leaked password protection**, uma configuração do Auth e não parte da migração SQL.
