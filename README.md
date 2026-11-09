# Tu Agendando

Agenda pessoal e profissional para manter compromissos pessoais (PF) e profissionais (PJ) em um só lugar.

## Funcionalidades

- Cadastro e entrada por e-mail e senha com Supabase Auth.
- Compromissos persistidos no Supabase, separados por calendário PF/PJ e protegidos por políticas RLS por usuário.
- Painel com compromisso atual e próximo, agenda do dia e próximos sete dias.
- Calendário em dia, semana e mês. Clicar em um horário abre o formulário com data e hora preenchidas.
- Busca, filtros, criação, edição e exclusão de compromissos.
- Integração opcional com o calendário principal do Google por OAuth.
- Importação assistida de compromissos guardados no armazenamento local legado.
- Layout responsivo e PWA instalável. O service worker armazena somente arquivos da interface; os dados da agenda não ficam disponíveis offline.

## Acesso privado hospedado

A interface está disponível em [Tu Agendando](https://tu-agendando-thiago.th91.chatgpt.site) para o proprietário autorizado. No primeiro uso, selecione **Criar uma conta**, confirme o e-mail se solicitado e entre para salvar seus compromissos no Supabase. Nesta hospedagem estática, a conexão com o Google Agenda ainda não está ativa; a integração OAuth descrita abaixo depende do servidor local e das credenciais do Google.

## Executar localmente

Requer Node.js 22 ou superior.

1. Copie `.env.example` para `.env`.
2. Configure `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY`. A chave publishable é própria para uso no cliente; a proteção dos dados depende das políticas RLS. Nunca coloque uma chave `service_role` ou outra chave secreta no navegador.
3. No Supabase, habilite cadastro por e-mail. Se a confirmação de e-mail estiver ativa, confirme a conta antes de entrar e configure `http://localhost:4173` como URL de redirecionamento.
4. Execute `npm.cmd start` e abra [http://localhost:4173](http://localhost:4173).

## Banco de dados

As quatro migrações que criam as tabelas, índices, políticas RLS e inicialização do usuário estão em `supabase/migrations`. Elas já foram aplicadas ao projeto Supabase configurado para este aplicativo (`lfxqpoccydzlyrtqejpp`). Para configurar outro projeto, revise os valores de ambiente e aplique as migrações com o Supabase CLI.

## Google Agenda

A integração é opcional. No Google Cloud Console, habilite a Google Calendar API, configure a tela de consentimento OAuth e crie um cliente OAuth do tipo Aplicativo da Web. Cadastre `http://localhost:4173/oauth/callback` como URI de redirecionamento. Preencha `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` somente no `.env` local e reinicie o servidor.

A integração lê o calendário principal e sincroniza compromissos do Tu Agendando enquanto a conexão estiver ativa. Se uma sincronização falhar, o compromisso continua salvo no Supabase e a interface informa a falha. Eventos externos aparecem na agenda; eventos sem classificação ficam em “Sem categoria”.

## Armazenamento e limites desta versão

Os compromissos do Tu Agendando ficam no Supabase. O servidor local mantém dados legados em `%LOCALAPPDATA%\AgendaAqui\agenda.json` até a importação, além do token de renovação OAuth do Google. Esta configuração foi projetada para uso pessoal com o servidor em `localhost`; o armazenamento local do token não deve ser usado como solução para um servidor multiusuário em nuvem.

A PWA pode ser instalada no dispositivo que executa o servidor. Para acessar a aplicação por HTTPS em outros dispositivos, é necessário hospedar a interface e o backend OAuth com armazenamento seguro dos tokens. A agenda não funciona offline.

## Verificação

`npm.cmd run check` verifica a sintaxe do servidor, da interface e do service worker.
