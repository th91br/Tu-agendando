# Tu Agendando

Agenda pessoal e profissional (PF/PJ), responsiva e instalável como PWA. O frontend grava os compromissos no Supabase com autenticação e RLS por usuário. A integração opcional com Google Agenda usa funções de servidor na Vercel e guarda o token de renovação somente no esquema privado do banco.

## Funcionalidades

- Painel com próximos compromissos; calendário em dia, semana e mês; cadastro ao selecionar um horário.
- Busca, filtros PF/PJ, edição, exclusão e controle de conflito entre sessões.
- OAuth Google com PKCE, sincronização do calendário principal e credenciais restritas ao servidor.
- PWA com cache da interface. Os compromissos exigem conexão; dados pessoais não entram no cache do service worker.

## Publicação na Vercel

O repositório `th91br/Tu-agendando` está preparado para importação em uma conta Vercel. As instruções e variáveis estão em [VERCEL.md](VERCEL.md). A migração SQL `20261110001754_vercel_google_oauth_rpc.sql` já foi aplicada ao projeto Supabase `lfxqpoccydzlyrtqejpp`.

O build (`npm run build`) valida a sintaxe e executa os testes. Arquivos estáticos estão em `public/`; as funções em `api/`. O endpoint `/api/health` permite conferir o ambiente após a publicação sem expor segredos.

## Desenvolvimento local

Requer Node.js 22. Copie `.env.example` para `.env`, confira o URL e a chave **publishable** do Supabase e execute `npm start`. Abra `http://localhost:4173`. O servidor local `server.mjs` continua disponível para importar compromissos legados guardados neste computador. Nunca coloque uma chave `service_role` ou `sb_secret_` no frontend.

Para Google no servidor local, crie um cliente OAuth Web no Google Cloud e adicione `http://localhost:4173/oauth/callback` às URIs de redirecionamento. Configure `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no `.env`. A configuração de produção usa outra URI, descrita em [VERCEL.md](VERCEL.md).

## Dados antigos e limites

O servidor local mantém `%LOCALAPPDATA%\TuAgendando\agenda.json` para a importação assistida dos registros antigos. Funções da Vercel não acessam esse arquivo: na hospedagem, a importação local aparece como indisponível. Importe no servidor local com a mesma conta Supabase antes ou depois da publicação; os eventos importados aparecem no ambiente hospedado após autenticar. A sessão do navegador no endereço antigo não é transferida para o novo domínio; entre novamente.

O serviço Google não opera até que as credenciais OAuth, o domínio definitivo e os segredos de produção sejam configurados. A agenda PF/PJ funciona com as variáveis públicas do Supabase. O projeto ainda não tem testes de ponta a ponta num domínio Vercel publicado.
