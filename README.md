# FertiPRO Add-on Sativum

**Módulo web de planificación de abonado para cultivos agrícolas españoles, construido sobre la API pública de Sativum (ITACyL).**

Calcula las necesidades de fertilización NPK usando la API de Sativum (ITACyL). El cálculo lo realiza el algoritmo FertiliCalc, implementado en el servicio público de balance de nutrientes Sativum y en la Farm Advisory Tool for nutrients (FAST) de la Comisión Europea, conforme a *Fitotecnia: principios de agronomía para una agricultura sostenible* (F. Villalobos), con adaptaciones del ITACyL. Sobre ese cálculo, FertiPRO selecciona fertilizantes del catálogo oficial (1 253 productos), aplica la mineralización anual de enmiendas orgánicas según el RD 1051/2022, y genera un plan de aplicaciones exportable en Excel y PDF conforme al art. 6 del mismo real decreto.

🌐 **Producción:** <https://fertipro-motor-sativum.app> (también accesible en <https://fertipro.vercel.app>)

> A partir de ahora se irá comunicando y dando difusión al dominio `fertipro-motor-sativum.app` como
> referencia principal de esta herramienta, para no generar confusión con la aplicación oficial de
> FertiPRO (VisualNaCert/Fertinagro).

---

## Flujo de trabajo

Pensado para **asesores agrícolas y técnicos** que necesitan elaborar planes de abonado conformes al RD 1051/2022. El flujo de trabajo completo es:

1. **Localiza la parcela** — dibuja un polígono libre, carga un GeoJSON/shapefile o pincha directamente en el mapa. FertiPRO recupera automáticamente los recintos SIGPAC que intersectan la geometría: referencia catastral, superficie, uso del suelo, coeficiente de regadío y clasificación ZVN (Zona Vulnerable a Nitratos, RD 47/2022) con alerta visual si algún recinto está en ZVN.

2. **Identifica el suelo** — consulta en tiempo real el MapServer ArcGIS de ITACyL para obtener textura, materia orgánica, pH, P Olsen, K y NO₃ del agua subterránea. También permite introducir datos propios de un análisis de laboratorio (ref. boletín + campos editables).

3. **Configura agua de riego y suelo** — panel unificado con toggle Secano/Regadío, selector de origen del agua (6 fuentes SIEX), dotación orientativa Sativum (m³/ha), y campos de calidad del agua (NO₃, P, K) que se auto-rellenan desde ArcGIS si el origen es agua subterránea.

4. **Configura el cultivo** — selecciona el cultivo actual y el precedente en la rotación, el rendimiento objetivo, la estrategia de abonado y el manejo de residuos.

5. **Calcula las necesidades NPK** — el Add-on delega el cálculo directamente en el motor FertiliCalc de la API Sativum (ITACyL), siguiendo las instrucciones del portal del desarrollador y el manual de Sativum v2.1.0. El resultado son las unidades fertilizantes brutas N, P₂O₅ y K₂O, con descuento automático de los aportes del agua de riego.

6. **Construye el plan de aplicaciones** — añade propuestas del catálogo Sativum (5 opciones por solicitud, ajustadas al mayor déficit NPK) o fertilizantes del asesor con filtro cascada Tipo SIEX → Fabricante → Producto. Los fertilizantes orgánicos aplican automáticamente la mineralización anual (`yearPercent0/1/2`) según categoría SIEX. Las barras de cobertura muestran el porcentaje cubierto en tiempo real.

7. **Datos del asesor REGFER** — panel colapsable para registrar nombre, apellidos, NIF y nº REGFER del asesor responsable del plan, que se incluyen en los documentos exportados.

8. **Plan de riego semanal** — el botón "💧 Plan de Riego Semanal" consulta en tiempo real la climatología oficial del **SiAR (MAPA)** para la ubicación de la parcela. La petición viaja desde FertiPRO Add-on Sativum a una función serverless propia, que a su vez llama al servicio [SIG Riego Pro](https://sig-riego-rdc-siar-pm.vercel.app) vía HTTP. Ese servicio recupera la ETo y Pe mensuales del SiAR, aplica el coeficiente de cultivo Kc (FAO-56 Rev.1) según las fases fenológicas del ciclo seleccionado, y devuelve la programación semanal (m³/ha por semana) y el balance hídrico mensual (ETc, Pe, NHN, volumen asignado). El resultado se presenta en un modal y se puede exportar como PDF independiente.

9. **Exporta** — descarga el plan de abonado en **Excel** (hojas: Plan, Fertilizantes con eficacia orgánica, Recintos SIGPAC, Notas) o en **PDF** con cabecera de atribución, tabla de recintos con columna ZVN, bloque NPK visual, tabla de origen del agua de riego y plan de aplicaciones con acumulados.

---

## Cargar un plan existente

Si ya tienes un plan exportado en Excel, puedes recuperar el estado completo de la sesión sin introducir los datos de nuevo.

1. **Importa el plan** — pulsa **"Importar plan"** en la cabecera y selecciona el archivo `.xlsx` exportado previamente. Aparecerá una confirmación con el cultivo reconocido. Si el Excel incluye una hoja "Recintos (WKT)" (por ejemplo, planes generados en lote), los recintos se pintan automáticamente en el mapa sin ninguna acción adicional; si no la incluye, la geometría debe cargarse manualmente (no se guarda en el Excel de un plan construido a mano en la app).

2. **Carga la parcela en el mapa (si no se cargó ya sola)** — usa la barra de herramientas del mapa para dibujar el polígono o importar un GeoJSON/shapefile. FertiPRO consulta automáticamente los recintos SIGPAC (superficie, uso del suelo, ZVN) y el servicio de suelos de ITACyL. Si el plan usaba análisis de laboratorio propio, esos valores tienen prioridad sobre los de ArcGIS.

3. **Revisa los datos restaurados** — comprueba que todo es coherente con la parcela: recintos SIGPAC y alertas ZVN, cultivo actual y precedente, estrategia de abonado, suelo y agua de riego, y el plan de aplicaciones con su cobertura NPK acumulada.

4. **Calcula las necesidades NPK** — pulsa **"Calcular necesidades NPK"**. El plan de aplicaciones ya no se reinicia al recalcular: un cambio de cultivo, estrategia o manejo puede afectar a los productos ya añadidos, así que conviene revisar las barras de cobertura NPK y ajustar o eliminar los que ya no correspondan.

---

## Stack técnico

| Capa | Tecnología |
|------|-----------|
| Frontend | Vite 5 + React 18 |
| Mapa | Leaflet 1.9 + leaflet-geoman (dibujo de polígonos) |
| Geoprocesamiento | @turf/area, @turf/centroid, @turf/intersect |
| Backend (proxies) | Vercel Serverless Functions (`/api/*.js`) |
| Exportación Excel | SheetJS (xlsx 0.18.5, Apache-2.0) |
| Exportación PDF | jsPDF 4 + jsPDF-AutoTable 5 (MIT) |
| SIGPAC | OGC API Features + REST recinfo/nitratos (FEGA HubCloud) |
| Suelo | ArcGIS MapServer (ITACyL) |
| Motor NPK | API REST FertiliCalc (Sativum/ITACyL) |
| Plan de riego | SIG Riego Pro (SiAR/MAPA) — integración vía HTTP |

---

## Arranque local

### Requisitos previos

- **Node.js** ≥ 18
- **npm** ≥ 9
- Cuenta en el [Portal del desarrollador de ITACyL](https://portal.api.itacyl.es/portal/) con una `SATIVUM_API_KEY` activa

### Instalación

```powershell
git clone https://github.com/Miguel-byte-breath/fertipro-motor-sativum.git
cd fertipro-api-sativum
npm install
```

### Variables de entorno

Crea un fichero `.env.local` en la raíz del proyecto:

```
SATIVUM_API_KEY=tu_clave_aqui
```

> **Nota de seguridad:** esta clave **nunca** debe llegar al cliente. Solo se usa dentro de las funciones serverless (`/api/*.js`). No la incluyas en el código ni en el repositorio.

### Modo desarrollo sin funciones serverless

```powershell
npm run dev
```

Arranca el servidor de Vite en `http://localhost:5173`. Las llamadas a `/api/*` se redirigen automáticamente al deploy de producción mediante el proxy configurado en `vite.config.js`, por lo que el frontend funciona sin Vercel CLI.

> ⚠️ En este modo las peticiones a la API Sativum van al proxy de producción (fertipro.vercel.app). Para trabajar con tu propia clave en local usa el modo Vercel CLI.

### Modo desarrollo completo (con funciones serverless)

Requiere la [Vercel CLI](https://vercel.com/docs/cli) instalada y el proyecto enlazado:

```powershell
npx vercel login       # solo la primera vez o cuando caduca el token
npx vercel link        # enlaza con tu proyecto Vercel (solo la primera vez)
npx vercel dev         # arranca frontend + funciones en http://localhost:3000
```

Con `vercel dev` la variable `SATIVUM_API_KEY` se lee de tu proyecto Vercel (o de `.env.local`).

### Verificar build antes de publicar

```powershell
npm run build
```

---

## Despliegue en producción

FertiPRO se despliega automáticamente en [Vercel](https://vercel.com) al hacer push a la rama principal:

```powershell
git add .
git commit -m "descripción del cambio"
git push
```

Vercel recompila y republica en 2–3 minutos. No hay ningún paso manual adicional.

### Variables de entorno en Vercel

Configura la siguiente variable en **Vercel → tu proyecto → Settings → Environment Variables**:

| Variable | Descripción |
|----------|-------------|
| `SATIVUM_API_KEY` | API key del portal ITACyL. Obligatoria para el cálculo NPK y la consulta de suelos. |

SIGPAC HubCloud no requiere clave: sus endpoints son públicos.

---

## Servidor MCP para agentes IA

Además de la web, FertiPRO Add-on Sativum expone un **servidor MCP (Model Context Protocol)** en
`https://fertipro-motor-sativum.app/api/mcp`, para que un agente de IA (por ejemplo Claude, vía un
conector MCP) pueda generar un plan de abonado completo de forma conversacional — sin que un humano
rellene el formulario web paso a paso.

El servidor expone 5 tools, pensadas para usarse en este orden:

1. **`group_crop_units`** — agrupa unidades de cultivo de Visual por titular/cultivo, con geometría.
2. **`search_crop`** — busca un cultivo en el catálogo Sativum (por nombre y/o grupo).
3. **`estimate_soil_water_arcgis`** — estima suelo y agua subterránea por ArcGIS cuando no hay
   analítica propia (siempre como último recurso, nunca sustituye a un análisis real).
4. **`calculate_npk`** — calcula las necesidades NPK (motor FertiliCalc/Sativum), preguntando por
   cultivo actual y precedente, laboreo/residuos, y estrategia de abonado.
5. **`export_report`** — genera el Excel del plan, reutilizando exactamente la misma función que el
   botón "Exportar Excel" de la web — el fichero resultante es indistinguible y se puede reimportar
   sin problema.

Tres de estas tools (`calculate_npk`, `group_crop_units`, `export_report`) envuelven exactamente los
mismos endpoints HTTP `POST /v1/sativum/...` que usa el MCP internamente — pensados también como una
posible vía de conexión directa desde la propia aplicación de Visual en el futuro, sin pasar por un
agente IA.

> **Estado (septiembre 2026):** validado con un caso real de extremo a extremo (2 planes de abonado
> completos generados vía Claude). Sin autenticación todavía — cualquiera con la URL puede llamar a
> las tools; pendiente de decidir un token antes de compartirla ampliamente.

---

## Estructura del repositorio

```
fertipro-api-sativum/
├── api/                            Funciones serverless Vercel (proxies)
│   ├── sativum-algo.js               POST /fertilicalc/algo/ — cálculo NPK
│   ├── sativum-fertilizers.js        GET/POST /nutrients/fertilizers — catálogo y recomendación
│   ├── sativum-crops.js              GET /nutrients/crops — catálogo de cultivos
│   ├── sativum-suelo.js              GET ArcGIS identify — características del suelo
│   ├── sativum-plan.js               POST :calculate-npk — cálculo NPK (contrato estable, usado también por el MCP)
│   ├── sativum-group.js              POST :group-crop-units — agrupación de unidades de cultivo Visual
│   ├── sativum-report.js             POST :export-report — genera el Excel del plan (contrato estable)
│   ├── sativum-arcgis-npk.js         Estimación de suelo/agua por ArcGIS para el MCP
│   ├── sativum-crops-search.js       Búsqueda en el catálogo Sativum para el MCP
│   ├── mcp.js                        Servidor MCP — 5 tools para agentes IA (ver sección abajo)
│   ├── plan-riego.js                 POST /api/calcular-riego (SIG Riego Pro) — plan de riego semanal
│   ├── sigpac.js                     GET OGC API Features — recinto en un punto
│   ├── sigpac-mvt.js                 GET teselas MVT/GeoJSON de SIGPAC (capa de recintos en el mapa)
│   ├── sigpac-bbox.js                GET OGC API Features — recintos en bbox
│   ├── sigpac-recinfo.js             GET REST recinfo — uso, coef. regadío, superficie
│   └── sigpac-zvn.js                 GET REST nitratos — clasificación ZVN
├── public/
│   └── fertipro.png                Logo de la aplicación (cabecera PDF y app)
├── src/
│   ├── api/                        Wrappers cliente de los proxies serverless
│   │   ├── sativum-algo.js           calcularNPK, calcularNAgua, ensamblarPayload
│   │   ├── sativum-fertilizers.js    getRecomendacion, getFertilizadores, getFertilizador
│   │   ├── sativum-crops.js          catálogo de cultivos (HI, N/P/K, f_res, nfix_code…)
│   │   ├── sativum-suelo.js          identifySativum, normalizarSuelo
│   │   └── sigpac.js                 recinto SIGPAC más cercano a un punto
│   ├── components/                 Componentes React
│   │   ├── AsesoramientoPanel.jsx    Panel REGFER del asesor (persiste en localStorage)
│   │   ├── CultivoAnteriorPanel.jsx  Cultivo precedente en la rotación
│   │   ├── EstrategiaPanel.jsx       Estrategia, laboreo, parámetros N avanzados
│   │   ├── FertilizanteManualPanel.jsx  Plan de aplicaciones: catálogo Sativum + asesor manual
│   │   ├── GeometryPanel.jsx         Geometría de referencia: parcelas, superficie, descargas
│   │   ├── MedidasMitigacionPanel.jsx    Panel colapsable medidas GEI (Anexo V RD 1051/2022)
│   │   ├── MetodologiaModal.jsx      Modal metodología: cadena FertiliCalc→FaST→Sativum
│   │   ├── ParcelaInfoCard.jsx       Tabla recintos SIGPAC (superficie, uso, ZVN)
│   │   ├── PlanRiegoModal.jsx        Modal plan de riego semanal (SIG Riego Pro) + export PDF
│   │   ├── RecintoCard.jsx           Ficha del recinto SIGPAC en el punto/parcela activa
│   │   ├── RecintosOrigenCard.jsx    Composición de una hoja construida desde recintos SIGPAC
│   │   ├── ResultadosCard.jsx        Visualización NPK + botón "Añadir aplicación Sativum"
│   │   ├── SativumApplicationDialog.jsx  Modal: sliders % objetivo → 5 opciones catálogo
│   │   └── SueloRiegoCard.jsx        Panel unificado suelo + agua de riego
│   ├── cultivos/
│   │   ├── CultivoCard.jsx           Ficha de detalle del cultivo + gestión de residuos editable
│   │   └── CultivoSelector.jsx       Combobox con búsqueda contra /nutrients/crops
│   ├── data/sativum/               Tablas estáticas
│   │   ├── algoParams.js             efficiency_factor/p_threshold/k_threshold por estrategia×textura
│   │   ├── fuentesAgua.js            Catálogo SIEX fuentes de agua (ids 0-6)
│   │   ├── medidasMitigacionGEI.js   16 medidas GEI filtradas del catálogo FEGA (Anexo V)
│   │   ├── soilTypes.json            12 clases texturales FAO/USDA (modo Laboratorio propio)
│   │   ├── soilTypesSimpl.json       Mapeo pixel ArcGIS → SANDY/LOAM/CLAY_LOAM etc.
│   │   └── tiposMaterialFertilizante.js  24 tipos SIEX (RD 1051/2022)
│   ├── map/
│   │   └── MapPicker.jsx             Leaflet + leaflet-geoman, PNOA + OSM
│   └── utils/
│       ├── exportExcel.js            Plan en Excel (Plan, Fertilizantes, Recintos SIGPAC, Notas)
│       ├── exportPdf.js              Plan en PDF (art. 6 RD 1051/2022)
│       ├── fresRule.js               Regla compartida de f_res (residuos en campo, actual/anterior)
│       ├── geometry.js               centroide, exportarGeoJSON, exportarSHP
│       ├── importExcel.js            Restaura el estado de la sesión desde un Excel exportado
│       ├── npkUtils.js               calcNpkEfectivo, aniosTranscurridos (mineralización orgánicos)
│       ├── recintosInterseccion.js   interseccionRecintos, enrichRecintos (ZVN + recinfo)
│       └── slugify.js                Slug ASCII para nombres de fichero descargados
├── App.jsx                         Raíz: estado global, flujo de cálculo, exportación
├── index.html
├── vite.config.js
├── vercel.json
└── package.json
```

---

## Fuentes de datos y licencias

### Motor de cálculo — FertiliCalc / API Sativum (ITACyL)

El cálculo de necesidades NPK se delega íntegramente en el **servicio FertiliCalc** de la API Sativum, desarrollado por el **Instituto Tecnológico Agrario de Castilla y León (ITACyL)** en el marco del convenio de colaboración con el Fondo Español de Garantía Agraria (FEGA/MAPA). La integración sigue las instrucciones del [Portal del desarrollador de ITACyL](https://portal.api.itacyl.es/portal/) y la [Guía de Servicios Sativum v2.1.0](https://servicios.itacyl.es/resources/public/sativum/ServiciosBalanceNutrientes.docx).

Este servicio es de acceso público para terceros y requiere una API key obtenida en el portal anterior.

Los perfiles agronómicos de algunos cultivos (remolacha, girasol, soja) han sido revisados en el proyecto **ACORSAT**, financiado por FEADER (Submedida 16.2 PDR CyL).

© Instituto Tecnológico Agrario de Castilla y León — Junta de Castilla y León · [sativum.es](https://www.sativum.es) · Licencia [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.es)

### Datos de suelo — ArcGIS MapServer (ITACyL / JCyL)

Las características edafológicas (textura, materia orgánica, pH, P Olsen, K, conductividad eléctrica) proceden del **Visor de Suelos de Castilla y León** de ITACyL, accesibles a través de su servicio ArcGIS REST.

Fuente: [suelos.itacyl.es](https://suelos.itacyl.es) · © ITACyL — Junta de Castilla y León (IGCYL-NC)

### Recintos SIGPAC — FEGA (MAPA)

Los datos de recintos, geometrías, usos del suelo, coeficientes de regadío y Zonas Vulnerables a Nitratos (ZVN) proceden del **Sistema de Información Geográfica de Parcelas Agrícolas (SIGPAC)**, gestionado por el **Fondo Español de Garantía Agraria (FEGA)**.

Distribuidos como **Datos de Alto Valor (HVD)** bajo licencia **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.es)** conforme al Reglamento de Implementación UE 2023/138.

Endpoint: [sigpac-hubcloud.es](https://sigpac-hubcloud.es) · Fuente: FEGA — MAPA

### Ortofoto base — PNOA (IGN)

La capa de ortofoto base del mapa procede del **Plan Nacional de Ortofotografía Aérea (PNOA) Máxima Actualidad** del **Instituto Geográfico Nacional (IGN)**.

Licencia: **CC BY 4.0** (Orden FOM/2807/2015) · © IGN · [ign.es](https://www.ign.es)

### Datos climatológicos — SiAR (MAPA)

El plan de riego semanal se basa en datos de evapotranspiración de referencia (ETo) y precipitación efectiva (Pe) mensuales del **Sistema de Información Agroclimática para el Regadío (SiAR)** del Ministerio de Agricultura, Pesca y Alimentación (MAPA). FertiPRO Add-on Sativum accede a ellos a través del servicio [SIG Riego Pro](https://sig-riego-rdc-siar-pm.vercel.app), que construye la climatología media de los tres años completos cerrados anteriores al ciclo de cultivo y distribuye el balance mensual en programación semanal.

El uso del SiAR como referencia técnica para la dosis y frecuencia de riego está recogido en el **RD 1051/2022 – Anexo IX**.

Fuente: SiAR — MAPA · [mapa.gob.es](https://www.mapa.gob.es)

### Normativa de referencia

- **RD 1051/2022**, de 27 de diciembre — nutrición sostenible en suelos agrícolas (plan de abonado, registro, SIEX).
- **RD 47/2022** — Zonas Vulnerables a Nitratos (clasificación ZVN).
- **RD 1047/2022** — ecorregímenes PAC (herramienta FaST).

### Dependencias de código abierto

| Librería | Versión | Licencia |
|----------|---------|----------|
| Leaflet | 1.9.4 | BSD-2-Clause |
| @geoman-io/leaflet-geoman-free | 2.19.3 | MIT |
| @turf/* | 7.x | MIT |
| jsPDF | 4.x | MIT |
| jsPDF-AutoTable | 5.x | MIT |
| SheetJS (xlsx) | 0.18.5 | Apache-2.0 |
| React | 18.x | MIT |
| Vite | 5.x | MIT |

---

## Referencia académica

El motor FertiliCalc en el que se basa la API Sativum está descrito en:

> Villalobos, F. J., Delgado, A., López-Bernal, Á. & Quemada, M. (2020). *FertiliCalc: A Decision Support System for Fertilizer Management*. International Journal of Plant Production, 14, 299–308. https://doi.org/10.1007/s42106-019-00085-1

La metodología agronómica de base se desarrolla en:

> Villalobos, F. J. & Fereres, E. (Eds.) (2017). *Fitotecnia: principios de agronomía para una agricultura sostenible*. Madrid: Ediciones Mundi-Prensa. ISBN: 978-84-8476-524-0.

Si utilizas FertiPRO en un contexto técnico, cita también el servicio:

> ITACyL — Instituto Tecnológico Agrario de Castilla y León (2024). *Sativum: servicios digitales para la nutrición de cultivos*. [https://www.sativum.es](https://www.sativum.es)

---

## Licencia del proyecto

El código fuente de FertiPRO es propiedad de **VisualNacert**. Todos los derechos reservados.

Los datos y servicios externos usados por la aplicación están sujetos a sus propias condiciones de uso, detalladas en la sección anterior.
