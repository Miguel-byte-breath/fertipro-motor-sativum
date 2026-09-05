/**
 * api/sativum-report.js — endpoint serverless :export-report
 *
 * URL definitiva (rewrite ya presente en vercel.json, mismo patrón
 * con `:` escapado que :calculate-npk/:group-crop-units):
 *   POST /v1/sativum/fertilization-plans:export-report → /api/sativum-report
 *
 * Genera el Excel del plan de abonado reutilizando construirWorkbookPlanAbonado()
 * (src/utils/exportExcel.js) — la MISMA función que ya usa la web de producción
 * para el botón "Exportar Excel", sin duplicar ni reescribir su lógica. El
 * fichero resultante es indistinguible del que ya se descarga hoy desde la
 * app, incluida la hoja opcional "Recintos (WKT)" — requisito de producto
 * confirmado por Miguel: tiene que poder reimportarse en producción con
 * importarPlanDesdeExcel() sin tocar ese fichero.
 *
 * Contrato cerrado (ver memoria del proyecto):
 *   - No es batch: un fichero por llamada.
 *   - Alcance v1: solo Excel — `format` reservado, default 'xlsx'; cualquier
 *     otro valor es 400 (todavía no soportado).
 *   - Respuesta: buffer del Excel directo en el body HTTP, nunca presigned URL.
 *   - `baseName` SIEMPRE se recalcula en servidor con la misma fórmula que usa
 *     App.jsx (NIF + nombrePlan + sufijo "_Sativum", sanitizarNombreFichero) —
 *     no se confía en un baseName que mande el cliente, para garantizar la
 *     paridad exacta con el nombre que ya generan los planes de producción.
 */

import { construirWorkbookPlanAbonado } from '../src/utils/exportExcel.js'
import { sanitizarNombreFichero } from '../src/utils/slugify.js'

function correlationId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function sendError(res, { httpStatus, key, message, params = {}, details = [] }) {
  return res.status(httpStatus).json({
    correlationId: correlationId(),
    httpStatusInfo: { status: httpStatus },
    key,
    message,
    formattedMessage: message,
    params,
    details,
  })
}

// Misma fórmula que handleExportarPlan/handleExportarPlanPdf en App.jsx —
// no se toca esa lógica, se replica aquí para que el servidor no dependa de
// que el cliente calcule bien el nombre.
function calcularBaseName({ titular, nombrePlan }) {
  const plan = (nombrePlan ?? '').trim()
  const base = plan
    ? (titular?.nifCif?.trim()
        ? `${sanitizarNombreFichero(titular.nifCif)}_${sanitizarNombreFichero(plan)}`
        : sanitizarNombreFichero(plan))
    : 'fertipro_plan_abonado'
  return `${base}_Sativum`
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, {
      httpStatus: 405,
      key: 'METHOD_NOT_ALLOWED',
      message: 'Método no permitido. Usa POST.',
    })
  }

  const body = req.body ?? {}
  const { format = 'xlsx', cultivo, npk } = body

  if (format !== 'xlsx') {
    return sendError(res, {
      httpStatus: 400,
      key: 'FORMAT_NOT_SUPPORTED',
      message: `Formato '${format}' no soportado todavía. Esta version solo genera 'xlsx'.`,
      params: { format },
    })
  }

  if (!cultivo || !npk) {
    return sendError(res, {
      httpStatus: 400,
      key: 'MISSING_REQUIRED_FIELDS',
      message: 'Faltan campos obligatorios: cultivo y npk son necesarios para generar el informe.',
      details: [
        ...(!cultivo ? [{ field: 'cultivo', issue: 'REQUIRED' }] : []),
        ...(!npk     ? [{ field: 'npk',     issue: 'REQUIRED' }] : []),
      ],
    })
  }

  let wb
  try {
    wb = await construirWorkbookPlanAbonado(body)
  } catch (err) {
    return sendError(res, {
      httpStatus: 400,
      key: 'REPORT_GENERATION_FAILED',
      message: 'No se ha podido generar el Excel con los datos recibidos.',
      details: [{ error: String(err?.message ?? err) }],
    })
  }

  const mod  = await import('xlsx')
  const XLSX = mod.default ?? mod
  const buffer   = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const baseName = calcularBaseName(body)

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}.xlsx"`)
  return res.status(200).send(buffer)
}
