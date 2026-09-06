/**
 * src/utils/exportExcel.js
 *
 * Genera y descarga un Excel con la composición SIGPAC de una o varias
 * parcelas (hoja de cultivo). Dos hojas:
 *
 *   "Resumen"  — una fila por parcela
 *     Parcela · Tipo · Sup. parcela (ha) · Sup. SIGPAC (ha) · % cubierto · Nº recintos
 *
 *   "Recintos" — una fila por par parcela × recinto
 *     Parcela · Provincia · Municipio · Polígono · Parcela SIGPAC · Recinto ·
 *     Ref. completa · Uso SIGPAC · Sup. recinto (ha) · Sup. intersección (ha) ·
 *     % recinto ocupado · Pendiente (%) · Altitud (m) · Observación
 *
 * La librería SheetJS (`xlsx`) se importa dinámicamente para que no infle
 * el bundle inicial de la app — solo se descarga cuando el usuario hace clic
 * en "Exportar Excel".
 */
import area from '@turf/area'
import { MEDIDAS_MITIGACION_GEI } from '../data/sativum/medidasMitigacionGEI.js'
import { aniosTranscurridos } from './npkUtils.js'

/**
 * Descarga el Excel.
 *
 * @param {Array<{
 *   nombre: string,
 *   tipo: 'SIGPAC' | 'SIGPAC modificada' | 'Libre',
 *   feature: GeoJSON.Feature,
 *   recintos: Array<object>,   // salida de interseccionRecintos()
 * }>} parcelas
 * @param {string} baseName  — nombre del fichero sin extensión.
 */
export async function exportarRecintosSigpacExcel(parcelas, baseName = 'fertipro_sigpac') {
  const mod   = await import('xlsx')
  const XLSX  = mod.default ?? mod

  // ── Hoja "Resumen" ────────────────────────────────────────────────────
  const resumen = parcelas.map(p => {
    const supParcelaHa = p.feature ? area(p.feature) / 10000 : null
    const supSigpacHa  = p.recintos.reduce(
      (s, r) => s + (Number(r.superficie_interseccion_ha) || 0), 0
    )
    const pctCubierto = supParcelaHa && supParcelaHa > 0
      ? (supSigpacHa / supParcelaHa) * 100
      : null
    return {
      'Parcela':            p.nombre,
      'Tipo':               p.tipo,
      'Sup. parcela (ha)':  num(supParcelaHa, 4),
      'Sup. SIGPAC (ha)':   num(supSigpacHa, 4),
      '% cubierto':         num(pctCubierto, 1),
      'Nº recintos':        p.recintos.length,
    }
  })

  // ── Hoja "Recintos" ───────────────────────────────────────────────────
  const recintos = []
  for (const p of parcelas) {
    for (const r of p.recintos) {
      const ref = [r.provincia, r.municipio, r.poligono, r.parcela, r.recinto]
        .filter(v => v != null && v !== '')
        .join('/')
      recintos.push({
        'Parcela':                p.nombre,
        'Provincia':              r.provincia ?? null,
        'Municipio':              r.municipio ?? null,
        'Polígono':               r.poligono  ?? null,
        'Parcela SIGPAC':         r.parcela   ?? null,
        'Recinto':                r.recinto   ?? null,
        'Ref. completa':          ref || null,
        'Uso SIGPAC':             r.uso_sigpac ?? null,
        'Coef. regadío (%)':      r.coef_regadio ?? null,
        'Sup. recinto (ha)':      num(r.superficie_total_ha, 4),
        'Sup. intersección (ha)': num(r.superficie_interseccion_ha, 4),
        '% recinto ocupado':      num(r.pct_ocupado, 1),
        'Pendiente (%)':          num(r.pendiente_media, 2),
        'Altitud (m)':            num(r.altitud, 0),
        'Observación':            r.observacion,
        'ZVN':                    r.enZvn === true ? 'S' : (r.enZvn === false ? 'N' : null),
      })
    }
  }

  const wb = XLSX.utils.book_new()

  const wsResumen = XLSX.utils.json_to_sheet(resumen)
  wsResumen['!cols'] = [
    { wch: 24 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 12 },
  ]
  XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen')

  const wsRecintos = XLSX.utils.json_to_sheet(recintos)
  wsRecintos['!cols'] = [
    { wch: 24 }, // Parcela
    { wch:  9 }, // Provincia
    { wch: 11 }, // Municipio
    { wch:  9 }, // Polígono
    { wch: 14 }, // Parcela SIGPAC
    { wch:  9 }, // Recinto
    { wch: 20 }, // Ref. completa
    { wch: 11 }, // Uso SIGPAC
    { wch: 18 }, // Coef. regadío
    { wch: 18 }, // Sup. recinto
    { wch: 22 }, // Sup. intersección
    { wch: 17 }, // % recinto ocupado
    { wch: 14 }, // Pendiente
    { wch: 12 }, // Altitud
    { wch: 14 }, // Observación
    { wch:  6 }, // ZVN
  ]
  XLSX.utils.book_append_sheet(wb, wsRecintos, 'Recintos')

  // Hoja "Notas" — pequeña hoja con metadatos del informe (opcional pero útil)
  const notas = [
    { 'Campo': 'Fichero generado',  'Valor': baseName + '.xlsx' },
    { 'Campo': 'Fecha',             'Valor': new Date().toISOString() },
    { 'Campo': 'Origen geometría',  'Valor': 'FertiPRO — definida por el usuario' },
    { 'Campo': 'Fuente recintos',   'Valor': 'SIGPAC (FEGA) · OGC API · CC BY 4.0' },
    { 'Campo': 'CRS',               'Valor': 'EPSG:4326 (WGS84)' },
    { 'Campo': 'Cálculo intersección', 'Valor': 'Cliente — @turf/intersect v7' },
    { 'Campo': 'Umbral "Completo"',        'Valor': '≥ 99,5 % del recinto ocupado por la parcela' },
    { 'Campo': 'Etiqueta "Recortado"',     'Valor': 'El usuario ha modificado la geometría de la parcela (tijera o edición de vértices)' },
    { 'Campo': 'Etiqueta "Parcial"',       'Valor': 'Parcela libre que intersecta una porción del recinto sin intervención del usuario' },
    { 'Campo': 'Columna ZVN',              'Valor': 'S = recinto intersecta una Zona Vulnerable a Nitratos (RD 47/2022) · N = no intersecta · vacío = no consultado' },
    { 'Campo': 'Fuente ZVN',               'Valor': 'SIGPAC (FEGA) — servicio intersection/nitratos' },
  ]
  const wsNotas = XLSX.utils.json_to_sheet(notas)
  wsNotas['!cols'] = [{ wch: 22 }, { wch: 60 }]
  XLSX.utils.book_append_sheet(wb, wsNotas, 'Notas')

  XLSX.writeFile(wb, `${baseName}.xlsx`)
}

/** Redondea preservando null/NaN para que Excel no escriba "0" donde no toca. */
function num(v, dec = 2) {
  if (v == null || isNaN(v)) return null
  return Number(Number(v).toFixed(dec))
}

/**
 * Calcula N/P2O5/K2O efectivos (mineralización este ciclo) para un item.
 * Devuelve pct=null si el item no es orgánico (efN === bruto).
 */
function calcEfectivoExcel(item, fechaInicioCiclo) {
  const dose    = Number(item.cantidad) || 0
  const brutoN    = (item.n    ?? 0) * dose / 100
  const brutoP2o5 = (item.p2o5 ?? 0) * dose / 100
  const brutoK2o  = (item.k2o  ?? 0) * dose / 100
  if (!item.appliesAnnualEffectiveness || !item.fechaAplicacion || !fechaInicioCiclo) {
    return { pct: null, efN: null, efP2o5: null, efK2o: null }
  }
  const delta = aniosTranscurridos(item.fechaAplicacion, fechaInicioCiclo)
  const pct   = item[`yearPercent${delta}`] ?? 100
  return {
    pct,
    efN:    num(brutoN    * pct / 100, 1),
    efP2o5: num(brutoP2o5 * pct / 100, 1),
    efK2o:  num(brutoK2o  * pct / 100, 1),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan de Abonado completo
// ─────────────────────────────────────────────────────────────────────────────

// Etiquetas legibles para tipo de suelo (textura simplificada Sativum)
const SOIL_TYPE_LABEL = {
  SANDY:      'Arenosa',
  SANDY_LOAM: 'Franco arenosa',
  LOAM:       'Franca',
  SILTY_LOAM: 'Franco limosa',
  CLAY_LOAM:  'Franco arcillosa',
  CLAY:       'Arcillosa',
}

/**
 * Descarga el plan de abonado completo en Excel (3 hojas).
 *
 * @param {object} opts
 * @param {object}  opts.point                — { lon, lat }
 * @param {object}  [opts.recinto]            — recinto "primario" SIGPAC (Municipio/Uso)
 * @param {Array}   [opts.recintos]           — array completo de interseccionRecintos(); la superficie
 *   total se suma sobre TODOS estos recintos, no solo sobre `recinto` (antes solo se usaba el primero)
 * @param {object}  opts.cultivo              — objeto catálogo Sativum
 * @param {object}  [opts.suelo]             — resultado normalizarSuelo()
 * @param {number}  opts.cec                  — meq/kg
 * @param {number}  [opts.soilEffect]         — coeficiente soil_effect/densidad aparente (mismo valor, ver OAS Sativum)
 * @param {object}  opts.riego               — { fuenteId, fuenteLabel, no3MgL, dotacionM3 }
 * @param {object}  opts.calculo             — { strategy, cropYield, recogeResiduos, quemaResiduos }
 * @param {string}  [opts.fecha]             — fecha del plan (YYYY-MM-DD)
 * @param {object}  opts.npk                  — respuesta bruta /algo/
 * @param {object}  [opts.recomendacion]     — respuesta /recommendation (array)
 * @param {string}  [opts.adjustedNutrient]  — 'N' | 'P' | 'K'
 * @param {object}  [opts.cultivoAnterior]   — objeto cultivo precedente
 * @param {object}  [opts.cultivoAnteriorParams] — { cropYield, laboreo, recogeResiduos, quemaResiduos }
 * @param {Array}   [opts.unidadesCultivo]   — [{ idFinca, superficieHa, variedad, municipio,
 *   sistemaExplotacion }], una fila por Unidad de Cultivo (Visual) vinculada a este plan — hoja
 *   opcional "Unidades de Cultivo", cambio aditivo
 * @param {string}  [opts.baseName]
 */
export async function construirWorkbookPlanAbonado({
  point,
  recinto,
  recintos = [],
  cultivo,
  suelo,
  cec,
  soilEffect,
  riego,
  calculo,
  fecha,
  fechaInicioCiclo = null,
  fechaFinCiclo    = null,
  npk,
  recomendacion,           // ignorado en la nueva arquitectura (planItems reemplaza)
  adjustedNutrient = null,
  cultivoAnterior = null,
  cultivoAnteriorParams = null,
  nombrePlan = null,
  titular = null,
  asesor = null,
  analisisPropio = false,
  refAnalisisSuelo = '',
  fertilizadoresManuales = [],  // alias legacy — usar planItems si se pasa
  planItems = null,             // nuevo: array unificado con origen:'sativum'|'manual'
  medidasGEI = [],              // códigos SIEX seleccionados (Anexo V RD 1051/2022)
  recintosWkt = [],             // [{ ref, fichero, fila, superficieHa, wkt }], uno por recinto (nunca
                                 // geometría fusionada) — hoja opcional "Recintos (WKT)", cambio aditivo
  unidadesCultivo = [],          // [{ idFinca, superficieHa, variedad, municipio, sistemaExplotacion }],
                                 // una fila por Unidad de Cultivo (Visual) vinculada a este plan — hoja
                                 // opcional "Unidades de Cultivo", cambio aditivo (6-sep-2026, ver
                                 // project memory)
  baseName = 'fertipro_plan_abonado',
}) {
  // Compatibilidad: planItems tiene prioridad sobre fertilizadoresManuales
  const allItems = planItems ?? fertilizadoresManuales
  const mod  = await import('xlsx')
  const XLSX = mod.default ?? mod

  const P_TO_P2O5 = 2.2914
  const K_TO_K2O  = 1.2046

  // NPK: top-level con fallback al último item de recommendations (cultivo actual)
  const lastRec = npk?.recommendations?.at(-1)
  const nVal = npk?.n ?? lastRec?.n
  const pVal = npk?.p ?? lastRec?.p
  const kVal = npk?.k ?? lastRec?.k
  const n = num(nVal, 1)
  const p = num(pVal, 1)
  const k = num(kVal, 1)

  // Aportaciones por riego (kg elemento/ha)
  const no3 = Number(riego?.no3MgL)    || 0
  const dot = Number(riego?.dotacionM3) || 0
  const p_r = Number(riego?.pMgL)      || 0
  const k_r = Number(riego?.kMgL)      || 0
  const tieneRiego = riego?.sistemaExplotacion === 'regadio' && dot > 0

  const nRiegoVal = tieneRiego && no3 > 0 ? no3 * dot / 1000 * (14 / 62) : 0
  const nRiego    = nRiegoVal > 0 ? num(nRiegoVal, 1) : null
  // nVal ya es el N bruto (independiente del riego, ver sativum-algo.js) — no se suma nRiego aquí
  const nBruto    = num(nVal ?? 0, 1)
  const pRiego  = tieneRiego && p_r > 0 ? p_r * dot / 1000 : 0   // kg P/ha
  const kRiego  = tieneRiego && k_r > 0 ? k_r * dot / 1000 : 0   // kg K/ha

  // NPK neto = bruto - riego (floor 0)
  const nNeto = Math.max(0, (nVal ?? 0) - nRiegoVal)
  const pNeto = Math.max(0, (pVal ?? 0) - pRiego)
  const kNeto = Math.max(0, (kVal ?? 0) - kRiego)

  // ── Hoja 1: Plan de Abonado ─────────────────────────────────────────────
  const plan = []
  const row = (campo, valor, unidad = '') => plan.push({ 'Campo': campo, 'Valor': valor ?? '—', 'Unidad': unidad })

  row('Fecha', fecha
    ? new Date(fecha + 'T00:00:00').toLocaleDateString('es-ES')
    : new Date().toLocaleDateString('es-ES'))
  if (fechaInicioCiclo) row('Inicio de ciclo', new Date(fechaInicioCiclo + 'T00:00:00').toLocaleDateString('es-ES'))
  if (fechaFinCiclo)    row('Fin de ciclo',    new Date(fechaFinCiclo    + 'T00:00:00').toLocaleDateString('es-ES'))
  if (nombrePlan) row('Nombre del plan de abonado / balance de nutrientes', nombrePlan)
  if (titular?.nombreRazonSocial || titular?.nifCif) {
    const tipoTitularLabel = titular.tipo === 'juridica' ? 'Persona jurídica' : 'Persona física'
    row('Titular de la explotación', titular.nombreRazonSocial || null)
    row('Tipo titular', tipoTitularLabel)
    if (titular.nifCif) row(titular.tipo === 'juridica' ? 'CIF titular' : 'NIF titular', titular.nifCif)
  }
  if (asesor?.nombre || asesor?.regfer) {
    if (asesor.nombre)    row('Nombre asesor',    asesor.nombre)
    if (asesor.apellidos) row('Apellidos asesor', asesor.apellidos)
    if (asesor.regfer)    row('Nº REGFER', asesor.regfer)
    if (asesor.nif)       row('NIF asesor', asesor.nif)
    if (asesor.telefono)  row('Teléfono asesor', asesor.telefono)
    if (asesor.email)     row('Email asesor', asesor.email)
  }
  row('Longitud', num(point?.lon, 5), '°')
  row('Latitud',  num(point?.lat, 5), '°')
  const listaRecintos = recintos.length ? recintos : (recinto ? [recinto] : [])
  if (listaRecintos.length) {
    const supTotal = listaRecintos.reduce(
      (s, r) => s + (Number(r.superficie_interseccion_ha ?? r.superficie_total_ha ?? r.superficie_ha) || 0), 0
    )
    row('Municipio SIGPAC', recinto?.municipio ?? listaRecintos[0]?.municipio ?? null)
    row('Uso SIGPAC',       recinto?.uso_sigpac ?? listaRecintos[0]?.uso_sigpac ?? null)
    if (listaRecintos.length > 1) row('Nº recintos SIGPAC', listaRecintos.length)
    row('Superficie total (ha)', num(supTotal, 4), 'ha')
  }

  row('', null)  // spacer

  row('Cultivo',                    cultivo?.name)
  row('Cultivo ID Sativum',        cultivo?.id ?? null)
  row('Cultivo plantSpeciesGroup', cultivo?.plantSpeciesGroup ?? null)   // para reimport sin API
  row('Cultivo yieldMedium',       num(cultivo?.yieldMedium, 2))
  row('Cultivo nfixCode',          cultivo?.nfixCode != null ? String(Number(cultivo.nfixCode)) : null)
  row('Cultivo cv',                num(cultivo?.cv, 4))
  row('Cultivo irrigation',        num(cultivo?.irrigation, 0))
  row('Grupo',                     cultivo?.plantSpeciesGroup)
  row('Rendimiento objetivo',  num(calculo?.cropYield ?? cultivo?.yieldMedium, 2), 'kg/ha')
  const ESTRATEGIA_LABEL = {
    SUFFICIENCY: 'Estrategia de suficiencia (mínimo fertilizante)',
    REDUCED:     'Acumulación y mantenimiento (abono reducido)',
    MAINTENANCE: 'Mantenimiento (análisis de suelo no disponible)',
    MAXIMUM:     'Acumulación y mantenimiento (máximo rendimiento)',
  }
  row('Estrategia ID',         calculo?.strategy)                                       // ID crudo para import robusto
  row('Estrategia',            ESTRATEGIA_LABEL[calculo?.strategy] ?? calculo?.strategy)
  // NOTA: no hay fila "Laboreo" para el cultivo actual — el único "tillage" que
  // viaja al payload de /fertilicalc/algo/ es un flag global de la llamada
  // (strategy.tillage en sativum-algo.js), y se alimenta de
  // cultivoAnteriorParams.laboreo ("Laboreo tras cosecha" del cultivo anterior,
  // ver fila más abajo) — nunca de un campo propio del cultivo actual. Ver
  // CLAUDE.md, sesión 2026-07-27, para el detalle de por qué se retiró.
  row('Residuos recogidos',    calculo?.recogeResiduos   ? 'Sí' : 'No')
  if (calculo?.recogeResiduos) {
    row('Quema residuos',      calculo?.quemaResiduos    ? 'Sí' : 'No')
  }
  if (adjustedNutrient) {
    row('Nutriente ajustado',  adjustedNutrient)
  }

  row('', null)

  // Cultivo anterior
  if (cultivoAnterior) {
    row('Cultivo precedente',                    cultivoAnterior.name)
    row('Cultivo precedente ID',                 cultivoAnterior?.id ?? null)    // para reimport
    row('Cultivo precedente plantSpeciesGroup',  cultivoAnterior?.plantSpeciesGroup ?? null)
    row('Cultivo precedente yieldMedium',        num(cultivoAnterior?.yieldMedium, 2))
    row('Cultivo precedente nfixCode',           cultivoAnterior?.nfixCode != null ? String(Number(cultivoAnterior.nfixCode)) : null)
    row('Cultivo precedente cv',                 num(cultivoAnterior?.cv, 4))
    row('  Rendimiento precedente',   num(cultivoAnteriorParams?.cropYield ?? cultivoAnterior.yieldMedium, 2), 'kg/ha')
    row('  Laboreo tras cosecha',     cultivoAnteriorParams?.laboreo        ? 'Sí' : 'No')
    row('  Residuos precedente',      cultivoAnteriorParams?.recogeResiduos ? 'Recogidos' : 'Incorporados')
    // Quema: solo para cereales; independiente de si se recogen o no
    if (cultivoAnterior?.plantSpeciesGroup?.toUpperCase() === 'CEREALS') {
      row('  Quema residuos precedente', cultivoAnteriorParams?.quemaResiduos ? 'Sí' : 'No')
    }
    // f_res: valor efectivo (override usuario si lo hay, si no B7 / default catálogo)
    const isCerealPrec  = cultivoAnterior?.plantSpeciesGroup?.toUpperCase() === 'CEREALS'
    const recogePrec    = cultivoAnteriorParams?.recogeResiduos ?? false
    const autoFResPrec  = (isCerealPrec && cultivoAnterior?.fres === 10 && !recogePrec) ? 100 : (cultivoAnterior?.fres ?? 100)
    const efectiveFResPrec = (cultivoAnteriorParams?.fRes !== null && cultivoAnteriorParams?.fRes !== undefined)
      ? cultivoAnteriorParams.fRes
      : autoFResPrec
    row('  F_res precedente',          efectiveFResPrec, '%')
    row('', null)
  }

  const soilLabel = suelo?.soilType
    ? `${SOIL_TYPE_LABEL[suelo.soilType] ?? suelo.soilType} (${suelo.soilType})`
    : null
  if (analisisPropio) row('Fuente datos suelo', 'Laboratorio propio')
  if (refAnalisisSuelo) row('Ref. boletín análisis suelo', refAnalisisSuelo)
  row('Textura suelo',      soilLabel)
  row('Textura USDA',       suelo?.soilTypeUsdaLabel ?? null)
  row('Materia orgánica',   num(suelo?.organicMatter, 2), '%')
  row('pH',                 num(suelo?.ph, 1))
  row('P Olsen',            num(suelo?.pOlsen, 1),  'ppm')
  row('K suelo',            num(suelo?.kSoil, 0),   'ppm')
  row('CEC',                num(cec, 0),             'meq/kg')
  row('Densidad aparente',  num(soilEffect, 2))

  row('', null)

  row('Sistema de explotación', riego?.sistemaExplotacion === 'regadio' ? 'Regadío' : 'Secano')
  row('Origen del agua (SIEX)', riego?.sistemaExplotacion === 'regadio'
    ? (riego?.fuenteLabel ?? (riego?.fuenteId > 0 ? `SIEX ${riego.fuenteId}` : 'Sin especificar'))
    : 'Sin riego')
  if (riego?.refAnalisisAgua) row('Ref. análisis agua', riego.refAnalisisAgua)
  if (riego?.sistemaExplotacion === 'regadio') {
    row('Dotación riego',    num(riego?.dotacionM3, 0),  'm³/ha')
    row('NO₃ agua riego',    num(riego?.no3MgL, 1),     'mg/L')
    row('P agua riego',      num(riego?.pMgL,   1),     'mg/L')
    row('K agua riego',      num(riego?.kMgL,   1),     'mg/L')
    if (nRiego != null || pRiego > 0 || kRiego > 0) {
      if (nRiego != null) row('N aportado riego',    nRiego,                            'kg N/ha')
      if (pRiego  > 0)    row('P₂O₅ aportado riego', num(pRiego * P_TO_P2O5, 1),       'kg P₂O₅/ha')
      if (kRiego  > 0)    row('K₂O aportado riego',  num(kRiego * K_TO_K2O,  1),       'kg K₂O/ha')
    }
  }

  row('', null)

  // Bloque NPK: bruto (necesidad total cultivo) → cubierto riego → neto (fertilizante)
  // N bruto = nVal directo (ya es el total, independiente del riego, ver sativum-algo.js)
  row('— Necesidades brutas (cultivo) —', null)
  row('N bruto',    nBruto,                       'kg N/ha')
  row('P₂O₅ bruto', num(p * P_TO_P2O5, 1),       'kg P₂O₅/ha')
  row('P bruto',    p,                            'kg P/ha')
  row('K₂O bruto',  num(k * K_TO_K2O,  1),       'kg K₂O/ha')
  row('K bruto',    k,                            'kg K/ha')

  if (nRiegoVal > 0 || pRiego > 0 || kRiego > 0) {
    row('', null)
    row('— Cubierto por riego —', null)
    if (nRiego  != null) row('N por riego',     nRiego,                          'kg N/ha')
    if (pRiego  > 0)     row('P₂O₅ por riego',  num(pRiego * P_TO_P2O5, 1),     'kg P₂O₅/ha')
    if (kRiego  > 0)     row('K₂O por riego',   num(kRiego * K_TO_K2O,  1),     'kg K₂O/ha')

    row('', null)
    row('— A cubrir con fertilizante (neto) —', null)
    row('N neto',    num(nNeto, 1),                        'kg N/ha')
    row('P₂O₅ neto', num(pNeto * P_TO_P2O5, 1),          'kg P₂O₅/ha')
    row('P neto',    num(pNeto, 1),                       'kg P/ha')
    row('K₂O neto',  num(kNeto * K_TO_K2O,  1),          'kg K₂O/ha')
    row('K neto',    num(kNeto, 1),                       'kg K/ha')
  }

  // ── Medidas de mitigación GEI (Anexo V RD 1051/2022) ────────────────────
  if (Array.isArray(medidasGEI) && medidasGEI.length > 0) {
    row('', null)
    row('— Medidas de mitigacion GEI (Anexo V RD 1051/2022) —', null)
    const medidasSeleccionadas = MEDIDAS_MITIGACION_GEI.filter(m => medidasGEI.includes(m.codigoSiex))
    medidasSeleccionadas.forEach(m => {
      row(`Cod. SIEX ${m.codigoSiex}`, m.texto)
    })
  }

  const wsPlan = XLSX.utils.json_to_sheet(plan)
  wsPlan['!cols'] = [{ wch: 28 }, { wch: 24 }, { wch: 14 }]

  // ── Hoja 2: Plan de aplicaciones (unificado, ordenado por fecha) ────────
  const fertRows = []
  const itemsSorted = [...(Array.isArray(allItems) ? allItems : [])].sort((a, b) => {
    if (!a.fechaAplicacion && !b.fechaAplicacion) return 0
    if (!a.fechaAplicacion) return 1
    if (!b.fechaAplicacion) return -1
    return a.fechaAplicacion.localeCompare(b.fechaAplicacion)
  })

  if (itemsSorted.length > 0) {
    let sigN = 0; let sigP2o5 = 0; let sigK2o = 0
    itemsSorted.forEach((item) => {
      const dose  = Number(item.cantidad) || 0
      const aN    = num((item.n    ?? 0) * dose / 100, 1)
      const aP2o5 = num((item.p2o5 ?? 0) * dose / 100, 1)
      const aK2o  = num((item.k2o  ?? 0) * dose / 100, 1)
      sigN    += (item.n    ?? 0) * dose / 100
      sigP2o5 += (item.p2o5 ?? 0) * dose / 100
      sigK2o  += (item.k2o  ?? 0) * dose / 100
      const origen = item.origen === 'sativum' ? 'Propuesta Sativum' : 'Selección asesor'
      const ef = calcEfectivoExcel(item, fechaInicioCiclo)
      fertRows.push({
        'Origen':                  origen,
        'Fertilizante':            item.nombre ?? 'Producto personalizado',
        'Tipo SIEX':               item.tipoSIEX ?? null,
        '% N':                     num(item.n,    1),
        '% P₂O₅':                 num(item.p2o5, 1),
        '% K₂O':                  num(item.k2o,  1),
        'Dosis (kg/ha)':           num(dose, 0),
        'N aportado (kg/ha)':      aN,
        'P₂O₅ aportado (kg/ha)':  aP2o5,
        'K₂O aportado (kg/ha)':   aK2o,
        'Mineral. (%)':            ef.pct,            // null si no orgánico
        'N efectivo (kg/ha)':      ef.efN,            // null si no orgánico
        'P₂O₅ efectivo (kg/ha)':  ef.efP2o5,
        'K₂O efectivo (kg/ha)':   ef.efK2o,
        'Año 0 (%)':              item.appliesAnnualEffectiveness ? (item.yearPercent0 ?? null) : null,
        'Año 1 (%)':              item.appliesAnnualEffectiveness ? (item.yearPercent1 ?? null) : null,
        'Año 2 (%)':              item.appliesAnnualEffectiveness ? (item.yearPercent2 ?? null) : null,
        'Org. (ef. anual)':       item.appliesAnnualEffectiveness ? 'Sí' : null,
        'Fecha aplicación':        item.fechaAplicacion ?? null,
        'ΣN (kg/ha)':              num(sigN,    1),
        'ΣP₂O₅ (kg/ha)':          num(sigP2o5, 1),
        'ΣK₂O (kg/ha)':           num(sigK2o,  1),
      })
    })
  }

  const wsFert = XLSX.utils.json_to_sheet(
    fertRows.length > 0 ? fertRows : [{ 'Info': 'No hay recomendaciones de fertilizantes disponibles.' }]
  )
  wsFert['!cols'] = [
    { wch: 20 }, // Origen
    { wch: 32 }, // Fertilizante
    { wch: 26 }, // Tipo SIEX
    { wch:  8 }, // % N
    { wch:  9 }, // % P₂O₅
    { wch:  9 }, // % K₂O
    { wch: 14 }, // Dosis
    { wch: 20 }, // N aportado
    { wch: 22 }, // P₂O₅ aportado
    { wch: 20 }, // K₂O aportado
    { wch: 14 }, // Mineral. (%)
    { wch: 20 }, // N efectivo
    { wch: 22 }, // P₂O₅ efectivo
    { wch: 20 }, // K₂O efectivo
    { wch:  9 }, // Año 0 (%)
    { wch:  9 }, // Año 1 (%)
    { wch:  9 }, // Año 2 (%)
    { wch: 14 }, // Org. (ef. anual)
    { wch: 16 }, // Fecha aplicación
    { wch: 14 }, // ΣN
    { wch: 16 }, // ΣP₂O₅
    { wch: 14 }, // ΣK₂O
  ]

  // ── Hoja 3: Notas ───────────────────────────────────────────────────────
  const notas = [
    { 'Campo': 'Aplicación',         'Valor': 'FertiPRO' },
    { 'Campo': 'Motor de cálculo',   'Valor': 'FertiliCalc (Villalobos et al. 2020) vía API Sativum (ITACyL)' },
    { 'Campo': 'Fuente suelo',       'Valor': '©Junta de Castilla y León (IGCYL-NC) · suelos.itacyl.es' },
    { 'Campo': 'Fuente recintos',    'Valor': 'SIGPAC (FEGA) · OGC API · CC BY 4.0' },
    ...(recintosWkt.length > 0 ? [
      { 'Campo': 'Geometría (WKT)', 'Valor': 'EPSG:4326 (WGS84), lon lat — un recinto por fila, nunca geometría fusionada' },
    ] : []),
    ...(unidadesCultivo.length > 0 ? [
      { 'Campo': 'Unidades de Cultivo (Visual)', 'Valor': 'Ver hoja "Unidades de Cultivo" — IDs de las UC de Visual vinculadas a este plan' },
    ] : []),
    { 'Campo': 'Fecha generación',   'Valor': new Date().toISOString() },
    { 'Campo': 'Unidades NPK',       'Valor': 'kg/ha — N en elemento puro; P y K en forma óxido (P₂O₅, K₂O)' },
    { 'Campo': 'Conversión P→P₂O₅', 'Valor': '× 2.2914' },
    { 'Campo': 'Conversión K→K₂O',  'Valor': '× 1.2046' },
    { 'Campo': 'N aportado riego',   'Valor': 'NO₃ (mg/L) × dotación (m³/ha) / 1000 × (14/62) = kg N/ha' },
    ...(titular?.nombreRazonSocial || titular?.nifCif ? [
      { 'Campo': '', 'Valor': '' },
      { 'Campo': 'Titular de la explotación', 'Valor': titular.nombreRazonSocial || '' },
      { 'Campo': 'Tipo titular', 'Valor': titular.tipo === 'juridica' ? 'Persona jurídica' : 'Persona física' },
      ...(titular.nifCif ? [{ 'Campo': titular.tipo === 'juridica' ? 'CIF titular' : 'NIF titular', 'Valor': titular.nifCif }] : []),
    ] : []),
    ...(asesor?.nombre || asesor?.regfer ? [
      { 'Campo': '', 'Valor': '' },
      { 'Campo': 'Asesor responsable', 'Valor': [asesor.nombre, asesor.apellidos].filter(Boolean).join(' ') || '' },
      ...(asesor.regfer   ? [{ 'Campo': 'Nº REGFER',        'Valor': asesor.regfer }]   : []),
      ...(asesor.nif      ? [{ 'Campo': 'NIF asesor',        'Valor': asesor.nif }]      : []),
      ...(asesor.telefono ? [{ 'Campo': 'Teléfono asesor',   'Valor': asesor.telefono }] : []),
      ...(asesor.email    ? [{ 'Campo': 'Email asesor',      'Valor': asesor.email }]    : []),
    ] : []),
  ]
  const wsNotas = XLSX.utils.json_to_sheet(notas)
  wsNotas['!cols'] = [{ wch: 22 }, { wch: 60 }]

  // ── Hoja 4 (opcional): Recintos (WKT) — mismo esquema que calcular.js ────
  // (fertipro-test/plantilla) y que el gemelo `fertipro` (motor propio).
  // Cambio aditivo: si no hay recintos (plan exportado sin geometría, o Excel
  // anterior a esta hoja), no se crea — importarPlanDesdeExcel() sigue
  // funcionando igual que hasta ahora.
  let wsRecintosWkt = null
  if (recintosWkt.length > 0) {
    const recintosRows = recintosWkt.map((r) => ({
      'Ref. hoja de cultivo': r.ref ?? null,
      'Fichero origen':       r.fichero ?? null,
      'Fila origen':          r.fila ?? null,
      'Superficie (ha)':      r.superficieHa ?? null,
      'Geometría (WKT)':      r.wkt,
    }))
    wsRecintosWkt = XLSX.utils.json_to_sheet(recintosRows)
    wsRecintosWkt['!cols'] = [{ wch: 24 }, { wch: 24 }, { wch: 12 }, { wch: 16 }, { wch: 60 }]
  }

  // ── Hoja 5 (opcional): Unidades de Cultivo — trazabilidad Visual ────────
  // Cambio aditivo (6-sep-2026): si el plan agrupa/referencia una o varias UC
  // de Visual (típicamente vía group_crop_units en el MCP), esta hoja deja
  // constancia de qué idFinca(s) quedaron vinculadas a este balance concreto
  // — sin esto, el Excel no dice nada sobre su origen en Visual. Si no se pasa
  // ninguna UC (plan manual, o Excel anterior a esta hoja), no se crea —
  // importarPlanDesdeExcel() sigue funcionando igual que hasta ahora.
  let wsUnidadesCultivo = null
  if (unidadesCultivo.length > 0) {
    const ucRows = unidadesCultivo.map((u) => ({
      'ID Unidad de Cultivo (Visual)': u.idFinca ?? null,
      'Superficie (ha)':               u.superficieHa ?? null,
      'Variedad':                      u.variedad ?? null,
      'Municipio':                     u.municipio ?? null,
      'Sistema de explotación':        u.sistemaExplotacion ?? null,
    }))
    wsUnidadesCultivo = XLSX.utils.json_to_sheet(ucRows)
    wsUnidadesCultivo['!cols'] = [{ wch: 28 }, { wch: 16 }, { wch: 20 }, { wch: 20 }, { wch: 22 }]
  }

  // ── Ensamblar y descargar ───────────────────────────────────────────────
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, wsPlan,  'Plan de Abonado')
  XLSX.utils.book_append_sheet(wb, wsFert,  'Fertilizantes')
  XLSX.utils.book_append_sheet(wb, wsNotas, 'Notas')
  if (wsRecintosWkt) XLSX.utils.book_append_sheet(wb, wsRecintosWkt, 'Recintos (WKT)')
  if (wsUnidadesCultivo) XLSX.utils.book_append_sheet(wb, wsUnidadesCultivo, 'Unidades de Cultivo')

  return wb
}

/**
 * Wrapper de descarga en navegador — delega toda la construcción del workbook
 * en construirWorkbookPlanAbonado() (pura, sin DOM) para poder reutilizarla
 * tal cual desde el endpoint serverless :export-report (api/sativum-report.js),
 * sin duplicar la lógica de las 4 hojas. Mismo comportamiento externo que antes.
 */
export async function exportarPlanAbonado(params) {
  const { baseName = 'fertipro_plan_abonado' } = params
  const wb = await construirWorkbookPlanAbonado(params)
  const mod  = await import('xlsx')
  const XLSX = mod.default ?? mod
  XLSX.writeFile(wb, `${baseName}.xlsx`)
}
