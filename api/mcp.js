/**
 * api/mcp.js — Servidor MCP ligero de Sativum
 *
 * Expone como "tools" de MCP la misma lógica de negocio que ya sirven los
 * tres endpoints HTTP :calculate-npk, :group-crop-units y :export-report —
 * SIN tocar ni duplicar esos ficheros. Cada tool invoca internamente al
 * handler correspondiente simulando una petición POST en memoria (mismo
 * req.body de entrada, misma respuesta res.status().json()/.send() de
 * salida que ya usa Vercel) — así el contrato de cada endpoint, ya cerrado
 * y probado en producción, no cambia ni se reimplementa. Cero riesgo sobre
 * ese código.
 *
 * Transporte: Streamable HTTP en modo *stateless* (sessionIdGenerator:
 * undefined) — necesario porque Vercel serverless no mantiene un proceso
 * persistente entre peticiones (stdio no es viable aquí). Se crea una
 * instancia nueva de McpServer + transporte en cada petición: patrón
 * recomendado por el propio SDK para despliegues stateless/serverless (ver
 * ejemplo oficial "simpleStatelessStreamableHttp" del paquete).
 *
 * URL: /api/mcp (ruta automática de Vercel para este fichero) — no sigue
 * el patrón ADR-0012 de "custom method" porque no es una acción REST, es
 * un único punto de entrada que habla JSON-RPC (protocolo MCP).
 *
 * Autenticación: NINGUNA por ahora (2-sep-2026, decisión explícita de
 * Miguel) — igual que los tres endpoints que envuelve. Si en el futuro
 * hace falta cerrarlo, puede hacerse SOLO aquí (comprobando p.ej. una
 * cabecera antes de crear el transporte, al principio del handler de más
 * abajo) sin afectar a la web pública ni a los tres endpoints HTTP, que
 * seguirían abiertos (requisito ITACyL de herramienta pública) — este
 * fichero es independiente de esas rutas.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

import calculateNpkHandler from './sativum-plan.js'
import groupCropUnitsHandler from './sativum-group.js'
import exportReportHandler from './sativum-report.js'
import estimateSoilWaterArcgisHandler from './sativum-arcgis-npk.js'
import searchCropHandler from './sativum-crops-search.js'
import { sanitizarNombreFichero } from '../src/utils/slugify.js'

// ---------------------------------------------------------------------
// invocarHandler: llama a un handler de Vercel (req, res) => void con un
// body dado, simulando una petición POST en memoria, y devuelve lo que ese
// handler hubiera respondido — sin pasar por red y sin tocar su fichero.
// ---------------------------------------------------------------------
function invocarHandler(handler, body) {
  return new Promise((resolve, reject) => {
    let resuelto = false
    const req = { method: 'POST', body }
    const res = {
      _status: 200,
      setHeader() {}, // los headers HTTP no aplican dentro del MCP
      status(code) {
        this._status = code
        return this
      },
      json(data) {
        if (!resuelto) {
          resuelto = true
          resolve({ status: this._status, json: data })
        }
      },
      send(data) {
        if (!resuelto) {
          resuelto = true
          resolve({ status: this._status, buffer: data })
        }
      },
    }
    Promise.resolve(handler(req, res)).catch((err) => {
      if (!resuelto) {
        resuelto = true
        reject(err)
      }
    })
  })
}

// Traduce la respuesta ya capturada del handler a contenido de tool MCP.
// Si el handler respondió con error (4xx/5xx), se marca isError con el
// mismo envelope §8 que vería un cliente HTTP normal — nada nuevo.
function resultadoJson({ status, json }) {
  return {
    isError: status >= 400,
    content: [{ type: 'text', text: JSON.stringify(json, null, 2) }],
  }
}

// Igual que resultadoJson, pero para el caso binario de :export-report: si
// hay error va como texto (envelope §8); si hay éxito, el buffer se envía
// como bloque `resource` en base64 (spec MCP), tal como estaba diseñado.
// warnings (opcional): avisos de validación defensiva (ver normalizarNpkPlano/
// validarCultivoCatalogo más abajo) -- si hay alguno, se añade ANTES del bloque
// resource como bloque de texto propio, nunca en silencio.
function resultadoArchivo({ status, json, buffer }, { uri, mimeType, warnings = [] }) {
  if (status >= 400) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(json, null, 2) }],
    }
  }
  const content = []
  if (warnings.length > 0) {
    content.push({
      type: 'text',
      text: `Avisos de export_report (revisar antes de dar el Excel por bueno):\n- ${warnings.join('\n- ')}`,
    })
  }
  content.push({
    type: 'resource',
    resource: { uri, mimeType, blob: buffer.toString('base64') },
  })
  return { content }
}

// ---------------------------------------------------------------------
// Validación defensiva de export_report (5-sep-2026, tras el test real de
// Miguel -- ver memoria de proyecto project_fertipro_mcp_visual_endpoint.md,
// seccion HALLAZGO). La description de la tool ya pide pasar npk en forma
// plana {n,p,k}, pero calculate_npk devuelve, por elemento, un objeto
// {gross, waterCredit, net} -- si un agente no sigue la instruccion al pie
// de la letra, el Excel salia con las "Necesidades brutas" a 0 en silencio.
// Aqui se normaliza en el propio codigo (defensa en profundidad), en vez de
// depender solo de la description -- y siempre avisando, nunca corrigiendo
// sin decirlo.
// ---------------------------------------------------------------------
function normalizarNpkPlano(npk) {
  if (!npk || typeof npk !== 'object') return { npk, warnings: [] }
  const warnings = []
  const out = { ...npk }
  for (const elemento of ['n', 'p', 'k']) {
    const valor = npk[elemento]
    if (valor && typeof valor === 'object' && 'gross' in valor) {
      out[elemento] = valor.gross
      warnings.push(
        `npk.${elemento} llego como objeto {gross,waterCredit,net} (formato de calculate_npk) -- se uso .gross (${valor.gross}) automaticamente.`,
      )
    }
  }
  return { npk: out, warnings }
}

// No hay forma honesta de "reconstruir" aqui el objeto de catalogo Sativum
// si llega uno equivocado (ej. un resumen de Visual con nombre/municipio/
// variedad) -- eso requeriria volver a llamar a search_crop. Nos limitamos
// a avisar, nunca a corregir en silencio ni a bloquear la exportacion (esas
// celdas ya salen vacias en el Excel, esto solo hace visible el porque).
function validarCultivoCatalogo(cultivo) {
  if (!cultivo || typeof cultivo !== 'object') return []
  if (cultivo.id == null || cultivo.name == null) {
    return [
      'cultivo no parece el objeto de catalogo Sativum de search_crop (faltan id/name) -- ' +
        'es probable que las filas "Cultivo"/"Cultivo ID Sativum" del Excel salgan vacias y ' +
        'que el reimport en la web no pueda autoseleccionar el cultivo.',
    ]
  }
  return []
}

// Nombre de fichero real para el recurso que devuelve export_report -- hasta
// ahora (6-sep-2026, hallazgo de Miguel) el `uri` del bloque `resource` era
// un literal fijo ('plan-abonado.xlsx'), así que el nombre calculado en
// api/sativum-report.js::calcularBaseName() (NIF/nombreRazonSocial + nombrePlan)
// nunca llegaba a un cliente MCP -- solo se veía vía el endpoint HTTP directo
// (Content-Disposition), que el MCP no usa. Misma fórmula que calcularBaseName(),
// replicada aquí (no importada de sativum-report.js) para no acoplar este
// fichero a uno que ya tiene su propio contrato HTTP cerrado -- reutiliza
// sanitizarNombreFichero de src/utils/slugify.js, la misma que ya usan tanto
// calcular.js (fertipro-test/plantilla) como la propia web de producción.
//
// espaciosAGuionBajo (6-sep-2026, 2º hallazgo): sanitizarNombreFichero() NO
// toca espacios (a propósito, para que los ficheros de `salidas/` en
// plantilla/la descarga de la web se vean "bonitos" con el nombre tal cual,
// ej. "PARTIDA DEL AMET SAT"). Pero aquí el resultado va embebido en la
// `uri` de un recurso MCP, y un espacio crudo no es válido dentro de una URI
// (RFC 3986) -- posible causa de que el cliente MCP no respetara el nombre
// calculado (Miguel probó y el NIF/titular apareció al final, no al
// principio como se construye aquí). Se sustituyen los espacios por guión
// bajo SOLO en este punto, nunca en calcularBaseName()/sanitizarNombreFichero
// (que siguen igual para la web y para plantilla).
function espaciosAGuionBajo(s) {
  return s.replace(/\s+/g, '_')
}

function calcularNombreArchivoMcp({ titular, nombrePlan } = {}) {
  const plan = (nombrePlan ?? '').trim()
  const identificadorTitular =
    titular?.nifCif?.trim() || titular?.nombreRazonSocial?.trim() || null
  const base = plan
    ? (identificadorTitular
        ? `${sanitizarNombreFichero(identificadorTitular)}_${sanitizarNombreFichero(plan)}`
        : sanitizarNombreFichero(plan))
    : 'fertipro_plan_abonado'
  return espaciosAGuionBajo(`${base}_Sativum`)
}

// ---------------------------------------------------------------------
// Definición del servidor MCP y sus 3 tools. Los inputSchema son
// deliberadamente permisivos (z.record(z.any()) en los objetos anidados):
// la validación de negocio de verdad ya vive en cada handler (BLOCKED por
// item, envelope §8, etc.) — el schema aquí solo documenta la forma
// esperada para el agente, no duplica esa validación.
// ---------------------------------------------------------------------
function crearServidor() {
  const server = new McpServer({ name: 'fertipro-sativum', version: '1.0.0' })

  // ---- calculate_npk — misma entrada/salida que POST :calculate-npk ----
  server.registerTool(
    'calculate_npk',
    {
      title: 'Calcular NPK (Sativum)',
      description:
        'Calcula el balance de N/P/K (elemental -- NUNCA óxidos P2O5/K2O, aunque el nombre ' +
        'de la tool diga "NPK" -- bruto y neto de riego) para un lote de unidades de ' +
        'cultivo, vía el motor ITACyL/Sativum. Cada item del lote devuelve su propio ' +
        'status ("OK" o "BLOCKED") con warnings — no hace falta que todos los items estén ' +
        'completos para poder calcular los demás. Antes de calcular, pregunta SIEMPRE: ' +
        '(1) si la UC es de secano o regadío -- esto NO se pregunta aquí de nuevo si el plan ya ' +
        'pasó por group_crop_units: reutiliza el sistemaExplotacion que ese grupo ya resolvió. ' +
        'Solo pregúntalo aquí si esta UC nunca pasó por group_crop_units (plan de una sola UC). ' +
        'Si es regadío (por group_crop_units o por esta pregunta), pregunta SIEMPRE ADEMÁS, como ' +
        'paso propio y separado, por la dotación de riego (water.dotacionM3, m³/ha) -- ese dato ' +
        'no está en Visual, así que nunca se asume: "0" es una respuesta válida (regadío sin ' +
        'agua real que aportar ahora mismo), pero omitir la pregunta y dejar que se aplique el ' +
        'valor del catálogo en silencio NO lo es (ver convención completa en water.dotacionM3 ' +
        'del schema, más abajo); ' +
        '(2) si hay cultivo precedente relevante. OJO con los cultivos leñosos/permanentes ' +
        '(currentCrop.crop.plantSpeciesGroup === "TREES" u otro perenne): el motor SÍ aplica ' +
        'precedingCrop igual que a cualquier otro cultivo si se lo pasas -- no lo descartes tú ' +
        'por tu cuenta asumiendo que "un leñoso no tiene precedente". NO preguntes si la ' +
        'plantación es nueva o ya establecida -- esa distinción no cambia nada en el cálculo y ' +
        'solo confunde al usuario (validado con Miguel, 6-sep-2026: "arrancado para replantar" ' +
        'resultó una pregunta rara). En vez de eso, para un leñoso pregunta directamente si hubo ' +
        'alguna gestión de residuos de la operación anterior en esa parcela (poda, o el arranque ' +
        'de una plantación previa -- normalmente del MISMO cultivo que currentCrop.crop, así que ' +
        'NO hace falta resolverlo de nuevo con search_crop: reutiliza literalmente el mismo ' +
        'objeto en precedingCrop.crop) y, si los hay, su incorporación ' +
        '(precedingCrop.collectResidues/burnResidues) y el laboreo tras esa operación ' +
        '(precedingCrop.tillageAfterHarvest). Para cultivos NO leñosos (rotación anual real, ' +
        'ej. patata tras lechuga), sigue preguntando también por precedingCrop.crop (resuelto ' +
        'con search_crop igual que currentCrop.crop), pues ahí sí suele ser un cultivo distinto. ' +
        'Si hay residuos incorporados (collectResidues=true), pregunta ADEMÁS si quiere el % por ' +
        'defecto del catálogo Sativum para ese cultivo (omitir residuesInFieldPct, el motor lo ' +
        'aplica solo) o prefiere indicar un valor concreto 1-100 en residuesInFieldPct -- si se ' +
        'omite todo esto sin preguntar, no se asume ningún efecto de residuo del cultivo ' +
        'anterior. También su producción esperada ' +
        '(precedingCrop.targetYield — si se omite, se asume el yieldMedium del catálogo, que ' +
        'puede no representar la campaña real del cultivo anterior); (3) la producción ' +
        'esperada del cultivo ACTUAL (currentCrop.targetYield — mismo criterio: si se omite, ' +
        'se asume el yieldMedium del catálogo Sativum en vez del rendimiento real de la ' +
        'parcela); (4) si hay riego, el origen del agua (SIEX: superficial o subterránea — ' +
        'necesario para documentarlo luego en export_report.riego.fuenteLabel) Y, SIEMPRE, ' +
        'pregunta por el agua de riego con un tono sencillo y sin intimidar -- NO la plantees ' +
        'como "¿tienes analítica de agua?" (suena a que hay que adjuntar un informe de ' +
        'laboratorio completo). Pregunta algo como: "¿tienes algún dato de NO3, P o K de tu ' +
        'agua de riego? Aunque sea solo uno de ellos, o un valor aproximado, es suficiente -- ' +
        'guarda tú la analítica como anexo en tu propio expediente/documentación del plan, no ' +
        'hace falta que me la entregues ahora". Pide los tres valores por separado ' +
        '(water.no3MgL/pMgL/kMgL, mg/L) y deja claro que si falta alguno, simplemente no se ' +
        'tiene en cuenta ese elemento, sin bloquear el cálculo de los demás -- esto aplica en ' +
        'CUALQUIER origen, superficial o subterráneo, no solo cuando hay rescate ArcGIS: no lo ' +
        'des por sabido solo porque ya preguntaste el origen. El rescate ArcGIS de ' +
        'estimate_soil_water_arcgis (arcgisNo3MgL/arcgisKMgL) es exclusivo de origen ' +
        'subterráneo y NUNCA sustituye la pregunta por datos reales -- pregúntala primero, ' +
        'igual que con el suelo, y usa ArcGIS solo si falta el dato y el origen lo permite; ' +
        '(5) qué estrategia de ' +
        'fertilización quiere (strategy: SUFFICIENCY|REDUCED|MAINTENANCE|MAXIMUM) — pregunta ' +
        'esto ANTES de pedir analítica de suelo, no al revés: si la estrategia elegida ' +
        'necesita analítica real y el usuario no la tiene, dilo con honestidad explícita ' +
        '(p.ej. "con los datos que tienes solo puedo aplicar mantenimiento, ¿lo confirmas?") ' +
        'en vez de sustituir MAINTENANCE en silencio; (6) fecha de inicio y fin del ciclo de ' +
        'cultivo actual (YYYY-MM-DD). Esta tool NO las usa para el cálculo NPK en sí -- pero ' +
        'hay que preguntarlas y conservarlas AHORA (no esperar a export_report) para poder ' +
        'pasarlas luego en export_report.fechaInicioCiclo/fechaFinCiclo, de donde la app en ' +
        'producción deriva el año 0/1/2 de la tasa de mineralización de enmiendas orgánicas ' +
        '(estiércol/purín) al reimportar el plan -- sin este dato, esa lógica ya existente en ' +
        'la app no se puede aplicar bien. No asumir ninguno de estos 6 valores sin preguntar.',
      inputSchema: {
        items: z
          .array(z.record(z.any()))
          .describe(
            'Lote de unidades a calcular. Cada item: { currentCrop:{crop,targetYield?,cv?,...}, ' +
              'precedingCrop?, soil:{soilType,cec,pOlsen|arcgisPOlsen,kSoil|arcgisKSoil,...}, ' +
              'water?, strategy?, advancedOverrides? } — mismo contrato que ' +
              'POST /v1/sativum/fertilization-plans:calculate-npk. ' +
              'water.dotacionM3 (m³/ha): NO tiene un valor por defecto seguro -- la dotación no ' +
              'es un dato de Visual, así que este campo se rellena SIEMPRE a partir de lo que ' +
              'diga el usuario, nunca del catálogo Sativum en silencio (currentCrop.crop.' +
              'irrigation es solo orientativo si el usuario lo pide explícitamente). Convención ' +
              'secano/regadío (el sistema en sí ya viene resuelto de group_crop_units o de la ' +
              'pregunta (1) de arriba): secano → enviar water.dotacionM3: 0 siempre (no se ' +
              'calcula aporte por riego); regadío → pregunta la dotación y envíala en ' +
              'water.dotacionM3 -- si el usuario no la sabe, envía water.dotacionM3: 0 de forma ' +
              'explícita (regadío sin agua real que aportar ahora mismo es una situación válida), ' +
              'pero nunca omitas el campo dejando que se aplique el valor del catálogo sin que el ' +
              'usuario lo haya confirmado. fechaInicioCiclo/fechaFinCiclo (YYYY-MM-DD, opcionales): ' +
              'esta tool las ignora por completo para el cálculo -- inclúyelas aquí solo como ' +
              'conveniencia de registro si ya las preguntaste; lo que de verdad hace falta es ' +
              'reenviarlas después en export_report.fechaInicioCiclo/fechaFinCiclo (ver la ' +
              'description de esa tool).',
          ),
        pageIndex: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ items, pageIndex, pageSize }) => {
      const r = await invocarHandler(calculateNpkHandler, { items, pageIndex, pageSize })
      return resultadoJson(r)
    },
  )

  // ---- group_crop_units — misma entrada/salida que POST :group-crop-units ----
  server.registerTool(
    'group_crop_units',
    {
      title: 'Agrupar unidades de cultivo (Sativum)',
      description:
        'Agrupa Unidades de Cultivo de Visual (obtenidas antes con getCropUnits, listas ' +
        '["varieties","persons","sigpac"]) en planes de abonado por titular — sin calcular ' +
        'NPK. No llama a Visual: recibe las UC ya leídas por el agente. IMPORTANTE: al llamar ' +
        'a getCropUnits, pasa SIEMPRE includeGeom:true ademas de esas listas -- sin geometria, ' +
        'cada grupo devuelto sale con recintosWkt:[] y centroid:null (sin ningun error visible), ' +
        'y esto se propaga en silencio hasta el Excel final de export_report, cuya hoja ' +
        '"Recintos (WKT)" saldria vacia. SECANO/REGADÍO como partición dura: antes de llamar a ' +
        'esta tool, para cada UC decide si es secano o regadío -- primero mirando ' +
        'idExploitationSystem tal cual lo trae Visual; si ese campo viene vacío, o no te fías de ' +
        'él (hay un bug conocido de Visual en este campo -- confirmado por Miguel, sep-2026: la ' +
        'propia app de producción puede fallar al grabarlo), pregunta al usuario UC por UC ' +
        '("¿esta parcela es de secano o de regadío?", nunca en bloque con otras preguntas) y, en ' +
        'ese caso, añade en el objeto de esa UC el campo sistemaExplotacionResuelto: ' +
        '"secano"|"regadio" con la respuesta -- NUNCA inventes ni copies un código numérico de ' +
        'Visual que no te haya dado él. sistemaExplotacionResuelto, si está presente, tiene ' +
        'prioridad sobre idExploitationSystem tanto para la partición dura (nunca se fusionan UC ' +
        'de distinto sistema) como para el campo sistemaExplotacion que devuelve cada grupo. ' +
        'Esto es independiente de la dotación de riego (m³/ha), que no forma parte de los datos ' +
        'de Visual y se pregunta más adelante, en calculate_npk, solo para las UC/grupos ya ' +
        'resueltos como regadío.',
      inputSchema: {
        cropUnits: z
          .array(z.record(z.any()))
          .describe(
            'UCs de Visual tal cual las devuelve getCropUnits, opcionalmente con ' +
              'sistemaExplotacionResuelto: "secano"|"regadio" añadido por ti en cada UC donde ' +
              'idExploitationSystem no esté informado o no sea fiable (ver descripción de la ' +
              'tool) -- ese campo no lo pone Visual, lo añades tú tras preguntar al usuario.',
          ),
        pageIndex: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ cropUnits, pageIndex, pageSize }) => {
      const r = await invocarHandler(groupCropUnitsHandler, { cropUnits, pageIndex, pageSize })
      return resultadoJson(r)
    },
  )

  // ---- estimate_soil_water_arcgis — rescate ArcGIS de suelo/agua (ITACyL) ----
  server.registerTool(
    'estimate_soil_water_arcgis',
    {
      title: 'Estimar suelo/agua vía ArcGIS (Sativum)',
      description:
        'Rescate de suelo/agua vía ArcGIS (ITACyL) para un punto -- normalmente el `centroid` ' +
        'que devuelve group_crop_units. USAR SOLO COMO RESCATE: pregunta siempre primero por ' +
        'analítica real (pOlsen, kSoil, organicMatter, ph, soilType, no3MgL/kMgL de agua si el ' +
        'origen es subterráneo) y llama a esta tool únicamente si falta algún dato. Devuelve un ' +
        'bloque `arcgisFields` ya con los nombres exactos que espera calculate_npk ' +
        '(soil.arcgisPOlsen/arcgisKSoil/arcgisOrganicMatter/arcgisPh, water.arcgisNo3MgL/arcgisKMgL) ' +
        '-- cópialos tal cual, calculate_npk ya decide solo si aplicarlos (p.ej. el rescate de agua ' +
        'solo se usa si water.sourceType es SUBTERRANEA). OJO: `soilType` NO tiene equivalente ' +
        '`arcgis*` en calculate_npk -- si no hay soilType manual, asigna el valor devuelto aquí ' +
        'directamente en soil.soilType. Si ArcGIS no clasifica el punto, los campos llegan `null` ' +
        'con un warning explicativo -- nunca se inventa un valor. IMPORTANTE para el Excel ' +
        'final: guarda soilType/soilTypeUsdaLabel/organicMatter/ph/pOlsen/kSoil de esta ' +
        'respuesta -- export_report.suelo espera ese mismo objeto (filas "Textura suelo"/' +
        '"Textura USDA"/etc. del Excel, hoy en blanco si no se reenvía).',
      inputSchema: {
        lon: z.number().describe('Longitud WGS84 (EPSG:4326) del punto a consultar.'),
        lat: z.number().describe('Latitud WGS84 (EPSG:4326) del punto a consultar.'),
        tolerance: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Tolerancia en píxeles del identify ArcGIS (por defecto 10, igual que en producción). Rara vez hace falta tocarlo.'),
      },
    },
    async ({ lon, lat, tolerance }) => {
      const r = await invocarHandler(estimateSoilWaterArcgisHandler, { lon, lat, tolerance })
      return resultadoJson(r)
    },
  )

  // ---- search_crop — misma entrada/salida que GET /api/sativum-crops (filtros en body) ----
  server.registerTool(
    'search_crop',
    {
      title: 'Buscar cultivo en el catálogo (Sativum)',
      description:
        'Busca en el catálogo de cultivos Sativum (parámetros agronómicos: HI, concentraciones ' +
        'N/P/K en órganos cosechados, f_res, nfix_code, irrigation, etc.) y devuelve el objeto ' +
        'completo del cultivo, TAL CUAL lo espera calculate_npk en currentCrop.crop / ' +
        'precedingCrop.crop -- no hace falta que el usuario pegue el JSON del catálogo a mano. ' +
        'Usa name (recomendado, ej. "Naranjo") para acotar: si se omiten name y group a la vez, ' +
        'devuelve el catálogo completo (150+ cultivos). Si un cultivo no aparece (ej. mandarino), ' +
        'significa que Sativum no lo tiene en catálogo -- no es un fallo de la tool. ' +
        'ORDEN RECOMENDADO: llamar después de group_crop_units, usando el nombre de variety/' +
        'cropSystem que esa tool ya confirmó como realmente plantado -- no asumir el nombre tal ' +
        'cual lo dijo el usuario en la conversación, puede no coincidir con el catálogo real. ' +
        'AMBIGÜEDAD: el cruce con el catálogo de Visual se hace por texto, sin id estable -- es ' +
        'frecuente que una búsqueda devuelva varias variantes del mismo cultivo por rendimiento ' +
        'objetivo (ej. "Patata - Rto. inferior a 45.000 kg/ha" vs "...superior..."). Si hay más de ' +
        'un resultado, NUNCA elegir uno por cuenta propia: comparar targetYield (si se conoce) ' +
        'contra el umbral que lleva cada name, y si no es concluyente, preguntar al asesor cuál ' +
        'aplica.',
      inputSchema: {
        name: z.string().optional().describe('Nombre del cultivo, coincidencia parcial case-insensitive (ej. "naranjo").'),
        group: z.string().optional().describe('plantSpeciesGroup, coincidencia parcial case-insensitive (ej. "Cereals").'),
      },
    },
    async ({ name, group }) => {
      const r = await invocarHandler(searchCropHandler, { name, group })
      return resultadoJson(r)
    },
  )

  // ---- export_report — misma entrada que POST :export-report, salida en bloque resource ----
  server.registerTool(
    'export_report',
    {
      title: 'Exportar plan de abonado (Sativum)',
      description:
        'Genera el Excel del plan de abonado (mismo fichero que "Exportar Excel" en la web, ' +
        'reimportable en producción) y lo devuelve como recurso adjunto en base64. Campos ' +
        'obligatorios: cultivo y npk — mismo contrato que POST ' +
        '/v1/sativum/fertilization-plans:export-report. Ojo: riego usa una forma propia, ' +
        'distinta de water en calculate_npk — no reutilizar el mismo objeto entre ambos tools.',
      inputSchema: {
        cultivo: z
          .record(z.any())
          .describe(
            'Cultivo del plan (obligatorio). DEBE ser literalmente el mismo objeto de catálogo ' +
              'Sativum que devolvió search_crop y que ya usaste en currentCrop.crop de ' +
              'calculate_npk (con name/id/plantSpeciesGroup/yieldMedium/nfixCode/cv/irrigation) ' +
              '-- NUNCA construyas aquí un objeto-resumen nuevo con datos de Visual ' +
              '(municipio/nombre/variedad/superficie); esos datos van en otros campos ' +
              '(recintosWkt, nombrePlan), no en cultivo. Si no reutilizas el objeto real, las ' +
              'filas "Cultivo"/"Cultivo ID Sativum"/etc. del Excel salen vacías y el reimport en ' +
              'la web no puede autoseleccionar el cultivo.',
          ),
        cultivoAnterior: z
          .record(z.any())
          .optional()
          .describe(
            'Cultivo precedente (opcional). Mismo objeto de catálogo Sativum que ' +
              'precedingCrop.crop en calculate_npk, si lo hubo. Sin este campo, el bloque ' +
              'completo "Cultivo precedente" del Excel no aparece (ni siquiera el nombre).',
          ),
        cultivoAnteriorParams: z
          .record(z.any())
          .optional()
          .describe(
            '{ cropYield?, laboreo?, recogeResiduos?, quemaResiduos?, fRes? } del cultivo ' +
              'precedente -- traducidos de precedingCrop.targetYield/tillageAfterHarvest/' +
              'collectResidues/burnResidues/residuesInFieldPct que ya usaste en calculate_npk. ' +
              'Sin este campo, aunque envíes cultivoAnterior, las filas "Rendimiento ' +
              'precedente"/"Laboreo tras cosecha"/"Residuos precedente"/"F_res precedente" del ' +
              'Excel salen en blanco.',
          ),
        calculo: z
          .record(z.any())
          .optional()
          .describe(
            '{ strategy?, cropYield?, recogeResiduos?, quemaResiduos? } del cultivo ACTUAL -- ' +
              'mismos valores que ya usaste en calculate_npk (strategy, currentCrop.targetYield, ' +
              'currentCrop.collectResidues/burnResidues). Sin este campo, "Estrategia"/' +
              '"Rendimiento objetivo" (si difiere del catálogo)/"Residuos recogidos" del Excel ' +
              'no reflejan lo que realmente se calculó.',
          ),
        npk: z
          .record(z.any())
          .describe(
            'Balance NPK del plan (obligatorio) -- forma PLANA de números: { n, p, k } (kg ' +
              'elemento/ha, brutos). OJO: NO es la forma que devuelve calculate_npk -- esa tool ' +
              'devuelve, por item, npk.n/npk.p/npk.k como OBJETOS { gross, waterCredit, net }. ' +
              'Aquí hay que extraer el campo .gross de cada uno y pasarlo como número plano: ' +
              '{ n: resultado.npk.n.gross, p: resultado.npk.p.gross, k: resultado.npk.k.gross }. ' +
              'Si se pasa el objeto completo en vez del número, el Excel sale con las ' +
              '"Necesidades brutas" a 0.',
          ),
        suelo: z
          .record(z.any())
          .optional()
          .describe(
            'Datos de suelo para las filas informativas del Excel (Textura suelo/Textura USDA/' +
              'Materia orgánica/pH/P Olsen/K suelo) -- NO recalcula nada, solo documenta. Reutiliza ' +
              'literalmente el objeto que ya tenías (de tu analítica real, o de ' +
              'estimate_soil_water_arcgis: soilType/soilTypeUsdaLabel/organicMatter/ph/pOlsen/kSoil) -- ' +
              'si no lo reenvías, esas filas salen en blanco. OJO: cec y soilEffect NO van aquí dentro, ' +
              'son campos propios de nivel superior (ver más abajo).',
          ),
        cec: z
          .number()
          .optional()
          .describe(
            'CEC (meq/kg) realmente usado en el cálculo -- campo propio, NO dentro de suelo. ' +
              'Cógelo de resolvedSoil.cec en la respuesta de calculate_npk (ya viene resuelto: ' +
              'analítica real, o tabla por textura si no la había). Sin este dato, la fila "CEC" ' +
              'del Excel sale en blanco.',
          ),
        soilEffect: z
          .number()
          .optional()
          .describe(
            'Coeficiente soil_effect (== densidad aparente, misma magnitud según la OAS de Sativum) ' +
              'realmente usado en el cálculo -- campo propio, NO dentro de suelo. Cógelo de ' +
              'resolvedSoil.soilEffect en la respuesta de calculate_npk. Opcional: si se omite, la ' +
              'fila "Densidad aparente" del Excel simplemente no aparece.',
          ),
        riego: z
          .record(z.any())
          .optional()
          .describe(
            '{ sistemaExplotacion: "regadio"|"secano", dotacionM3?, no3MgL?, pMgL?, kMgL?, ' +
              'fuenteLabel?, fuenteId? } — sistemaExplotacion determina la línea "Sistema de ' +
              'explotación" del Excel y si se muestran los kg/ha cubiertos por riego (solo si ' +
              'es "regadio" y dotacionM3 > 0). fuenteLabel (texto libre, ej. "Superficial (río, ' +
              'canal, embalse)" o "Subterránea") o fuenteId (código SIEX) rellenan "Origen del ' +
              'agua (SIEX)" -- sin ninguno de los dos, sale "Sin especificar" aunque el usuario ' +
              'sí haya dicho su origen. Si usaste el rescate ArcGIS de ' +
              'estimate_soil_water_arcgis (arcgisNo3MgL/arcgisKMgL, solo válido con origen ' +
              'subterráneo), pasa aquí el valor ya resuelto en no3MgL/kMgL, no el original ' +
              'vacío. No es el mismo objeto que water en calculate_npk: hay que traducirlo ' +
              'explícitamente al encadenar los dos tools.',
          ),
        titular: z
          .record(z.any())
          .optional()
          .describe(
            '{ tipo?: "fisica"|"juridica", nombreRazonSocial?, nifCif? } -- rellena el bloque ' +
              '"Titular de la explotación" del Excel y el nombre del fichero de salida. NIF/CIF ' +
              'es preferente, pero Visual (getCropUnits/readCropUnit) no siempre lo expone -- ' +
              'cuando falte, envía SIEMPRE nombreRazonSocial (nombre de la persona física o ' +
              'razón social) como identificador de rescate. Si NO tienes ni NIF/CIF ni ' +
              'nombreRazonSocial (ninguno de los dos, ni en Visual ni dicho por el usuario), NO ' +
              'llames a export_report todavía: pregunta primero al usuario por al menos uno de ' +
              'los dos. Sin esa pregunta, el fichero se nombraría en silencio ' +
              '"fertipro_plan_abonado_Sativum", sin ningún identificador de titular -- justo lo ' +
              'que hay que evitar.',
          ),
        nombrePlan: z
          .string()
          .optional()
          .describe(
            'Nombre del plan de abonado. Convención recomendada (misma que usa el repo local ' +
              '`plantilla` para lotes agrupados, ver agrupar.js/calcularNombrePlan()): ' +
              '"AAAA-MUNICIPIO-CULTIVO-NN" (ej. "2026-TITAGUAS-ALMENDRO-01"). AAAA = año de ' +
              'fechaFinCiclo (no el año actual); MUNICIPIO = el de la unidad de cultivo ' +
              '(Visual), en mayúsculas; CULTIVO = nombre corto del cultivo actual; NN = ' +
              'correlativo de 2 dígitos, "01" por defecto -- súbelo solo si en esta misma ' +
              'conversación generas más de un plan para el mismo municipio+cultivo (para no ' +
              'repetir nombre). A diferencia de `plantilla` (que calcula NN agrupando filas de ' +
              'un lote), aquí cada export_report es siempre un único plan -- llevar la cuenta ' +
              'de NN, si hace falta, es responsabilidad tuya dentro de la conversación. Si se ' +
              'omite, el fichero queda sin nombre de plan propio.',
          ),
        fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido, debe ser YYYY-MM-DD (ISO).').optional().describe('Fecha del plan (YYYY-MM-DD, ISO estricto). Si se omite, se usa la fecha actual.'),
        fechaInicioCiclo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido, debe ser YYYY-MM-DD (ISO).').optional().describe('Inicio del ciclo de cultivo (YYYY-MM-DD, ISO estricto).'),
        fechaFinCiclo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido, debe ser YYYY-MM-DD (ISO).').optional().describe('Fin del ciclo de cultivo (YYYY-MM-DD, ISO estricto).'),
        recintosWkt: z
          .array(z.object({
            ref: z.string(),
            fichero: z.string().optional(),
            fila: z.number().optional(),
            superficieHa: z.number(),
            wkt: z.string(),
          }))
          .optional()
          .describe(
            'Geometría WKT, una entrada por recinto (nunca fusionada) — rellena la hoja ' +
              'opcional "Recintos (WKT)", necesaria para reimportar el plan en producción con ' +
              'la geometría exacta (ver importExcel.js: sin esta hoja, el usuario tiene que ' +
              'volver a cargar la parcela en el mapa a mano).',
          ),
        unidadesCultivo: z
          .array(z.object({
            idFinca: z.union([z.string(), z.number()]).optional(),
            superficieHa: z.number().optional(),
            variedad: z.string().optional(),
            municipio: z.string().optional(),
            sistemaExplotacion: z.string().optional(),
          }))
          .optional()
          .describe(
            'Trazabilidad: una entrada por Unidad de Cultivo (UC) de Visual vinculada a este ' +
              'plan -- rellena la hoja opcional "Unidades de Cultivo" del Excel, para que el ' +
              'fichero sea autocontenido (qué UC(s) de Visual respaldan este balance, sin tener ' +
              'que volver a consultar Visual). Si el plan viene de group_crop_units, usa su ' +
              'respuesta: idFincas (uno por elemento del array -> una entrada aquí por cada ' +
              'idFinca), y repite en cada entrada los campos compartidos del grupo (variety -> ' +
              'variedad, municipio, sistemaExplotacion -> sistemaExplotacion -- OJO: NO uses ' +
              'cropSystem aquí, es un concepto distinto -- invernadero/aire libre/sustrato SIEX, ' +
              'no secano/regadío); superficieHa por UC solo ' +
              'si la tienes desagregada (ej. desde recintosWkt del propio grupo, cruzando por ' +
              '"UC ${idFinca}"), si no, déjala vacía -- no repartas totalSurface a ojo entre las ' +
              'UC. Si el plan es de una sola UC (sin pasar por group_crop_units), basta una ' +
              'entrada con su idFinca. Si se omite, no se crea esta hoja (compatible con planes ' +
              'anteriores).',
          ),
        format: z.literal('xlsx').optional(),
      },
    },
    async (body) => {
      const { npk: npkPlano, warnings: warningsNpk } = normalizarNpkPlano(body.npk)
      const warningsCultivo = validarCultivoCatalogo(body.cultivo)
      const bodyNormalizado = { ...body, npk: npkPlano }
      const r = await invocarHandler(exportReportHandler, bodyNormalizado)
      const nombreArchivo = calcularNombreArchivoMcp(body)
      return resultadoArchivo(r, {
        uri: `sativum://export-report/${nombreArchivo}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        warnings: [...warningsCultivo, ...warningsNpk],
      })
    },
  )

  return server
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Método no permitido. El MCP solo acepta POST.' },
      id: null,
    })
    return
  }

  try {
    const server = crearServidor()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close()
      server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Error interno del servidor MCP.' },
        id: null,
      })
    }
  }
}
