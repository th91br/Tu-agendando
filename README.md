# Tu Agendando

Agenda pessoal e profissional para organizar compromissos PF e PJ em um s� lugar.

## O que est� implementado

- Conta por e-mail e senha com Supabase Auth.
- Compromissos persistidos no Supabase, com separa��o PF/PJ e pol�ticas RLS por usu�rio.
- Painel com compromisso atual/pr�ximo, eventos do dia e vis�o dos pr�ximos sete dias.
- Calend�rio em dia, semana e m�s; clique em um hor�rio para abrir o cadastro j� preenchido.
- Busca, filtros, edi��o, exclus�o e tratamento de conflitos de edi��o.
- Integra��o opcional com o calend�rio principal do Google por OAuth, incluindo leitura, cria��o e edi��o.
- Importa��o assistida de compromissos que ainda estejam no armazenamento local antigo.
- Interface responsiva e PWA instal�vel; o cache cont�m somente a interface, n�o os dados da agenda.

## Executar localmente

Requer Node.js 22 ou superior.

1. Copie `.env.example` para `.env`.
2. Confira `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY`. A chave publishable pode ficar no cliente, pois a autoriza��o dos dados depende de RLS. Nunca use `service_role` ou uma chave secreta no navegador ou neste arquivo.
3. No Supabase, habilite o cadastro por e-mail. Se a confirma��o de e-mail estiver ativa, confirme a conta antes de entrar. Configure a URL de redirecionamento de confirma��o para `http://localhost:4173`.
4. Execute `npm.cmd start` e abra [http://localhost:4173](http://localhost:4173).

Este aplicativo est� configurado para o projeto Supabase `lfxqpoccydzlyrtqejpp`, cujo esquema e pol�ticas RLS j� est�o aplicados. A configura��o pressup�e esse banco existente.

## Google Agenda

A integra��o � opcional. No Google Cloud Console, habilite Google Calendar API, configure o consentimento OAuth e crie um cliente OAuth do tipo Aplicativo da Web. Cadastre `http://localhost:4173/oauth/callback` como URI de redirecionamento. Depois, informe `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` somente no `.env` local e reinicie o servidor.

O aplicativo usa o calend�rio principal da conta Google. Compromissos novos criados enquanto a conex�o est� ativa s�o gravados no Tu Agendando e enviados ao Google. Se a sincroniza��o falhar, o compromisso permanece salvo no Supabase e o aplicativo informa o erro. Eventos externos do Google aparecem na agenda; eventos sem classifica��o ficam em "Sem categoria".

## Armazenamento e limites desta vers�o

Os compromissos Tu Agendando ficam no Supabase. O servidor local mant�m em `%LOCALAPPDATA%\AgendaAqui\agenda.json` os compromissos legados at� a importa��o e o token de renova��o OAuth do Google. Essa vers�o foi projetada para uso pessoal em `localhost`; o token n�o deve ser tratado como armazenamento apropriado para um servidor multiusu�rio em nuvem.

A PWA pode ser instalada no dispositivo que executa o servidor local. Para usar em outro dispositivo ou publicar com HTTPS, � necess�rio hospedar um backend seguro para o OAuth e o armazenamento dos tokens. A interface n�o guarda compromissos offline.

## Verifica��o

`npm.cmd run check` verifica a sintaxe do servidor, da interface e do service worker.

