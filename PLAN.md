# Plano atual � Tu Agendando

## Entregue nesta vers�o

- Interface responsiva para painel, dia, semana e m�s.
- Cadastro direto na grade com in�cio e fim sugeridos pelo hor�rio clicado.
- Classifica��o PF/PJ, busca e filtros.
- Login e cadastro por e-mail com Supabase Auth.
- Persist�ncia de compromissos no Supabase com RLS e controle de edi��o concorrente.
- Sincroniza��o opcional com o calend�rio principal do Google.
- Importa��o assistida de compromissos do armazenamento local antigo.
- Manifesto e service worker para instala��o PWA com cache apenas da interface.

## Configura��o antes do primeiro uso

1. Configurar Auth por e-mail e a URL local de confirma��o no Supabase.
2. Adicionar credenciais OAuth do Google ao arquivo local `.env`, se a sincroniza��o for necess�ria.
3. Entrar, cadastrar um compromisso PF e outro PJ e verificar que aparecem apenas na conta autenticada.
4. Instalar a PWA no dispositivo local.

## Limite de implanta��o

A vers�o atual � um aplicativo pessoal executado em `localhost`. Acesso remoto pelo celular e hospedagem multiusu�rio exigem um backend HTTPS com gest�o segura dos tokens OAuth.

