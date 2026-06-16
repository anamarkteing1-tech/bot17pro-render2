import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import pino from "pino";
import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { gerarRespostaComContexto } from "./services/ai.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = pino({ level: "silent" });
const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Render/online: permite salvar dados e sessão em disco persistente.
// Local: continua usando as pastas normais do projeto.
const DATA_ROOT = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const AUTH_ROOT = process.env.AUTH_DIR
  ? path.resolve(process.env.AUTH_DIR)
  : path.join(__dirname, "auth_info_baileys");

fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.mkdirSync(AUTH_ROOT, { recursive: true });

function copiarJsonPadraoSeExistir(file) {
  const destino = path.join(DATA_ROOT, file);
  const origem = path.join(__dirname, "data", file);
  if (!fs.existsSync(destino) && fs.existsSync(origem)) {
    fs.copyFileSync(origem, destino);
  }
}

["config.json", "conversas.json", "memoria.json", "produtos.json", "servicos.json"].forEach(copiarJsonPadraoSeExistir);

let sock;
let qrAtual = null;
let estadoAtual = "iniciando";

function dataPath(file) {
  return path.join(DATA_ROOT, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(dataPath(file), "utf-8"));
}

function writeJson(file, content) {
  fs.writeFileSync(dataPath(file), JSON.stringify(content, null, 2), "utf-8");
}

function garantirArquivoJson(file, padrao) {
  const caminho = dataPath(file);
  const pasta = path.dirname(caminho);
  if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });
  if (!fs.existsSync(caminho)) {
    fs.writeFileSync(caminho, JSON.stringify(padrao, null, 2), "utf-8");
  }
}

function readJsonSafe(file, padrao) {
  try {
    garantirArquivoJson(file, padrao);
    return JSON.parse(fs.readFileSync(dataPath(file), "utf-8"));
  } catch {
    return padrao;
  }
}

function writeJsonSafe(file, content) {
  garantirArquivoJson(file, content);
  fs.writeFileSync(dataPath(file), JSON.stringify(content, null, 2), "utf-8");
}

function nomeCurtoContato(jid = "") {
  const n = normalizarNumero(String(jid || "").split("@")[0]);
  if (!n) return String(jid || "");
  return n.startsWith("55") ? `+${n}` : n;
}

function lerConversas() {
  const data = readJsonSafe("conversas.json", { conversas: {} });
  if (!data.conversas) data.conversas = {};
  return data;
}

function salvarConversas(data) {
  writeJsonSafe("conversas.json", data);
}

function registrarMensagemPainel(jid = "", direcao = "recebida", texto = "", tipo = "texto", extra = {}) {
  try {
    if (!jid) return;
    const data = lerConversas();
    if (!data.conversas[jid]) {
      data.conversas[jid] = {
        jid,
        numero: nomeCurtoContato(jid),
        nome: extra.nome || nomeCurtoContato(jid),
        mensagens: [],
        naoLidas: 0,
        atualizadoEm: new Date().toISOString(),
        atendimentoHumano: false
      };
    }

    const conv = data.conversas[jid];
    conv.jid = jid;
    conv.numero = conv.numero || nomeCurtoContato(jid);
    conv.nome = extra.nome || conv.nome || nomeCurtoContato(jid);
    conv.ultimaMensagem = String(texto || "");
    conv.ultimoTipo = tipo;
    conv.ultimaDirecao = direcao;
    conv.atualizadoEm = new Date().toISOString();
    if (direcao === "recebida") conv.naoLidas = Number(conv.naoLidas || 0) + 1;

    conv.mensagens = Array.isArray(conv.mensagens) ? conv.mensagens : [];
    conv.mensagens.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      direcao,
      tipo,
      texto: String(texto || ""),
      criadoEm: new Date().toISOString()
    });
    conv.mensagens = conv.mensagens.slice(-120);

    salvarConversas(data);
  } catch (error) {
    console.error("Erro ao registrar conversa no painel:", error.message);
  }
}

function atualizarAtendimentoHumano(jid = "", ativo = false) {
  const data = lerConversas();
  if (!data.conversas[jid]) {
    data.conversas[jid] = { jid, numero: nomeCurtoContato(jid), nome: nomeCurtoContato(jid), mensagens: [], naoLidas: 0 };
  }
  data.conversas[jid].atendimentoHumano = Boolean(ativo);
  data.conversas[jid].atualizadoEm = new Date().toISOString();
  salvarConversas(data);
}

function configurarBloqueioNumero(numeroOuJid = "", bloquear = true) {
  const config = readJson("config.json");
  const numero = normalizarNumero(String(numeroOuJid || "").split("@")[0]);
  if (!numero) throw new Error("Número inválido.");
  const atuais = Array.isArray(config.numerosBloqueados) ? config.numerosBloqueados : [];
  const existe = atuais.some((n) => normalizarNumero(n) === numero);
  if (bloquear && !existe) atuais.push(numero);
  if (!bloquear) {
    config.numerosBloqueados = atuais.filter((n) => normalizarNumero(n) !== numero);
  } else {
    config.numerosBloqueados = atuais;
  }
  writeJson("config.json", config);
  return config.numerosBloqueados;
}


function normalizarNumero(valor = "") {
  return String(valor || "").replace(/\D/g, "");
}

function lerMapeamentoLidPorNumero(numero = "") {
  try {
    const n = normalizarNumero(numero);
    if (!n) return null;
    const arquivo = path.join(__dirname, "auth_info_baileys", `lid-mapping-${n}.json`);
    if (!fs.existsSync(arquivo)) return null;
    return normalizarNumero(JSON.parse(fs.readFileSync(arquivo, "utf-8")));
  } catch {
    return null;
  }
}

function lerNumeroPorLid(lid = "") {
  try {
    const n = normalizarNumero(lid);
    if (!n) return null;
    const arquivo = path.join(__dirname, "auth_info_baileys", `lid-mapping-${n}_reverse.json`);
    if (!fs.existsSync(arquivo)) return null;
    return normalizarNumero(JSON.parse(fs.readFileSync(arquivo, "utf-8")));
  } catch {
    return null;
  }
}

function montarIdentificadoresDoContato(remoteJid = "", msg = null) {
  const ids = new Set();

  const adicionar = (valor) => {
    const n = normalizarNumero(String(valor || "").split("@")[0]);
    if (!n) return;
    ids.add(n);

    const lid = lerMapeamentoLidPorNumero(n);
    if (lid) ids.add(lid);

    const numeroReal = lerNumeroPorLid(n);
    if (numeroReal) ids.add(numeroReal);
  };

  adicionar(remoteJid);
  adicionar(msg?.key?.remoteJid);
  adicionar(msg?.key?.participant);
  adicionar(msg?.participant);

  return [...ids];
}

function numeroEstaBloqueado(remoteJid = "", msg = null) {
  try {
    const config = readJson("config.json");
    const bloqueados = Array.isArray(config.numerosBloqueados) ? config.numerosBloqueados : [];

    const bloqueadosNormalizados = new Set();
    for (const item of bloqueados) {
      const n = normalizarNumero(item);
      if (!n) continue;
      bloqueadosNormalizados.add(n);

      const lid = lerMapeamentoLidPorNumero(n);
      if (lid) bloqueadosNormalizados.add(lid);

      const numeroReal = lerNumeroPorLid(n);
      if (numeroReal) bloqueadosNormalizados.add(numeroReal);
    }

    const idsMensagem = montarIdentificadoresDoContato(remoteJid, msg);

    return idsMensagem.some((idMsg) =>
      [...bloqueadosNormalizados].some((bloq) =>
        idMsg === bloq || idMsg.endsWith(bloq) || bloq.endsWith(idMsg)
      )
    );
  } catch (error) {
    console.error("Erro ao verificar bloqueio:", error.message);
    return false;
  }
}

function lerMemoria() {
  try {
    return JSON.parse(fs.readFileSync(dataPath("memoria.json"), "utf-8"));
  } catch {
    return { clientes: {} };
  }
}


function textoNormalizadoMemoria(valor = "") {
  return String(valor || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function detectarDadosDoCliente(mensagem = "", cliente = {}) {
  const original = String(mensagem || "").trim();
  const msg = textoNormalizadoMemoria(original);
  const aprendizados = [];

  const nomeMatch = original.match(/(?:meu nome é|me chamo|sou o|sou a|eu sou)\s+([a-zà-úA-ZÀ-Ú]{2,20})/i);
  if (nomeMatch && nomeMatch[1]) {
    const nome = nomeMatch[1].trim();
    if (!cliente.nome || cliente.nome.toLowerCase() !== nome.toLowerCase()) {
      cliente.nome = nome;
      aprendizados.push(`nome: ${nome}`);
    }
  }

  const cidadeMatch = original.match(/(?:sou de|moro em|cidade de|estou em)\s+([a-zà-úA-ZÀ-Ú\s]{3,40})/i);
  if (cidadeMatch && cidadeMatch[1]) {
    const cidade = cidadeMatch[1].trim().replace(/[.!?].*$/, "");
    if (cidade && cidade.length <= 40) {
      cliente.cidade = cidade;
      aprendizados.push(`cidade: ${cidade}`);
    }
  }

  if (msg.includes("vip")) {
    cliente.interesse = "vip";
    cliente.produtoInteresse = "vip";
    cliente.etapa = "interessado";
    aprendizados.push("interesse: vip");
  }

  if (msg.includes("pack")) {
    cliente.interesse = cliente.interesse || "pack";
    cliente.produtoInteresse = "pack";
    if (cliente.etapa === "frio") cliente.etapa = "curioso";
    aprendizados.push("interesse: pack");
  }

  if (msg.includes("previa") || msg.includes("ver antes") || msg.includes("amostra")) {
    cliente.objecao = "quer ver antes";
    aprendizados.push("objeção: quer ver antes");
  }

  if (msg.includes("caro") || msg.includes("desconto") || msg.includes("mais barato")) {
    cliente.objecao = "preço";
    aprendizados.push("objeção: preço");
  }

  if (msg.includes("agora nao") || msg.includes("depois") || msg.includes("mais tarde")) {
    cliente.objecao = "vai decidir depois";
    aprendizados.push("objeção: decidir depois");
  }

  if (msg.includes("pix") || msg.includes("pagar") || msg.includes("pagamento") || msg.includes("como paga") || msg.includes("como pago")) {
    cliente.pediuPix = true;
    cliente.etapa = "pronto";
    aprendizados.push("pediu pagamento");
  }

  if (msg.includes("quero") || msg.includes("vou pegar") || msg.includes("fechar") || msg.includes("comprar")) {
    if (cliente.etapa !== "pronto") cliente.etapa = "quase_comprando";
    aprendizados.push("sinal de compra");
  }

  // Estilo do cliente: ajuda a responder de forma menos robótica.
  if (original.length <= 18) {
    cliente.estiloCliente = "curto e direto";
  } else if (original.length >= 90) {
    cliente.estiloCliente = "explica bastante";
  }

  cliente.totalMensagens = Number(cliente.totalMensagens || 0) + 1;

  if (!Array.isArray(cliente.aprendizados)) cliente.aprendizados = [];
  for (const a of aprendizados) {
    if (a && !cliente.aprendizados.includes(a)) cliente.aprendizados.push(a);
  }
  cliente.aprendizados = cliente.aprendizados.slice(-12);

  const resumoPartes = [];
  if (cliente.nome) resumoPartes.push(`Nome: ${cliente.nome}`);
  if (cliente.cidade) resumoPartes.push(`Cidade: ${cliente.cidade}`);
  if (cliente.produtoInteresse || cliente.interesse) resumoPartes.push(`Interesse: ${cliente.produtoInteresse || cliente.interesse}`);
  if (cliente.objecao) resumoPartes.push(`Objeção: ${cliente.objecao}`);
  if (cliente.etapa) resumoPartes.push(`Etapa: ${cliente.etapa}`);
  if (cliente.estiloCliente) resumoPartes.push(`Estilo: ${cliente.estiloCliente}`);
  cliente.resumo = resumoPartes.join(" | ");

  return cliente;
}

function criarClienteMemoria() {
  return {
    nome: null,
    cidade: null,
    interesse: null,
    produtoInteresse: null,
    objecao: null,
    estiloCliente: null,
    pediuPix: false,
    etapa: "frio",
    resumo: "",
    aprendizados: [],
    totalMensagens: 0,
    ultimaMensagem: null,
    ultimaResposta: null,
    atualizadoEm: null,
    historico: []
  };
}


function salvarMemoria(numero, mensagem, resposta = null) {
  const data = lerMemoria();

  if (!data.clientes) data.clientes = {};

  if (!data.clientes[numero]) {
    data.clientes[numero] = criarClienteMemoria();
  }

  const cliente = data.clientes[numero];

  if (!Array.isArray(cliente.historico)) cliente.historico = [];
  if (!Array.isArray(cliente.aprendizados)) cliente.aprendizados = [];

  detectarDadosDoCliente(mensagem, cliente);

  cliente.historico.push({
    role: "user",
    content: String(mensagem || ""),
    criadoEm: new Date().toISOString()
  });

  if (resposta) {
    cliente.historico.push({
      role: "assistant",
      content: String(resposta || ""),
      criadoEm: new Date().toISOString()
    });
    cliente.ultimaResposta = resposta;
  }

  // Mantém histórico útil sem deixar o arquivo pesado.
  cliente.historico = cliente.historico
    .filter((m) => m && m.content)
    .slice(-24);

  cliente.ultimaMensagem = mensagem;
  cliente.atualizadoEm = new Date().toISOString();

  fs.writeFileSync(
    dataPath("memoria.json"),
    JSON.stringify(data, null, 2),
    "utf-8"
  );
}
function extrairTexto(msg) {
  return (
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    msg?.message?.buttonsResponseMessage?.selectedButtonId ||
    msg?.message?.listResponseMessage?.title ||
    msg?.message?.templateButtonReplyMessage?.selectedId ||
    msg?.message?.templateButtonReplyMessage?.selectedDisplayText ||
    msg?.message?.interactiveResponseMessage?.body?.text ||
    ""
  );
}

function calcularDelayHumano(texto = "") {
  const tamanho = String(texto || "").length;

  // Atraso humano mais natural: respostas curtas demoram menos,
  // respostas maiores demoram um pouco mais, sem travar demais o bot.
  const base = 4000;
  const porTamanho = Math.min(tamanho * 45, 6000);
  const aleatorio = Math.floor(Math.random() * 3000);

  return base + porTamanho + aleatorio;
}

function montarJidWhatsApp(numero = "") {
  const valor = String(numero || "").trim();
  if (!valor) return "";
  if (valor.includes("@")) return valor;
  const n = normalizarNumero(valor);
  if (!n) return "";
  return `${n}@s.whatsapp.net`;
}

function limparTextoParaAudio(texto = "") {
  return String(texto || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\*_~`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function detalhesErroApi(error) {
  const status = error?.response?.status;
  let detalhe = error?.response?.data;
  try {
    if (Buffer.isBuffer(detalhe)) detalhe = detalhe.toString("utf-8");
    if (typeof detalhe === "object") detalhe = JSON.stringify(detalhe);
  } catch {}
  return `${status ? `HTTP ${status} - ` : ""}${detalhe || error.message}`;
}

function limparCampoSecreto(valor = "") {
  return String(valor || "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function mascararChave(valor = "") {
  const v = limparCampoSecreto(valor);
  if (!v) return "vazia";
  if (v.length <= 10) return `${v.slice(0, 2)}*** (${v.length} caracteres)`;
  return `${v.slice(0, 6)}...${v.slice(-4)} (${v.length} caracteres)`;
}

async function gerarAudioTTS(textoOriginal = "") {
  const config = readJson("config.json");
  const audio = config.audio || {};
  const provider = String(audio.provider || "elevenlabs").toLowerCase().trim();
  const texto = limparTextoParaAudio(textoOriginal);

  if (!texto) throw new Error("Digite uma mensagem para transformar em áudio.");

  if (provider === "openai") {
    const apiKey = limparCampoSecreto(audio.openaiApiKey || process.env.OPENAI_API_KEY || "");
    if (!apiKey) throw new Error("Configure a chave da OpenAI no painel ou no .env.");

    const resposta = await axios.post(
      "https://api.openai.com/v1/audio/speech",
      {
        model: limparCampoSecreto(audio.openaiModel || "gpt-4o-mini-tts"),
        voice: limparCampoSecreto(audio.openaiVoice || "nova"),
        input: texto,
        response_format: "mp3"
      },
      {
        responseType: "arraybuffer",
        timeout: 60000,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    return Buffer.from(resposta.data);
  }

  const apiKey = limparCampoSecreto(audio.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY || "");
  const voiceId = limparCampoSecreto(audio.elevenLabsVoiceId || process.env.ELEVENLABS_VOICE_ID || "");
  if (!apiKey) throw new Error("Configure a chave da ElevenLabs no painel ou no .env.");
  if (!voiceId) throw new Error("Configure o Voice ID da ElevenLabs no painel ou no .env.");

  const modeloPrincipal = limparCampoSecreto(audio.elevenLabsModel || "eleven_multilingual_v2");
  const modelosParaTentar = [...new Set([modeloPrincipal, "eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_v3"].filter(Boolean))];
  let ultimoErro = null;

  console.log(`ElevenLabs TTS: key=${mascararChave(apiKey)} voiceId=${voiceId} modelos=${modelosParaTentar.join(",")}`);

  for (const modelo of modelosParaTentar) {
    try {
      const resposta = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        {
          text: texto,
          model_id: modelo,
          voice_settings: {
            stability: Number(audio.stability ?? 0.42),
            similarity_boost: Number(audio.similarityBoost ?? 0.78),
            style: Number(audio.style ?? 0),
            use_speaker_boost: true
          }
        },
        {
          responseType: "arraybuffer",
          timeout: 60000,
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg"
          }
        }
      );

      const buffer = Buffer.from(resposta.data);
      if (!buffer.length) throw new Error("A ElevenLabs retornou áudio vazio.");
      console.log(`ElevenLabs TTS ok: modelo=${modelo}, tamanho=${buffer.length} bytes`);
      return buffer;
    } catch (error) {
      ultimoErro = error;
      const status = error?.response?.status;
      console.error(`Falha ElevenLabs modelo=${modelo}:`, detalhesErroApi(error));

      // 401 é sempre chave/conta/permissão. Não adianta testar outro modelo.
      if (status === 401) break;
    }
  }

  throw new Error(`Erro ElevenLabs: ${detalhesErroApi(ultimoErro)}`);
}


async function localizarFfmpeg() {
  const candidatos = [];

  try {
    const mod = await import("ffmpeg-static");
    const bin = mod.default || mod;
    if (typeof bin === "string") candidatos.push(bin);
  } catch (error) {
    console.warn("ffmpeg-static nao carregou:", error.message);
  }

  // Caminhos comuns quando o ZIP foi gerado em outro sistema e o npm install ainda nao recompilou o ffmpeg-static.
  candidatos.push(
    path.join(process.cwd(), "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    path.join(process.cwd(), "ffmpeg.exe"),
    path.join(process.cwd(), "ffmpeg", "bin", "ffmpeg.exe"),
    path.join(process.cwd(), "ffmpeg", "ffmpeg.exe")
  );

  for (const candidato of candidatos) {
    if (candidato && fs.existsSync(candidato)) return candidato;
  }

  // Ultima tentativa: usar ffmpeg instalado no Windows/PATH.
  return "ffmpeg";
}

function erroFfmpegAusente(error) {
  return error?.code === "ENOENT" || /spawn ffmpeg ENOENT/i.test(String(error?.message || ""));
}

function gerarWaveformPadrao() {
  return Uint8Array.from(Array.from({ length: 64 }, (_, i) => 25 + Math.round(Math.abs(Math.sin(i / 4)) * 55)));
}

function jidMesmoContato(a = "", b = "") {
  const na = normalizarNumero(String(a || "").split("@")[0]);
  const nb = normalizarNumero(String(b || "").split("@")[0]);
  if (!na || !nb) return String(a || "") === String(b || "");
  if (na === nb || na.endsWith(nb) || nb.endsWith(na)) return true;

  const lidA = lerMapeamentoLidPorNumero(na) || lerNumeroPorLid(na);
  const lidB = lerMapeamentoLidPorNumero(nb) || lerNumeroPorLid(nb);
  return Boolean(lidA && normalizarNumero(lidA) === nb) || Boolean(lidB && normalizarNumero(lidB) === na);
}

async function converterAudioParaPttWhatsApp(bufferAudio) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-audio-"));
  const entrada = path.join(tmpDir, "entrada_audio.mp3");
  const saida = path.join(tmpDir, "saida.ogg");
  const rawPcm = path.join(tmpDir, "waveform.raw");

  try {
    fs.writeFileSync(entrada, bufferAudio);
    const ffmpeg = await localizarFfmpeg();
    console.log("FFmpeg usado para audio:", ffmpeg);

    // Para aparecer igual áudio de voz do WhatsApp, precisa ser OGG/Opus + ptt:true.
    try {
      await execFileAsync(ffmpeg, [
        "-y",
        "-i", entrada,
        "-avoid_negative_ts", "make_zero",
        "-vn",
        "-ac", "1",
        "-ar", "48000",
        "-c:a", "libopus",
        "-b:a", "32k",
        "-vbr", "on",
        "-compression_level", "10",
        "-application", "voip",
        saida
      ], { timeout: 60000 });
    } catch (ffmpegErr) {
      if (erroFfmpegAusente(ffmpegErr)) {
        console.warn("FFmpeg nao encontrado. Rodando fallback em MP3. Para PTT com ondinha, execute o iniciar-app.bat para instalar/recompilar o ffmpeg-static.");
        return { buffer: bufferAudio, waveform: gerarWaveformPadrao(), mimetype: "audio/mpeg", convertido: false };
      }
      throw ffmpegErr;
    }

    let waveform = gerarWaveformPadrao();
    try {
      await execFileAsync(ffmpeg, [
        "-y",
        "-i", entrada,
        "-ac", "1",
        "-ar", "8000",
        "-f", "s16le",
        rawPcm
      ], { timeout: 60000 });

      const pcm = fs.readFileSync(rawPcm);
      const totalSamples = Math.floor(pcm.length / 2);
      const samples = 64;
      const blockSize = Math.max(1, Math.floor(totalSamples / samples));
      const valores = [];

      for (let i = 0; i < samples; i++) {
        let soma = 0;
        let count = 0;
        const inicio = i * blockSize * 2;
        const fim = Math.min(pcm.length, inicio + blockSize * 2);
        for (let pos = inicio; pos + 1 < fim; pos += 2) {
          soma += Math.abs(pcm.readInt16LE(pos));
          count++;
        }
        valores.push(count ? soma / count : 0);
      }

      const maior = Math.max(...valores, 1);
      waveform = Uint8Array.from(valores.map(v => Math.max(5, Math.min(100, Math.round((v / maior) * 100)))));
    } catch (waveErr) {
      console.warn("Nao foi possivel gerar waveform real, usando waveform padrao:", waveErr.message);
    }

    const convertido = fs.readFileSync(saida);
    if (!convertido.length) throw new Error("FFmpeg gerou áudio vazio.");
    return { buffer: convertido, waveform: Uint8Array.from(waveform), mimetype: "audio/ogg; codecs=opus", convertido: true };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function iniciarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_ROOT);
  const { version } = await fetchLatestWaWebVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    browser: ["Chrome (Linux)", "Desktop", "1.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrAtual = qr;
      estadoAtual = "aguardando_qr";
      console.log("\n===== ESCANEIE O QR CODE NO WHATSAPP =====\n");
      qrcode.generate(qr, { small: true });
      console.log("\n==========================================\n");
    }

    if (connection === "connecting") {
      estadoAtual = "conectando";
      console.log("Conectando ao WhatsApp...");
    }

    if (connection === "open") {
      estadoAtual = "conectado";
      qrAtual = null;
      console.log("WhatsApp conectado com sucesso.");
    }

    if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);

      estadoAtual = shouldReconnect ? "reconectando" : "desconectado";
      console.log("Conexão fechada. Reconectar:", shouldReconnect);

      if (shouldReconnect) {
        setTimeout(() => {
          iniciarWhatsApp().catch(err => console.error("Erro ao reiniciar conexão:", err.message));
        }, 3000);
      } else {
        console.log("Sessão deslogada. Apague a pasta auth_info_baileys para parear novamente.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!messages || !messages.length) return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key?.fromMe) continue;

        const remoteJid = msg.key?.remoteJid || "";
        if (!remoteJid.includes("@")) continue;

        const texto = extrairTexto(msg);
        if (texto) registrarMensagemPainel(remoteJid, "recebida", texto, "texto", { nome: msg.pushName });

        if (numeroEstaBloqueado(remoteJid, msg)) {
          console.log(`Número bloqueado no painel, sem resposta automática: ${remoteJid}`);
          continue;
        }

        if (!texto) continue;

        const prefixo = process.env.BOT_PREFIXO || "";
        if (prefixo && !texto.startsWith(prefixo)) continue;

        const pergunta = prefixo ? texto.slice(prefixo.length).trim() : texto.trim();
        if (!pergunta) continue;

        const resposta = await gerarRespostaComContexto(pergunta, remoteJid);
        salvarMemoria(remoteJid, pergunta, resposta);
        const delay = calcularDelayHumano(resposta);

        await sock.sendPresenceUpdate("composing", remoteJid);
        await new Promise((resolve) => setTimeout(resolve, delay));
        await sock.sendMessage(remoteJid, { text: resposta });
        registrarMensagemPainel(remoteJid, "enviada", resposta, "texto");

        console.log(`Mensagem respondida para: ${remoteJid} | delay: ${delay}ms`);
      } catch (error) {
        console.error("Erro ao responder mensagem:", error.message);
      }
    }
  });
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/status", (_req, res) => {
  res.json({ ok: true, estado: estadoAtual, qrDisponivel: Boolean(qrAtual) });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, estado: estadoAtual, uptime: process.uptime() });
});

app.get("/api/qr", (_req, res) => {
  res.json({ ok: true, estado: estadoAtual, qrDisponivel: Boolean(qrAtual), qr: qrAtual || null });
});

app.get("/api/produtos", (_req, res) => res.json(readJson("produtos.json")));
app.post("/api/produtos", (req, res) => { writeJson("produtos.json", req.body); res.json({ ok: true }); });

app.get("/api/servicos", (_req, res) => res.json(readJson("servicos.json")));
app.post("/api/servicos", (req, res) => { writeJson("servicos.json", req.body); res.json({ ok: true }); });

app.get("/api/config", (_req, res) => res.json(readJson("config.json")));
app.post("/api/config", (req, res) => { writeJson("config.json", req.body); res.json({ ok: true }); });


app.get("/api/conversas", (req, res) => {
  try {
    const data = lerConversas();
    const config = readJson("config.json");
    const bloqueados = new Set((config.numerosBloqueados || []).map(normalizarNumero));
    const lista = Object.values(data.conversas || {})
      .map((c) => ({
        ...c,
        pausado: bloqueados.has(normalizarNumero(c.numero || c.jid)) || bloqueados.has(normalizarNumero(String(c.jid || "").split("@")[0])),
        mensagens: undefined
      }))
      .sort((a, b) => new Date(b.atualizadoEm || 0) - new Date(a.atualizadoEm || 0));
    res.json({ ok: true, estado: estadoAtual, conversas: lista });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/conversas/:jid", (req, res) => {
  try {
    const jid = decodeURIComponent(req.params.jid || "");
    const data = lerConversas();
    const conv = data.conversas[jid];
    if (!conv) return res.status(404).json({ ok: false, error: "Conversa não encontrada." });
    conv.naoLidas = 0;
    salvarConversas(data);

    const config = readJson("config.json");
    const pausado = (config.numerosBloqueados || []).some((n) => {
      const a = normalizarNumero(n);
      const b = normalizarNumero(conv.numero || jid);
      return a && b && (a === b || a.endsWith(b) || b.endsWith(a));
    });

    const memoria = lerMemoria();
    res.json({ ok: true, conversa: { ...conv, pausado }, cliente: memoria.clientes?.[jid] || null });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/conversas/enviar-texto", async (req, res) => {
  try {
    if (!sock) return res.status(400).json({ ok: false, error: "WhatsApp ainda não iniciou." });
    const jid = montarJidWhatsApp(req.body?.jid || req.body?.numero || "");
    const mensagem = String(req.body?.mensagem || "").trim();
    if (!jid) return res.status(400).json({ ok: false, error: "Informe o número/conversa." });
    if (!mensagem) return res.status(400).json({ ok: false, error: "Digite a mensagem." });
    await sock.sendMessage(jid, { text: mensagem });
    registrarMensagemPainel(jid, "enviada", mensagem, "texto");
    res.json({ ok: true, enviadoPara: jid });
  } catch (error) {
    console.error("Erro ao enviar texto pelo painel:", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/conversas/pausar", (req, res) => {
  try {
    const jid = montarJidWhatsApp(req.body?.jid || req.body?.numero || "");
    configurarBloqueioNumero(jid, true);
    atualizarAtendimentoHumano(jid, true);
    res.json({ ok: true, pausado: true, jid });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/conversas/reativar", (req, res) => {
  try {
    const jid = montarJidWhatsApp(req.body?.jid || req.body?.numero || "");
    configurarBloqueioNumero(jid, false);
    atualizarAtendimentoHumano(jid, false);
    res.json({ ok: true, pausado: false, jid });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});


app.delete("/api/conversas/:jid", (req, res) => {
  try {
    const jidInformado = decodeURIComponent(req.params.jid || "");
    const jid = montarJidWhatsApp(jidInformado) || jidInformado;
    if (!jid) return res.status(400).json({ ok: false, error: "Conversa inválida." });

    const data = lerConversas();
    const conversas = data.conversas || {};
    let removidas = 0;

    for (const chave of Object.keys(conversas)) {
      if (chave === jidInformado || chave === jid || jidMesmoContato(chave, jid)) {
        delete conversas[chave];
        removidas++;
      }
    }

    data.conversas = conversas;
    salvarConversas(data);

    res.json({ ok: true, excluida: true, removidas, jid });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/memoria", (_req, res) => {
  res.json(lerMemoria());
});

app.post("/api/memoria/limpar", (req, res) => {
  const numero = req.body?.numero;
  const data = lerMemoria();

  if (!data.clientes) data.clientes = {};

  if (numero && data.clientes[numero]) {
    delete data.clientes[numero];
  } else if (!numero) {
    data.clientes = {};
  }

  fs.writeFileSync(dataPath("memoria.json"), JSON.stringify(data, null, 2), "utf-8");
  res.json({ ok: true });
});


app.post("/api/testar", async (req, res) => {
  try {
    const mensagem = req.body.message || "";
    const resposta = await gerarRespostaComContexto(mensagem, "teste");
    res.json({ ok: true, resposta });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/audio/diagnostico", async (_req, res) => {
  try {
    const config = readJson("config.json");
    const audio = config.audio || {};
    const apiKey = limparCampoSecreto(audio.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY || "");
    const voiceId = limparCampoSecreto(audio.elevenLabsVoiceId || process.env.ELEVENLABS_VOICE_ID || "");

    res.json({
      ok: true,
      provider: audio.provider || "elevenlabs",
      elevenLabsApiKey: mascararChave(apiKey),
      elevenLabsVoiceId: voiceId || "vazio",
      elevenLabsModel: audio.elevenLabsModel || "eleven_multilingual_v2",
      openaiApiKey: mascararChave(audio.openaiApiKey || process.env.OPENAI_API_KEY || ""),
      openaiVoice: audio.openaiVoice || "nova",
      whatsapp: estadoAtual
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/audio/testar-elevenlabs", async (req, res) => {
  try {
    const config = readJson("config.json");
    const audio = config.audio || {};
    const apiKey = limparCampoSecreto(audio.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY || "");
    const voiceId = limparCampoSecreto(audio.elevenLabsVoiceId || process.env.ELEVENLABS_VOICE_ID || "");
    if (!apiKey) return res.status(400).json({ ok: false, error: "API Key da ElevenLabs está vazia." });
    if (!voiceId) return res.status(400).json({ ok: false, error: "Voice ID da ElevenLabs está vazio." });

    // Teste 1: confirma se a chave autentica na ElevenLabs.
    const user = await axios.get("https://api.elevenlabs.io/v1/user/subscription", {
      timeout: 30000,
      headers: { "xi-api-key": apiKey }
    });

    // Teste 2: confirma se a voz existe/acessa na conta ou biblioteca.
    let vozEncontrada = null;
    try {
      const voices = await axios.get("https://api.elevenlabs.io/v1/voices", {
        timeout: 30000,
        headers: { "xi-api-key": apiKey }
      });
      vozEncontrada = (voices.data?.voices || []).find(v => v.voice_id === voiceId) || null;
    } catch {}

    // Teste 3: tenta gerar um áudio pequeno sem enviar no WhatsApp.
    const buffer = await gerarAudioTTS(req.body?.texto || "teste de audio");

    res.json({
      ok: true,
      mensagem: "ElevenLabs autenticou, voz testada e áudio foi gerado.",
      creditos: user.data?.character_count !== undefined ? `${user.data.character_count}/${user.data.character_limit}` : undefined,
      vozEncontradaNoGetVoices: Boolean(vozEncontrada),
      vozNome: vozEncontrada?.name,
      audioBytes: buffer.length
    });
  } catch (error) {
    console.error("Teste ElevenLabs falhou:", detalhesErroApi(error));
    res.status(500).json({ ok: false, error: detalhesErroApi(error) });
  }
});

app.post("/api/enviar-audio", async (req, res) => {
  try {
    if (!sock) return res.status(400).json({ ok: false, error: "WhatsApp ainda não iniciou." });

    const numero = req.body?.numero || req.body?.jid || "";
    const mensagem = req.body?.mensagem || "";
    const jid = montarJidWhatsApp(numero);

    if (!jid) return res.status(400).json({ ok: false, error: "Informe o número com DDD. Ex: 5511999999999" });

    const audioBuffer = await gerarAudioTTS(mensagem);
    const { buffer: audioFinal, waveform, mimetype } = await converterAudioParaPttWhatsApp(audioBuffer);

    await sock.sendPresenceUpdate("recording", jid);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await sock.sendMessage(jid, {
      audio: audioFinal,
      mimetype: mimetype || "audio/ogg; codecs=opus",
      ptt: true,
      waveform: Uint8Array.from(waveform)
    });
    registrarMensagemPainel(jid, "enviada", mensagem, "audio");

    res.json({ ok: true, enviadoPara: jid });
  } catch (error) {
    console.error("Erro ao enviar áudio:", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
  console.log(`Painel rodando na porta ${port}`);
  console.log(`DATA_ROOT: ${DATA_ROOT}`);
  console.log(`AUTH_ROOT: ${AUTH_ROOT}`);
  await iniciarWhatsApp();
});
