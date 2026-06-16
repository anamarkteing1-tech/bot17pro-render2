BOT17PRO - VERSAO ONLINE PARA RENDER

Esta pasta foi limpa para uso online no Render.
Nao inclui .env, node_modules, sessao do WhatsApp nem BAT local.

Arquivos principais:
- server.js
- package.json
- package-lock.json
- public/
- services/
- data/
- .env.example
- render.yaml
- .nvmrc e .node-version fixando Node 20

Comandos no Render:
Build Command: npm install
Start Command: npm start

Variaveis recomendadas no Render:
GROQ_API_KEY = sua chave
ELEVENLABS_API_KEY = sua chave se usar audio
DATA_DIR = /var/data
AUTH_DIR = /var/data/auth_info_baileys
NODE_VERSION = 20

Importante:
Use Disk persistente no Render com Mount Path /var/data para nao perder QR, sessoes e dados quando reiniciar.


LOGIN DO PAINEL
---------------
Adicione no Render, em Environment Variables:

PANEL_PASSWORD=sua_senha_forte
PANEL_SESSION_SECRET=um_texto_grande_aleatorio

Depois faça deploy. Ao abrir o link do Render, o painel vai pedir senha antes de mostrar QR Code, API da Groq e demais funções.
