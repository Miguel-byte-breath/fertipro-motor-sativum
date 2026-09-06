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
        '(1) si la parcela es de secano o regadío (ver water.dotacionM3 en items, más abajo); ' +
        '(2) si hay cultivo precedente relevante (precedingCrop.crop, resuelto con search_crop ' +
        'igual que currentCrop.crop) y, si lo hay, si hubo laboreo tras su cosecha ' +
        '(precedingCrop.tillageAfterHarvest), qué se hizo con sus residuos ' +
        '(precedingCrop.collectResidues/burnResidues/residuesInFieldPct — si se omiten, no se ' +
        'asume ningún efecto de residuo del cultivo anterior) y su producción esperada ' +
        '(precedingCrop.targetYield — si se omite, se asume el yieldMedium del catálogo, que ' +
        'puede no representar la campaña real del cultivo anterior); (3) la producción ' +
        'esperada del cultivo ACTUAL (currentCrop.targetYield — mismo criterio: si se omite, ' +
        'se asume el yieldMedium del catálogo Sativum en vez del rendimiento real de la ' +
        'parcela); (4) si hay riego, el origen del agua (SIEX: superficial o subterránea — ' +
        'necesario para saber si aplica el rescate ArcGIS de NO3/K de ' +
        'estimate_soil_water_arcgis, exclusivo de origen subterráneo, y para poder ' +
        'documentarlo luego en export_report.riego.fuenteLabel); (5) qué estrategia de ' +
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
              'water.dotacionM3 (m³/ha): si se omite, se usa el valor por defecto del catálogo ' +
              'de cultivo (currentCrop.crop.irrigation). Convención secano/regadío: secano → ' +
              'enviar water.dotacionM3: 0 (anula explícitamente el catálogo, no se calcula ' +
              'aporte por riego); regadío con dotación conocida → enviar water.dotacionM3: ' +
              '<m³/ha>; regadío sin dato conocido → omitir dotacionM3 y dejar el valor por ' +
              'defecto del catálogo. fechaInicioCiclo/fechaFinCiclo (YYYY-MM-DD, opcionales): ' +
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
        '"Recintos (WKT)" saldria vacia.',
      inputSchema: {
        cropUnits: z
          .array(z.record(z.any()))
          .describe('UCs de Visual tal cual las devuelve getCropUnits.'),
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
              'razón social) como identificador de rescate: sin ninguno de los dos, el fichero ' +
              'se nombra "fertipro_plan_abonado_Sativum", sin ningún identificador de titular.',
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
        format: z.literal('xlsx').optional(),
      },
    },
    async (body) => {
      const { npk: npkPlano, warnings: warningsNpk } = normalizarNpkPlano(body.npk)
      const warningsCultivo = validarCultivoCatalogo(body.cultivo)
      const bodyNormalizado = { ...body, npk: npkPlano }
      const r = await invocarHandler(exportReportHandler, bodyNormalizado)
      return resultadoArchivo(r, {
        uri: 'sativum://export-report/plan-abonado.xlsx',
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
