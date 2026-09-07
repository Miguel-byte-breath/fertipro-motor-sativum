/**
 * api/sativum-group.js — :group-crop-units
 *
 * Agrupa Unidades de Cultivo (UCs) de Visual en hojas de cultivo/planes de
 * abonado, sin calcular NPK. NO llama a Visual — recibe en `cropUnits[]`
 * objetos ya obtenidos por el agente vía MCP Visual (getCropUnits con
 * listas:["varieties","persons","sigpac"], includeGeom RECOMENDADO — sin
 * él, cada grupo sale sin recintosWkt/centroid, sin error).
 *
 * Geometría por grupo (Cowork, 4-sep-2026, continuación 9 -- ver memoria de
 * proyecto project_fertipro_mcp_visual_endpoint.md): si las UC llegan con
 * `geom.wkt` (includeGeom:true), cada grupo de salida lleva:
 *   - `recintosWkt`: lista por parcela { ref, superficieHa, wkt }, con la
 *     MISMA forma que espera `export_report.recintosWkt` -- se puede pasar
 *     sin transformar al paso final de la cadena.
 *   - `centroid`: { lon, lat } -- UN SOLO punto representativo de TODO el
 *     grupo (nunca uno por parcela), via centroideDeGrupo(). Pensado para
 *     alimentar una futura tool de resolución de suelo/agua por ArcGIS --
 *     el agente pregunta primero por analítica real; solo si falta, usa
 *     este centroide para consultar ArcGIS (una llamada por grupo, no por
 *     parcela -- cuota compartida de ITACyL).
 * Si ninguna UC del grupo trae geometría, `recintosWkt` sale `[]` y
 * `centroid` sale `null` -- no es un error, solo significa que no se pidió
 * includeGeom o que Visual no la tenía para esas UC.
 *
 * Reutiliza tal cual (sin tocar su lógica) lib/agrupacion/agruparLogica.js +
 * valores.js + centroideGrupo.js, vendorizados de fertipro-test/plantilla
 * (ver CLAUDE.md, sección "Vendoring y diseño de :group-crop-units").
 *
 * NOTA IMPORTANTE (Cowork, 2026-09-01, mismo hilo — sustituye el diseño
 * anterior por idExploitation): NO se particiona por `idExploitation`.
 * Miguel confirmó que muchas UC en Visual no tienen la explotación agrícola
 * asociada/informada (históricamente se asimilaba el productor al titular
 * de explotación) — hasta que ese registro sea obligatorio por SIEX, no se
 * tiene en cuenta. El "plan" (antes 1 por idExploitation) es, de forma
 * PROVISIONAL, 1 por `nif` de titular resuelto — que ya es el primer campo
 * de la partición dura dentro de agruparLogica.js, así que cada grupo que
 * devuelve agruparFilas() ya es homogéneo en nif por construcción; no hace
 * falta partir el lote de entrada antes de llamar a la función (a
 * diferencia de idExploitation, que esa función no conoce). Revisar esta
 * decisión cuando el registro de explotación en Visual sea obligatorio y
 * fiable (y si para entonces getCropUnits expone idExploitation en lote,
 * cosa que hoy no hace).
 *
 * URL definitiva (API STD), ya expuesta vía rewrite en vercel.json:
 *   POST /v1/sativum/crop-units:group-crop-units
 * (el fichero sigue siendo /api/sativum-group.js — routing por fichero de Vercel;
 * ambas rutas responden igual, la de arriba es la pública/canónica)
 */

import { agruparFilas, construirBloques, normalizarTexto, extraerAnio, TOLERANCIA_ANIOS_PLANTACION } from '../lib/agrupacion/agruparLogica.js'
import { modaTexto } from '../lib/agrupacion/valores.js'
import { centroideDeGrupo } from '../lib/agrupacion/centroideGrupo.js'

// ------------------------------------------------------------- envelope §8
function errorEnvelope({ httpStatusInfo, key, message, params = {}, details = [] }) {
  return {
    correlationId: null,
    httpStatusInfo,
    key,
    message,
    formattedMessage: message,
    params,
    details,
  }
}

// --------------------------------------------------- resolución de titular
// Rol "Titular" (id=20, dado de alta recientemente en Visual, sigue el
// estándar SIEX/RD 1051/2022) con rescate a "Productor" (id=1) si no está
// informado. NUNCA "Representante" (id=3) — concepto SIEX distinto, no es
// la identidad de agrupación. Este nif es también, de forma provisional, la
// clave de "plan" de nivel superior (ver nota de cabecera). Ver CLAUDE.md
// para el detalle de verificación contra datos reales (UC demo idFinca=498).
const ID_ROL_TITULAR = 20
const ID_ROL_PRODUCTOR = 1

function nifDeUC(uc) {
  const persons = Array.isArray(uc?.persons) ? uc.persons : []
  const titular = persons.find((p) => p?.idRole === ID_ROL_TITULAR)
  if (titular?.rut) return normalizarTexto(titular.rut)
  const productor = persons.find((p) => p?.idRole === ID_ROL_PRODUCTOR)
  if (productor?.rut) return normalizarTexto(productor.rut)
  return null
}

// -------------------------------------------------- resolución de superficie
// (1) suma de varieties[].superficie ("Sup. especie", fuente primaria ya
//     confirmada). (2) si falta, suma de sigpac[].supOcupada ("Superficie
//     real ocupada del recinto SIGPAC", rescate). (3) si tampoco hay dato,
//     null — la UC queda excluida del totalSurface del grupo con aviso,
//     nunca se usa superficieLic (descartada como fuente, ver CLAUDE.md).
function sumaNumerica(lista, campo) {
  const valores = (Array.isArray(lista) ? lista : [])
    .map((x) => x?.[campo])
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
  return valores.length > 0 ? valores.reduce((s, v) => s + v, 0) : null
}

function superficieDeUC(uc) {
  const especie = sumaNumerica(uc?.varieties, 'superficie')
  if (especie !== null) return especie
  const sigpac = sumaNumerica(uc?.sigpac, 'supOcupada')
  if (sigpac !== null) return sigpac
  return null
}

// ------------------------------------------------------------ mapeo de UC
function primeraVariedad(uc) {
  const varieties = Array.isArray(uc?.varieties) ? uc.varieties : []
  return varieties.length > 0 ? varieties[0] : null
}

/**
 * UC de Visual -> objeto plano que espera agruparLogica.js, más un puñado
 * de campos "__" propios (no los lee agruparLogica.js, sobreviven en
 * g.filas porque agruparFilas() devuelve las mismas referencias de fila)
 * para poder reconstruir la salida del contrato sin volver a tocar la UC
 * original. `variedad`/portainjerto: solo se usa subVariety — patrón
 * (plantations[].patron) queda deliberadamente fuera del veto: además del
 * riesgo de asimetría en blanco ya documentado, Miguel confirma que en la
 * práctica es un campo que a menudo no se cumplimenta (ver CLAUDE.md).
 *
 * sistemaExplotacion (secano/regadío, 7-sep-2026, ver mcp.js/description de
 * group_crop_units): NO se deriva de la dotación de riego -- se resuelve a
 * partir de `uc.idExploitationSystem` tal cual lo trae Visual, con
 * prioridad para `uc.sistemaExplotacionResuelto` ("secano"|"regadio") si el
 * agente lo añadió a mano, porque idExploitationSystem puede faltar o no
 * ser fiable (bug conocido en la propia Visual, confirmado por Miguel) y en
 * ese caso el agente ya le ha preguntado al usuario UC por UC antes de
 * llamar a esta tool. Con prioridad al valor resuelto, la partición dura de
 * agruparLogica.js (que ya compara este campo, sin cambios ahí) deja de
 * depender de un dato de Visual potencialmente ausente.
 */
function ucAFilaPlana(uc, nif) {
  const variedad = primeraVariedad(uc)
  const cultivo = normalizarTexto(variedad?.variety) || null
  const subVariety = normalizarTexto(variedad?.subvariety) || null
  const sistemaExplotacionResuelto =
    uc?.sistemaExplotacionResuelto === 'secano' || uc?.sistemaExplotacionResuelto === 'regadio'
      ? uc.sistemaExplotacionResuelto
      : null
  const sistemaExplotacion =
    sistemaExplotacionResuelto ?? (uc?.idExploitationSystem != null ? String(uc.idExploitationSystem) : null)

  return {
    // --- campos que agruparLogica.js compara/usa ---
    nif,
    cultivoFertipro: cultivo,
    cultivoSativum: cultivo,
    variedad: subVariety,
    cultivoAnteriorFertipro: null,
    cultivoAnteriorSativum: null,
    municipio: normalizarTexto(uc?.municipio) || null,
    sistemaExplotacion,
    sistemaCultivo: normalizarTexto(uc?.cropSystem) || null,
    anioPlantacion: extraerAnio(variedad?.startDate),
    refSuelo: null,
    refAgua: null,
    refEnmienda: null,
    pSuelo: null,
    kSuelo: null,
    materiaOrganica: null,
    texturaFao: null,
    produccionObjetivo: null,
    fechaFin: null,
    ref: uc?.idFinca != null ? String(uc.idFinca) : null,
    // --- campos propios, para construir la salida del contrato ---
    __idFinca: uc?.idFinca ?? null,
    __superficie: superficieDeUC(uc),
    __variety: cultivo,
    __subVariety: subVariety,
    __municipioOut: uc?.municipio ?? null,
    __cropSystemOut: uc?.cropSystem ?? null,
    __sistemaExplotacionOut: sistemaExplotacion,
    __wkt: uc?.geom?.wkt ?? null,
  }
}

// ------------------------------------------- aviso "no se fusiono por que" --
// Solo aplica a grupos de 1 sola UC: si esa UC comparte particion dura con
// otras UC del lote (mismo bloque de construirBloques()) que acabaron en
// grupos distintos, explica por que no se fusionaron -- casi siempre falta
// de fecha de plantacion, la unica senal de fusion que este endpoint puede
// alimentar hoy con datos de Visual (ref de suelo/agua/enmienda siempre
// viaja null aqui, ver ucAFilaPlana). Decision de Miguel (3-sep-2026): la
// particion dura sola NO fusiona -- sigue exigiendose una senal positiva,
// y cuando falta se lo decimos al usuario para que la registre y relance.
function explicarNoFusion(filaActual, otrasFilasDelBloque) {
  const anioActual = extraerAnio(filaActual.anioPlantacion)
  const idFincasOtros = otrasFilasDelBloque.map((f) => f.__idFinca)
  if (anioActual == null) {
    return (
      `Coincide en titular/cultivo/variedad/municipio con la(s) UC ${idFincasOtros.join(', ')} ` +
      `pero no se fusiono: falta la fecha de plantacion de esta UC -- registrala en Visual ` +
      `(modulo Variedad en parcela -> Fecha inicio) y vuelve a lanzar el proceso.`
    )
  }
  const sinFecha = otrasFilasDelBloque.filter((f) => extraerAnio(f.anioPlantacion) == null)
  if (sinFecha.length > 0) {
    return (
      `Coincide en titular/cultivo/variedad/municipio con la(s) UC ${idFincasOtros.join(', ')} ` +
      `pero no se fusiono: falta la fecha de plantacion en la(s) UC ${sinFecha.map((f) => f.__idFinca).join(', ')} ` +
      `-- registrala en Visual (modulo Variedad en parcela -> Fecha inicio) y vuelve a lanzar el proceso.`
    )
  }
  return (
    `Coincide en titular/cultivo/variedad/municipio con la(s) UC ${idFincasOtros.join(', ')} ` +
    `pero no se fusiono: la fecha de plantacion difiere en mas de ${TOLERANCIA_ANIOS_PLANTACION} anos.`
  )
}

// --------------------------------------------------------- salida por grupo
function construirGrupoSalida(g, groupId, otrosDelBloqueSinFusionar = null) {
  const filas = g.filas
  const idFincas = filas.map((f) => f.__idFinca)
  const conSuperficie = filas.filter((f) => f.__superficie !== null)
  const sinSuperficie = filas.filter((f) => f.__superficie === null)
  const totalSurface = conSuperficie.reduce((s, f) => s + f.__superficie, 0)

  const warnings = []
  if (g.aviso) warnings.push(...g.aviso.split(' | ').filter(Boolean))
  if (sinSuperficie.length > 0) {
    warnings.push(
      `${sinSuperficie.length} UC sin superficie de especie ni SIGPAC declarada ` +
        `(idFinca: ${sinSuperficie.map((f) => f.__idFinca).join(', ')}) — excluida del total`,
    )
  }

  if (filas.length === 1 && otrosDelBloqueSinFusionar && otrosDelBloqueSinFusionar.length > 0) {
    warnings.push(explicarNoFusion(filas[0], otrosDelBloqueSinFusionar))
  }

  // Geometria: opcional, solo si el agente pidio includeGeom:true. recintosWkt
  // viaja tal cual a export_report.recintosWkt; centroid es UN SOLO punto por
  // grupo (nunca por parcela), pensado para una futura tool de resolucion de
  // suelo/agua via ArcGIS -- coherente con la cuota compartida de ITACyL.
  const conWkt = filas.filter((f) => f.__wkt)
  const recintosWkt = conWkt.map((f) => ({
    ref: f.__idFinca != null ? `UC ${f.__idFinca}` : null,
    superficieHa: f.__superficie,
    wkt: f.__wkt,
  }))

  let centroid = null
  if (conWkt.length > 0) {
    try {
      const { lon, lat, wktsFallidos } = centroideDeGrupo(
        conWkt.map((f) => ({
          geometriaWkt: f.__wkt,
          ref: f.__idFinca != null ? String(f.__idFinca) : undefined,
        })),
      )
      centroid = { lon, lat }
      if (wktsFallidos.length > 0) {
        warnings.push(
          `${wktsFallidos.length} geometria(s) no se pudo(pudieron) interpretar para el centroide: ` +
            wktsFallidos.map((w) => `${w.ref} (${w.error})`).join('; '),
        )
      }
    } catch (e) {
      warnings.push(`No se pudo calcular el centroide del grupo: ${e.message}`)
    }
  }

  return {
    groupId,
    idFincas,
    totalSurface,
    variety: modaTexto(filas.map((f) => f.__variety)),
    subVariety: modaTexto(filas.map((f) => f.__subVariety)),
    municipio: filas[0].__municipioOut,
    cropSystem: filas[0].__cropSystemOut,
    // Homogéneo por construcción dentro del grupo (partición dura, ver
    // ucAFilaPlana/pasaParticionDura) -- basta con el valor de la primera fila.
    // "secano"|"regadio" si el agente lo resolvió (Visual o pregunta al
    // usuario); si no, el código crudo de idExploitationSystem de Visual, o
    // null si tampoco estaba informado -- nunca se inventa un valor aquí.
    sistemaExplotacion: filas[0].__sistemaExplotacionOut,
    recintosWkt,
    centroid,
    warnings,
  }
}

// -------------------------------------------------------------- handler
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json(
      errorEnvelope({
        httpStatusInfo: '405 METHOD_NOT_ALLOWED',
        key: 'METHOD_NOT_ALLOWED',
        message: 'Método no permitido. Usa POST.',
      }),
    )
  }

  const body = req.body ?? {}
  const cropUnits = Array.isArray(body.cropUnits) ? body.cropUnits : null
  if (!cropUnits) {
    return res.status(400).json(
      errorEnvelope({
        httpStatusInfo: '400 BAD_REQUEST',
        key: 'INVALID_PAYLOAD',
        message: 'Falta "cropUnits" (array) en el body.',
      }),
    )
  }

  const pageIndex = Number.isInteger(body.pageIndex) ? body.pageIndex : 0
  const pageSize = Math.min(Math.max(Number.isInteger(body.pageSize) ? body.pageSize : 20, 1), 100)
  if (pageIndex < 0) {
    return res.status(400).json(
      errorEnvelope({
        httpStatusInfo: '400 BAD_REQUEST',
        key: 'INVALID_PAYLOAD',
        message: '"pageIndex" debe ser >= 0.',
      }),
    )
  }

  // Cada UC necesita un titular resoluble (nif) para poder agruparse — sin
  // nif, dos UCs "sin titular" compararían igual (blank === blank en
  // agruparLogica.js) y se fusionarían por error, así que se excluyen en
  // vez de dejarlas pasar con un nif en blanco. Ya NO se exige
  // idExploitation (ver nota de cabecera del fichero): no particionamos por
  // explotación mientras ese registro no sea obligatorio/fiable en Visual.
  const excluidas = []
  const filas = []
  for (const uc of cropUnits) {
    const nif = nifDeUC(uc)
    if (!nif) {
      excluidas.push({ idFinca: uc?.idFinca ?? null, motivos: ['sin titular resoluble (rol Titular ni Productor)'] })
      continue
    }
    filas.push(ucAFilaPlana(uc, nif))
  }

  if (excluidas.length > 0 && filas.length === 0) {
    return res.status(422).json(
      errorEnvelope({
        httpStatusInfo: '422 UNPROCESSABLE_ENTITY',
        key: 'NO_PROCESSABLE_CROP_UNITS',
        message: 'Ninguna UC del lote es agrupable (falta titular resoluble en todas).',
        details: excluidas,
      }),
    )
  }

  // Una única llamada a agruparFilas() sobre todo el lote: nif ya es el
  // primer campo de la partición dura interna, así que cada grupo devuelto
  // es homogéneo en nif por construcción (no hace falta partir antes).
  const indiceDeFila = new Map(filas.map((f, i) => [f, i]))
  const bloqueDeIndice = new Map()
  for (const bloque of construirBloques(filas)) {
    for (const idx of bloque) bloqueDeIndice.set(idx, bloque)
  }

  const gruposCrudos = agruparFilas(filas)
  const gruposPorNif = new Map()
  for (const g of gruposCrudos) {
    const nifGrupo = g.filas[0]?.nif ?? null
    if (!gruposPorNif.has(nifGrupo)) gruposPorNif.set(nifGrupo, [])
    gruposPorNif.get(nifGrupo).push(g)
  }

  const resultadoCompleto = [...gruposPorNif.entries()].map(([nifTitular, grupos]) => {
    const groups = grupos.map((g, i) => {
      let otrosDelBloqueSinFusionar = null
      if (g.filas.length === 1) {
        const idx = indiceDeFila.get(g.filas[0])
        const bloque = idx != null ? bloqueDeIndice.get(idx) : null
        if (bloque && bloque.length > 1) {
          otrosDelBloqueSinFusionar = bloque.filter((i) => i !== idx).map((i) => filas[i])
        }
      }
      return construirGrupoSalida(g, `group-${i + 1}`, otrosDelBloqueSinFusionar)
    })
    return { nifTitular, groupCount: groups.length, groups }
  })

  const count = resultadoCompleto.length
  const start = pageIndex * pageSize
  const result = resultadoCompleto.slice(start, start + pageSize)

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({
    pageIndex,
    pageSize,
    count,
    result,
    ...(excluidas.length > 0
      ? {
          warnings: [
            `${excluidas.length} UC excluida(s) del agrupamiento: ` +
              excluidas.map((e) => `idFinca ${e.idFinca ?? '(sin idFinca)'} (${e.motivos.join('; ')})`).join(', '),
          ],
        }
      : {}),
  })
}
