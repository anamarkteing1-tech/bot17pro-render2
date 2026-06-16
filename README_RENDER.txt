BOT17PRO - PREPARADO PARA RENDER

O que foi ajustado:
- PORT usa automaticamente a porta do Render.
- /health para monitor de uptime.
- /api/qr para mostrar QR Code no painel.
- Dados e sessão podem ser salvos em disco persistente usando DATA_DIR e AUTH_DIR.
- package.json com start/check e engines.
- .env.example criado.
- .gitignore criado para não subir .env, node_modules e sessão do WhatsApp em repositório público.

IMPORTANTE:
Para uso sério no Render, use Disk persistente. Sem Disk, quando o Render reiniciar pode pedir QR Code de novo e perder dados locais.

Variáveis recomendadas no Render:
GROQ_API_KEY = sua chave Groq
BOT_PREFIXO = vazio ou seu prefixo
ELEVENLABS_API_KEY = se usar áudio
ELEVENLABS_VOICE_ID = se usar áudio
OPENAI_API_KEY = se usar OpenAI voice
DATA_DIR = /var/data
AUTH_DIR = /var/data/auth_info_baileys

Comandos no Render:
Build Command: npm install
Start Command: npm start
Root Directory: app
