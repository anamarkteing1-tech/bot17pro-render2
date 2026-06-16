import axios from "axios";
import fs from "fs";

const DATA_ROOT = process.env.DATA_DIR || "./data";

function dataPath(f){
  return `${DATA_ROOT}/${f}`;
}

function read(f){
  return JSON.parse(fs.readFileSync(dataPath(f), "utf-8"));
}

function lerMemoriaCliente(numero){
  try {
    const data = JSON.parse(fs.readFileSync(dataPath("memoria.json"), "utf-8"));
    return data.clientes?.[numero] || {};
  } catch {
    return {};
  }
}

function detectarIntencaoCompra(msg) {
  const texto = (msg || "").toLowerCase();
  return [
    "quero comprar",
    "quero fechar",
    "como paga",
    "como pago",
    "manda o pix",
    "manda pix",
    "qual o pix",
    "chave pix",
    "vou comprar",
    "quero esse",
    "quero o vip",
    "quero pack",
    "como faz pra comprar",
    "como comprar"
  ].some(termo => texto.includes(termo));
}

function detectarSaudacao(msg) {
  const texto = (msg || "").trim().toLowerCase();
  return [
    "oi", "oii", "oiii", "olá", "ola", "eai", "e aí", "hey", "opa", "bom dia", "boa tarde", "boa noite"
  ].includes(texto);
}

function historicoTexto(memoria) {
  const historico = Array.isArray(memoria.historico) ? memoria.historico.slice(-18) : [];

  if (!historico.length) {
    return "Sem histórico anterior.";
  }

  return historico
    .map((item) => {
      const papel = item.role === "assistant" ? "Atendente" : "Cliente";
      return `${papel}: ${item.content}`;
    })
    .join("\n");
}

function montarPersonaTexto(persona = {}) {
  return `
NOME: ${persona.nome || "não informado"}
IDADE: ${persona.idade || "não informado"}
JEITO/HUMOR: ${persona.jeito || "natural, educada e direta"}
COMO FALA: ${persona.fala || "frases curtas, simples, sem parecer robô"}
DESCRIÇÃO: ${persona.descricao || "atendente feminina, realista e objetiva"}
`.trim();
}

function limparResposta(texto = "") {
  let resposta = String(texto || "").trim();

  // Remove excesso de emojis e deixa a conversa mais realista.
  resposta = resposta.replace(/[😈😉💋🔥😘🥰😍❤️💖💕]+/g, "");

  // Remove espaços exagerados.
  resposta = resposta.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  // Limita respostas muito longas. Mantém o WhatsApp mais natural.
  const linhas = resposta.split("\n").map(l => l.trim()).filter(Boolean);
  if (linhas.length > 3) resposta = linhas.slice(0, 3).join("\n");

  if (resposta.length > 260) {
    resposta = resposta.slice(0, 260).trim();
    const ultimoPonto = Math.max(resposta.lastIndexOf("."), resposta.lastIndexOf("!"), resposta.lastIndexOf("?"));
    if (ultimoPonto > 80) resposta = resposta.slice(0, ultimoPonto + 1);
  }

  return resposta || "me fala melhor o que você procura";
}

export async function gerarRespostaComContexto(msg, numero){
  const memoria = lerMemoriaCliente(numero);
  const produtos = read("produtos.json");
  const config = read("config.json");

  const lista = produtos.map(p =>
    `${p.nome} - ${p.preco} (${p.descricao || ""})`
  ).join("\n");

  const pix = config.pix || "não informado";
  const persona = config.persona || {};
  const personaTexto = montarPersonaTexto(persona);
  const etapa = memoria.etapa || "frio";
  const interesse = memoria.interesse || "";
  const nome = memoria.nome || "";
  const cidade = memoria.cidade || "";
  const produtoInteresse = memoria.produtoInteresse || "";
  const objecao = memoria.objecao || "";
  const estiloCliente = memoria.estiloCliente || "";
  const resumo = memoria.resumo || "";
  const aprendizados = Array.isArray(memoria.aprendizados) ? memoria.aprendizados.slice(-10) : [];
  const totalMensagens = Number(memoria.totalMensagens || 0);
  const historico = historicoTexto(memoria);
  const jaConversou = Array.isArray(memoria.historico) && memoria.historico.length > 0;

  // Fechamento automático mais curto e realista.
  if (detectarIntencaoCompra(msg)) {
    const jaMandouPix = Array.isArray(memoria.historico) && memoria.historico.some((m) =>
      m.role === "assistant" && String(m.content || "").includes(pix)
    );

    if (jaMandouPix) {
      return limparResposta(`já mandei o pix ali em cima\n\n${pix}\n\nme manda o comprovante quando fizer`);
    }

    return limparResposta(`fechado\n\no pix é esse: ${pix}\n\nme manda o comprovante depois`);
  }

  // Primeira resposta configurável pelo painel.
  // Se o contato ainda não tem histórico, o bot envia exatamente a mensagem salva no painel.
  if (!jaConversou && config.mensagemPrimeiraResposta) {
    return limparResposta(config.mensagemPrimeiraResposta);
  }

  // Segurança: caso a mensagem inicial esteja vazia, mantém uma abertura curta.
  if (detectarSaudacao(msg) && !jaConversou) {
    const aberturaNome = nome ? `oi ${nome}` : "oi";
    return limparResposta(`${aberturaNome}\n\nme fala o que você queria ver`);
  }

  const prompt = `
Você está respondendo no WhatsApp como uma atendente mulher real.

PERSONA DO PAINEL:
${personaTexto}

REGRAS FIXAS:
- responda sempre em português do Brasil
- nunca diga que é IA, robô, assistente virtual ou sistema automático
- responda no feminino quando falar de você
- não invente produto, preço, desconto ou promessa
- não envie conteúdo grátis

ESTILO DA RESPOSTA:
- resposta curta, natural e direta
- no máximo 2 ou 3 linhas
- sem textão
- sem muitos emojis; de preferência nenhum
- linguagem simples de WhatsApp
- não pareça propaganda
- não repita a tabela completa se já apareceu no histórico
- não comece toda resposta com "oi amor" ou frases repetidas
- varie as palavras; não use sempre a mesma estrutura
- responda como conversa real, sem cara de script
- se o cliente mandar mensagem curta, responda curto também

COMPORTAMENTO:
- responda só o que o cliente perguntou
- conduza com naturalidade para escolher um produto
- se o cliente estiver pronto para pagar, mande o pix direto
- se já explicou algo antes, responda só complementando
- mantenha continuidade da conversa pelo histórico

PRODUTOS:
${lista}

PIX:
${pix}

MEMÓRIA DO CLIENTE:
${JSON.stringify({
  nome,
  cidade,
  etapa,
  interesse,
  produtoInteresse,
  objecao,
  estiloCliente,
  resumo,
  aprendizados,
  totalMensagens,
  pediuPix: memoria.pediuPix || false,
  ultimaMensagem: memoria.ultimaMensagem || null,
  ultimaResposta: memoria.ultimaResposta || null
}, null, 2)}

COMO USAR A MEMÓRIA:
- Se souber o nome, pode usar às vezes, mas não em toda mensagem
- Se já souber o interesse, continue do ponto certo sem perguntar tudo de novo
- Se o cliente já pediu preço/pix, não enrole
- Se ele demonstrou objeção, responda essa objeção com naturalidade
- Não repita a mesma abertura nem a mesma frase várias vezes
- Escreva como pessoa que lembra da conversa anterior

HISTÓRICO DA CONVERSA:
${historico}

MENSAGEM ATUAL DO CLIENTE:
${msg}

Responda agora apenas com a mensagem final para enviar ao cliente.
`;

  const groqApiKey = String(config.groqApiKey || process.env.GROQ_API_KEY || "").trim();
  if (!groqApiKey) {
    throw new Error("GROQ_API_KEY não configurada. Coloque a chave da Groq no painel ou nas variáveis do Render.");
  }

  const r = await axios.post(
    "https://api.groq.com/openai/v1/responses",
    {
      model: config.groqModel || "openai/gpt-oss-20b",
      input: prompt
    },
    {
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        "Content-Type": "application/json"
      }
    }
  );

  const output = r.data.output || [];
  const textos = [];

  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const parte of item.content) {
        if (parte.type === "output_text" && parte.text) {
          textos.push(parte.text);
        }
      }
    }
  }

  return limparResposta(textos.join("\n").trim());
}
