// =========================================================================
//  PWA CHAGAS — CAPTURA DE VIVIENDAS  (v6)
//  Cambios vs v5:
//    - App exclusiva Chagas (se elimina el select de "Tipo de registro")
//    - Nueva pantalla de "Inicio de operativo" (Localidad + Zona + T. Efector)
//      con persistencia en localStorage y botón "Cambiar" en la user-bar
//    - Formulario extendido con 5 bloques colapsables:
//        1) Vivienda y responsable (obligatorio)
//        2) Evaluación entomológica
//        3) Habitantes y características
//        4) Animales domiciliarios
//        5) Captura entomológica parasitológica
//    - 3 dropdowns dinámicos desde CEREBRO: Estado vivienda (AC),
//      Especie (AE), Insecticida Tipo (AG) — con cache offline en localStorage
//    - Derivación silenciosa de TI_PRES_* (Sí/No) desde TI_HH_* al guardar
//    - IndexedDB v2 con nuevo store `viviendas` (el store viejo `puntos`
//      queda inerte; el operario reinstala la PWA como es la convención al
//      bumpear CACHE_VERSION)
//    - Nombre del efector = usuario logueado (sesion.nombre)
// =========================================================================


// ---------- 1. CONFIGURACIÓN ----------
const CONFIG = {
  // OJO: la URL del backend cambia con el nuevo apps_script_puntos_v3.gs
  // (por hacer). Actualizar cuando esté desplegado.
  endpointSync: "https://script.google.com/macros/s/AKfycby3WVXt7GQCuubD2UeBRfQPD4uktNq8e0_7KF2oqYP3s3jdts-8-OkiVC2bMSwWEScYsA/exec",
  secret: "AKfycby3WVXt7GQCuubD2UeBRfQPD4uktNq8e0_7KF2oqYP3s3jdts-8-OkiVC2bMSwWEScYsA",
  dbName: "capturaPuntosPWA",
  dbVersion: 3,
  storeName: "viviendas",
  timeoutGps: 30000,
  cacheEstadosKey: "cacheEstadosVivienda",
  cacheEspeciesKey: "cacheEspecies",
  cacheInsecticidasKey: "cacheInsecticidas",
  sesionKey: "sesionActiva",
  operativoKey: "operativoActivo",
  usuariosKey: "usuariosConocidos",
  mapaCentroDefault: [-28.5, -58.0],
  mapaZoomDefault: 8,
  mapaZoomGps: 17
};

// ---------- 2. ESTADO ----------
let db = null;
let mapa = null;
let marcadorOperario = null;
let circuloPrecision = null;
let marcadorPunto = null;
let grupoPuntosGuardados = null;
let ultimoFix = null;
let ubicacionOperario = null;
let sesion = null;
let operativo = null;                 // { localidad, zona, tEfector, fechaInicio }
let modoColocacion = false;
let uuidEditando = null;              // si != null, estamos editando esa vivienda
let fotoPendiente = null;             // Blob de foto capturada pero aún no guardada
let filtroMunicipio = true;           // true = solo del municipio actual; false = todas

// ---------- 3. INICIALIZACIÓN ----------
document.addEventListener("DOMContentLoaded", async () => {
  await abrirDB();
  registrarSW();
  wireUI();
  actualizarEstadoConexion();

  sesion = leerSesion();
  operativo = leerOperativo();

  if (sesion && sesion.estado === "APROBADO") {
    if (operativo) {
      entrarAApp();
    } else {
      mostrarPantallaOperativo(false);
    }
  } else {
    mostrarLogin();
  }

  window.addEventListener("online", () => {
    actualizarEstadoConexion();
    actualizarAvisoConexionLogin();
    if (sesion && sesion.estado === "APROBADO" && operativo) {
      toast("Conexión recuperada — sincronizando...");
      sincronizar();
      cargarDropdowns();
    }
  });
  window.addEventListener("offline", () => {
    actualizarEstadoConexion();
    actualizarAvisoConexionLogin();
  });
});

// ==========================================================================
//                           GESTIÓN DE SESIÓN
// ==========================================================================

function leerSesion() {
  try { return JSON.parse(localStorage.getItem(CONFIG.sesionKey) || "null"); }
  catch (e) { return null; }
}
function guardarSesion(s) {
  localStorage.setItem(CONFIG.sesionKey, JSON.stringify(s));
  sesion = s;
}
function borrarSesion() {
  localStorage.removeItem(CONFIG.sesionKey);
  sesion = null;
}
function leerUsuariosConocidos() {
  try { return JSON.parse(localStorage.getItem(CONFIG.usuariosKey) || "{}"); }
  catch (e) { return {}; }
}
function recordarUsuario(correo, nombre, estado) {
  const conocidos = leerUsuariosConocidos();
  conocidos[correo.toLowerCase()] = { nombre, estado, ultimoLogin: new Date().toISOString() };
  localStorage.setItem(CONFIG.usuariosKey, JSON.stringify(conocidos));
}

// ==========================================================================
//                           OPERATIVO ACTIVO
// ==========================================================================

function leerOperativo() {
  try { return JSON.parse(localStorage.getItem(CONFIG.operativoKey) || "null"); }
  catch (e) { return null; }
}
function guardarOperativo(o) {
  localStorage.setItem(CONFIG.operativoKey, JSON.stringify(o));
  operativo = o;
}
function borrarOperativo() {
  localStorage.removeItem(CONFIG.operativoKey);
  operativo = null;
}

function mostrarPantallaOperativo(esEdicion) {
  document.getElementById("authScreen").classList.add("hidden");
  document.getElementById("operativoScreen").classList.remove("hidden");
  document.getElementById("userBar").classList.add("hidden");
  document.getElementById("mainApp").classList.add("hidden");
  document.getElementById("operativoTitulo").textContent =
    esEdicion ? "Cambiar operativo" : "Inicio de operativo";

  // Nombre del efector = usuario logueado
  document.getElementById("opNombreEfector").textContent =
    (sesion && (sesion.nombre || sesion.correo)) || "—";

  // Precargar valores si estamos editando
  if (esEdicion && operativo) {
    document.getElementById("opLocalidad").value = operativo.localidad || "";
    document.getElementById("opZona").value = operativo.zona || "";
    document.getElementById("opTEfector").value = operativo.tEfector || "";
    document.getElementById("linkCancelarOperativo").classList.remove("hidden");
  } else {
    document.getElementById("opLocalidad").value = "";
    document.getElementById("opZona").value = "";
    document.getElementById("opTEfector").value = "";
    document.getElementById("linkCancelarOperativo").classList.add("hidden");
  }
}

function confirmarOperativo() {
  const localidad = document.getElementById("opLocalidad").value.trim();
  const zona = document.getElementById("opZona").value;
  const tEfector = document.getElementById("opTEfector").value;

  if (!localidad)       { toast("Ingresá la localidad"); return; }
  if (!zona)            { toast("Elegí la zona"); return; }
  if (!tEfector)        { toast("Elegí el tipo de efector"); return; }
  if (!sesion || !sesion.nombre) { toast("Sesión inválida — reingresá"); mostrarLogin(); return; }

  guardarOperativo({
    localidad,
    zona,
    tEfector,
    nombreEfector: sesion.nombre,
    fechaInicio: new Date().toISOString()
  });

  document.getElementById("operativoScreen").classList.add("hidden");
  toast(`Operativo iniciado en ${localidad}`);
  entrarAApp();
}

function cancelarCambioOperativo() {
  if (!operativo) return;   // no había uno previo, no se puede cancelar
  document.getElementById("operativoScreen").classList.add("hidden");
  entrarAApp();
}

function actualizarChipOperativo() {
  if (!operativo) return;
  document.getElementById("chipLocalidad").textContent = operativo.localidad || "—";
  document.getElementById("chipZona").textContent = operativo.zona || "—";
  document.getElementById("chipTEfector").textContent = operativo.tEfector || "—";
}

// ==========================================================================
//                           LOGIN / REGISTRO
// ==========================================================================

function mostrarLogin() {
  document.getElementById("authScreen").classList.remove("hidden");
  document.getElementById("operativoScreen").classList.add("hidden");
  document.getElementById("userBar").classList.add("hidden");
  document.getElementById("mainApp").classList.add("hidden");
  document.getElementById("formLogin").classList.remove("hidden");
  document.getElementById("formRegister").classList.add("hidden");
  document.getElementById("authTitulo").textContent = "Ingreso al sistema";
  actualizarAvisoConexionLogin();
}

function mostrarRegistro() {
  document.getElementById("formLogin").classList.add("hidden");
  document.getElementById("formRegister").classList.remove("hidden");
  document.getElementById("authTitulo").textContent = "Solicitud de registro";
}

function actualizarAvisoConexionLogin() {
  const div = document.getElementById("authConexionMsg");
  if (!div) return;
  if (!navigator.onLine) {
    div.className = "auth-warn";
    div.innerHTML = "⚠ Sin conexión. Sólo podés ingresar con un correo que ya haya iniciado sesión antes en este dispositivo.";
  } else {
    div.className = "";
    div.innerHTML = "";
  }
}

function entrarAApp() {
  document.getElementById("authScreen").classList.add("hidden");
  document.getElementById("operativoScreen").classList.add("hidden");
  document.getElementById("userBar").classList.remove("hidden");
  document.getElementById("mainApp").classList.remove("hidden");
  document.getElementById("userName").textContent = sesion.nombre || sesion.correo;
  actualizarChipOperativo();
  renderizarLista();
  cargarDropdowns();
  inicializarMapa();
  refrescarUbicacionGps();
  if (navigator.onLine) sincronizar();
}

async function intentarLogin() {
  const correoInput = document.getElementById("loginCorreo").value.trim().toLowerCase();
  if (!correoInput || !validarEmail(correoInput)) { toast("Ingresá un correo válido"); return; }

  const btn = document.getElementById("btnLogin");
  btn.disabled = true;
  btn.textContent = "Ingresando...";

  try {
    if (navigator.onLine && !CONFIG.endpointSync.includes("PEGAR_URL")) {
      const url = CONFIG.endpointSync + "?action=login&correo=" + encodeURIComponent(correoInput);
      const res = await fetch(url);
      const json = await res.json();

      if (json.ok && json.estado === "APROBADO") {
        recordarUsuario(correoInput, json.nombre, "APROBADO");
        guardarSesion({ correo: correoInput, nombre: json.nombre, estado: "APROBADO", fechaLogin: new Date().toISOString() });
        toast("Bienvenido/a " + json.nombre);
        if (operativo) entrarAApp();
        else           mostrarPantallaOperativo(false);
        return;
      }
      if (json.estado === "PENDIENTE") { toast("Tu cuenta está pendiente de aprobación"); return; }
      if (json.estado === "RECHAZADO") { toast("Tu cuenta fue rechazada. Contactá al administrador"); return; }
      if (json.error === "no_encontrado") { toast("Ese correo no está registrado. Registrate primero."); return; }
      toast("Error: " + (json.error || "desconocido"));
      return;
    }

    const conocidos = leerUsuariosConocidos();
    const usr = conocidos[correoInput];
    if (usr && usr.estado === "APROBADO") {
      guardarSesion({ correo: correoInput, nombre: usr.nombre, estado: "APROBADO", fechaLogin: new Date().toISOString() });
      toast("Bienvenido/a " + usr.nombre + " (modo offline)");
      if (operativo) entrarAApp();
      else           mostrarPantallaOperativo(false);
    } else {
      toast("Sin conexión: no se puede validar este correo");
    }
  } catch (e) {
    toast("Error de red: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Ingresar";
  }
}

async function intentarRegistro() {
  const correo = document.getElementById("regCorreo").value.trim().toLowerCase();
  const nombre = document.getElementById("regNombre").value.trim();

  if (!validarEmail(correo)) { toast("Ingresá un correo válido"); return; }
  if (nombre.length < 3)     { toast("Ingresá tu nombre completo"); return; }
  if (!navigator.onLine)     { toast("Necesitás conexión para registrarte"); return; }
  if (CONFIG.endpointSync.includes("PEGAR_URL")) { toast("⚠ Falta configurar la URL"); return; }

  const btn = document.getElementById("btnRegister");
  btn.disabled = true;
  btn.textContent = "Enviando...";

  try {
    const res = await fetch(CONFIG.endpointSync, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "register_user", secret: CONFIG.secret, data: { correo, nombre } })
    });
    const json = await res.json();

    if (json.ok) {
      toast("Solicitud enviada. Te avisamos cuando esté aprobada.");
      document.getElementById("regCorreo").value = "";
      document.getElementById("regNombre").value = "";
      setTimeout(() => {
        document.getElementById("formRegister").classList.add("hidden");
        document.getElementById("formLogin").classList.remove("hidden");
        document.getElementById("authTitulo").textContent = "Ingreso al sistema";
        document.getElementById("loginCorreo").value = correo;
      }, 1500);
    } else if (json.error === "ya_registrado") {
      toast("Ese correo ya está registrado. Intentá ingresar.");
    } else {
      toast("Error: " + (json.error || "desconocido"));
    }
  } catch (e) {
    toast("Error de red: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Enviar solicitud";
  }
}

function cerrarSesion() {
  if (!confirm("¿Cerrar sesión? Las viviendas pendientes quedan guardadas hasta el próximo ingreso. El operativo activo también.")) return;
  borrarSesion();
  document.getElementById("loginCorreo").value = "";
  if (mapa) { mapa.remove(); mapa = null; }
  marcadorOperario = null; circuloPrecision = null; marcadorPunto = null;
  grupoPuntosGuardados = null; ubicacionOperario = null; ultimoFix = null;
  modoColocacion = false;
  mostrarLogin();
  toast("Sesión cerrada");
}

function validarEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

// ==========================================================================
//                           INDEXED DB  (v2)
// ==========================================================================

function abrirDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(CONFIG.storeName)) {
        const store = d.createObjectStore(CONFIG.storeName, { keyPath: "uuid" });
        store.createIndex("estado", "estado");
        store.createIndex("fecha", "fecha");
      }
      // El store viejo `puntos` (v1) se deja inerte; el operario reinstala.
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}
function txStore(mode = "readonly") { return db.transaction(CONFIG.storeName, mode).objectStore(CONFIG.storeName); }
function guardarEnDB(v)  { return new Promise((res, rej) => { const r = txStore("readwrite").put(v);  r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
function listarPuntos()  { return new Promise((res, rej) => { const r = txStore().getAll();          r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); }
function borrarPunto(uuid){ return new Promise((res, rej) => { const r = txStore("readwrite").delete(uuid); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }

// ==========================================================================
//                       CARGA DE DROPDOWNS DESDE CEREBRO
// ==========================================================================

async function cargarDropdowns() {
  // 1) hidratar desde cache local (funciona offline)
  aplicarCache(CONFIG.cacheEstadosKey,       "estadoVivienda",  "-- Elegir --");
  aplicarCache(CONFIG.cacheEspeciesKey,      "otraEspecie",     "-- Ninguna --");
  aplicarCache(CONFIG.cacheInsecticidasKey,  "insecticidaTipo", "-- Ninguno --");

  if (!navigator.onLine) { toast("Dropdowns: sin conexión, uso cache"); return; }
  if (CONFIG.endpointSync.includes("PEGAR_URL")) { toast("⚠ Falta configurar la URL del backend"); return; }

  // 2) refrescar desde el backend en paralelo (no bloquea la UI)
  try {
    const url = CONFIG.endpointSync + "?action=list_dropdowns&_ts=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) { toast("Dropdowns: HTTP " + res.status); return; }
    const txt = await res.text();
    let json;
    try { json = JSON.parse(txt); }
    catch (eParse) {
      toast("Dropdowns: respuesta no es JSON — revisá permisos del deploy");
      console.error("Respuesta cruda del backend:", txt.substring(0, 500));
      return;
    }
    if (!json.ok) { toast("Dropdowns: " + (json.error || "backend devolvió !ok")); return; }

    let nE = 0, nEs = 0, nI = 0;
    if (Array.isArray(json.estados)) {
      localStorage.setItem(CONFIG.cacheEstadosKey, JSON.stringify(json.estados));
      poblarSelect("estadoVivienda", json.estados, "-- Elegir --");
      nE = json.estados.length;
    }
    if (Array.isArray(json.especies)) {
      localStorage.setItem(CONFIG.cacheEspeciesKey, JSON.stringify(json.especies));
      poblarSelect("otraEspecie", json.especies, "-- Ninguna --");
      nEs = json.especies.length;
    }
    if (Array.isArray(json.insecticidas)) {
      localStorage.setItem(CONFIG.cacheInsecticidasKey, JSON.stringify(json.insecticidas));
      poblarSelect("insecticidaTipo", json.insecticidas, "-- Ninguno --");
      nI = json.insecticidas.length;
    }
    toast(`Dropdowns OK: ${nE} estados, ${nEs} especies, ${nI} insecticidas`);
  } catch (e) {
    toast("Dropdowns: " + e.message);
    console.warn("cargarDropdowns error:", e);
  }
}

function aplicarCache(cacheKey, selectId, placeholder) {
  const cache = localStorage.getItem(cacheKey);
  if (!cache) return;
  try { poblarSelect(selectId, JSON.parse(cache), placeholder); } catch (e) {}
}

function poblarSelect(selectId, valores, placeholder) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const actual = sel.value;
  if (!valores || valores.length === 0) {
    sel.innerHTML = `<option value="">-- Sin datos (conectate una vez) --</option>`;
    return;
  }
  sel.innerHTML =
    `<option value="">${placeholder}</option>` +
    valores.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  if (actual && valores.includes(actual)) sel.value = actual;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// ==========================================================================
//                           MAPA
// ==========================================================================

function inicializarMapa() {
  if (mapa) return;

  mapa = L.map("mapa", { zoomControl: true }).setView(CONFIG.mapaCentroDefault, CONFIG.mapaZoomDefault);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OSM"
  }).addTo(mapa);

  L.geoJSON(POLIGONOS, {
    style: { color: "#1F4A8B", weight: 1.5, fillOpacity: 0.05, opacity: 0.6 }
  }).addTo(mapa);

  grupoPuntosGuardados = L.layerGroup().addTo(mapa);

  mapa.on("click", (e) => {
    if (!modoColocacion) return;
    colocarPuntoEnMapa(e.latlng.lat, e.latlng.lng, "mapa");
    desactivarModoColocacion();
  });

  setTimeout(() => mapa.invalidateSize(), 200);
  pintarPuntosGuardados();
}

function activarModoColocacion() {
  modoColocacion = true;
  const btn = document.getElementById("btnColocarPunto");
  btn.classList.remove("btn-primary");
  btn.classList.add("btn-colocando");
  btn.innerHTML = "❌ Cancelar colocación";
  document.getElementById("mapa").classList.add("modo-colocando");
  toast("Ahora tocá el mapa donde va el punto");
}

function desactivarModoColocacion() {
  modoColocacion = false;
  const btn = document.getElementById("btnColocarPunto");
  btn.classList.remove("btn-colocando");
  btn.classList.add("btn-primary");
  btn.innerHTML = "📍 Colocar punto";
  document.getElementById("mapa").classList.remove("modo-colocando");
}

function toggleModoColocacion() {
  if (modoColocacion) desactivarModoColocacion();
  else                activarModoColocacion();
}

function refrescarUbicacionGps() {
  const btn = document.getElementById("btnRefrescarGps");
  if (!navigator.geolocation) { toast("Este dispositivo no soporta geolocalización"); return; }
  if (btn) { btn.disabled = true; btn.textContent = "🔄 Buscando..."; }
  toast("Buscando señal GPS...");

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lng, accuracy: prec } = pos.coords;
      ubicacionOperario = { lat, lng, precision: prec };
      pintarUbicacionOperario();
      mapa.setView([lat, lng], CONFIG.mapaZoomGps);
      if (btn) { btn.disabled = false; btn.textContent = "🔄 Refrescar"; }
      toast("Ubicación actualizada (precisión: " + prec.toFixed(0) + " m)");
    },
    (err) => {
      if (btn) { btn.disabled = false; btn.textContent = "🔄 Refrescar"; }
      let msg = "Error de GPS: ";
      if      (err.code === 1) msg += "permiso denegado";
      else if (err.code === 2) msg += "posición no disponible";
      else if (err.code === 3) msg += "tiempo de espera agotado";
      else                     msg += err.message;
      toast(msg);
    },
    { enableHighAccuracy: true, timeout: CONFIG.timeoutGps, maximumAge: 0 }
  );
}

function pintarUbicacionOperario() {
  if (!ubicacionOperario || !mapa) return;
  const { lat, lng, precision } = ubicacionOperario;
  if (marcadorOperario) mapa.removeLayer(marcadorOperario);
  if (circuloPrecision) mapa.removeLayer(circuloPrecision);
  circuloPrecision = L.circle([lat, lng], {
    radius: precision, color: "#4285F4", fillColor: "#4285F4", fillOpacity: 0.1, weight: 1
  }).addTo(mapa);
  const icon = L.divIcon({
    className: "", html: '<div class="marker-operario"></div>',
    iconSize: [18, 18], iconAnchor: [9, 9]
  });
  marcadorOperario = L.marker([lat, lng], { icon: icon, interactive: false }).addTo(mapa);
}

function usarUbicacionComoPunto() {
  if (!ubicacionOperario) { toast("Todavía no hay ubicación GPS. Tocá 'Refrescar' primero."); return; }
  const { lat, lng, precision } = ubicacionOperario;
  colocarPuntoEnMapa(lat, lng, "gps", precision);
}

function colocarPuntoEnMapa(lat, lng, fuente, precision) {
  if (marcadorPunto) mapa.removeLayer(marcadorPunto);
  marcadorPunto = L.circleMarker([lat, lng], {
    radius: 10, color: "#1F4A8B", fillColor: "#1F4A8B", fillOpacity: 0.85, weight: 3
  }).addTo(mapa);
  marcadorPunto.bindTooltip("Nueva vivienda (sin guardar)", {
    direction: "top", offset: [0, -8], permanent: false
  });
  procesarFix(lat, lng, precision !== undefined ? precision : null, fuente);
}

function quitarPuntoDelMapa() {
  if (marcadorPunto && mapa) { mapa.removeLayer(marcadorPunto); marcadorPunto = null; }
}

function detectarUbicacion(lat, lng) {
  try {
    if (typeof POLIGONOS === "undefined" || !POLIGONOS || !POLIGONOS.features) {
      console.warn("POLIGONOS no cargó o formato inesperado");
      return null;
    }
    const punto = turf.point([lng, lat]);
    for (const feat of POLIGONOS.features) {
      try {
        if (turf.booleanPointInPolygon(punto, feat)) {
          return { depto: feat.properties.depto, muni: feat.properties.muni };
        }
      } catch (eFeat) { /* polígono suelto roto, seguimos con el siguiente */ }
    }
    return null;
  } catch (e) {
    console.warn("detectarUbicacion falló:", e);
    return null;
  }
}

// ==========================================================================
//              PINTAR PUNTOS GUARDADOS EN EL MAPA (con tooltip)
// ==========================================================================

async function pintarPuntosGuardados() {
  if (!mapa || !grupoPuntosGuardados) return;
  grupoPuntosGuardados.clearLayers();

  const puntos = await listarPuntos();
  puntos.forEach(p => {
    if (!p.lat || !p.lng) return;

    const color = p.estado === "sincronizado" ? "#719C29"
                : p.estado === "error"        ? "#F4492E"
                : "#FAAE05";

    const marker = L.circleMarker([p.lat, p.lng], {
      radius: 6, color: color, fillColor: color, fillOpacity: 0.75, weight: 2
    });

    const nvi = p.nroVivienda ? `N° ${escapeHtml(p.nroVivienda)}` : "Sin N°";
    const resp = p.apellidoNombres ? escapeHtml(p.apellidoNombres) : "";
    const est = p.estadoVivienda ? `<em>${escapeHtml(p.estadoVivienda)}</em>` : "";
    const info = `<strong>${nvi}</strong>` +
                 (resp ? `<br>${resp}` : "") +
                 (est  ? `<br>${est}`  : "");
    marker.bindTooltip(info, { direction: "top", offset: [0, -6], permanent: false, opacity: 0.95 });

    marker.addTo(grupoPuntosGuardados);
  });
}

// ==========================================================================
//                       PROCESAMIENTO DEL PUNTO
// ==========================================================================

function procesarFix(lat, lng, precision, fuente) {
  document.getElementById("coordBox").classList.remove("hidden");
  document.getElementById("txtLat").textContent = lat.toFixed(6);
  document.getElementById("txtLng").textContent = lng.toFixed(6);

  const precEl = document.getElementById("txtPrec");
  if (precision !== null && precision !== undefined) {
    precEl.textContent = precision.toFixed(1) + " m";
    precEl.className = precision < 10 ? "precision-ok" : precision < 30 ? "precision-warn" : "precision-mala";
  } else {
    precEl.textContent = "(marcado en el mapa)";
    precEl.className = "";
  }

  let detectado = null;
  try { detectado = detectarUbicacion(lat, lng); } catch (e) { console.warn("procesarFix detectarUbicacion:", e); }
  const detectBox = document.getElementById("ubicacionDetectada");
  detectBox.classList.remove("hidden", "fuera-corrientes");

  if (detectado) {
    detectBox.innerHTML = `<div><strong>Departamento:</strong> ${escapeHtml(detectado.depto)}</div>
                           <div><strong>Municipio:</strong> ${escapeHtml(detectado.muni)}</div>`;
    ultimoFix = { lat, lng, precision, fuente, ...detectado };
  } else {
    detectBox.classList.add("fuera-corrientes");
    detectBox.innerHTML = `<div><strong>⚠ Sin detección automática de depto/municipio.</strong></div>
                           <div style="font-size: 13px; margin-top: 4px;">Se guardará sin esos campos — completalos manualmente en el Sheet si hace falta.</div>`;
    ultimoFix = { lat, lng, precision, fuente, depto: null, muni: null };
  }

  document.getElementById("formulario").classList.remove("hidden");
  document.getElementById("formulario").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => document.getElementById("nroVivienda").focus(), 300);
}

// ==========================================================================
//                     GUARDAR VIVIENDA + SINCRONIZAR
// ==========================================================================

// Helper: lee el valor del input, retorna "" si vacío o número como string si válido.
function n(id) {
  const v = (document.getElementById(id).value || "").trim();
  if (v === "") return "";
  return /^\d+$/.test(v) ? v : "";
}
// Helper: lee texto libre / valor del select
function t(id) { return (document.getElementById(id).value || "").trim(); }

// Deriva Sí / No / "" desde un conteo string
function derivarPresencia(conteoStr) {
  if (conteoStr === "" || conteoStr === null || conteoStr === undefined) return "";
  const n = parseInt(conteoStr, 10);
  if (isNaN(n)) return "";
  return n > 0 ? "Sí" : "No";
}

async function guardarVivienda() {
  if (!ultimoFix) { toast("Primero marcá un punto en el mapa"); return; }
  if (!sesion)    { toast("Sesión inválida — reingresá"); mostrarLogin(); return; }
  if (!operativo) { toast("No hay operativo activo"); mostrarPantallaOperativo(false); return; }

  // Validación de campos obligatorios
  const nroVivienda = t("nroVivienda");
  if (!nroVivienda)              { toast("Falta el N° de vivienda"); expandirBloque(0); return; }
  if (!/^\d+$/.test(nroVivienda)){ toast("El N° de vivienda debe ser solo números"); expandirBloque(0); return; }

  const apellidoNombres = t("apellidoNombres");
  if (apellidoNombres.length < 3){ toast("Falta el nombre del responsable"); expandirBloque(0); return; }

  const dni = t("dni");
  if (dni && !/^\d{6,10}$/.test(dni)) { toast("El DNI debe ser numérico (6-10 dígitos)"); expandirBloque(0); return; }

  const estadoVivienda = t("estadoVivienda");
  if (!estadoVivienda) { toast("Elegí el estado de la vivienda"); expandirBloque(0); return; }

  // Conteos T. infestans H/H (dejan derivar presencia)
  const tiHhIdAd = n("tiHhIdAd");
  const tiHhIdN  = n("tiHhIdN");
  const tiHhPdAd = n("tiHhPdAd");
  const tiHhPdN  = n("tiHhPdN");

  // Si estamos editando, mantenemos el uuid original; si es nueva, generamos uno.
  const esEdicion = !!uuidEditando;
  const uuid = esEdicion ? uuidEditando : crypto.randomUUID();

  // Si estamos editando, buscamos la vivienda previa para conservar campos
  // internos (por ejemplo fotoUrl ya subida, fecha original, etc.)
  let previa = null;
  if (esEdicion) {
    const puntos = await listarPuntos();
    previa = puntos.find(p => p.uuid === uuid) || null;
  }

  const vivienda = {
    uuid: uuid,
    fecha: previa ? previa.fecha : new Date().toISOString(),
    estado: "pendiente",

    // --- Metadata del operativo (snapshot al momento de guardar) ---
    departamento:   ultimoFix.depto || "",
    municipio:      ultimoFix.muni || "",
    localidad:      operativo.localidad,
    zona:           operativo.zona,
    tEfector:       operativo.tEfector,
    nombreEfector:  operativo.nombreEfector || sesion.nombre,

    // --- Bloque vivienda + responsable ---
    nroVivienda:     nroVivienda,
    apellidoNombres: apellidoNombres,
    dni:             dni,
    fechaCampo:      new Date().toISOString().slice(0, 10),  // YYYY-MM-DD
    estadoVivienda:  estadoVivienda,

    // --- Evaluación entomológica ---
    tiHhIdAd, tiHhIdN, tiHhPdAd, tiHhPdN,
    tiPresIdAd: derivarPresencia(tiHhIdAd),
    tiPresIdN:  derivarPresencia(tiHhIdN),
    tiPresPdAd: derivarPresencia(tiHhPdAd),
    tiPresPdN:  derivarPresencia(tiHhPdN),
    otraEspecie:      t("otraEspecie"),
    otraEspId:        n("otraEspId"),
    otraEspPd:        n("otraEspPd"),
    insecticidaTipo:  t("insecticidaTipo"),
    insecticidaCant:  n("insecticidaCant"),

    // --- Habitantes + características ---
    hab04:              n("hab04"),
    hab519:             n("hab519"),
    habTotal:           n("habTotal"),
    techoColonizable:   t("techoColonizable"),
    paredColonizable:   t("paredColonizable"),

    // --- Animales domiciliarios ---
    animPerros:      n("animPerros"),
    animGatos:       n("animGatos"),
    animGallinas:    n("animGallinas"),
    animCabras:      n("animCabras"),
    gallinero:       t("gallinero"),
    corral:          t("corral"),
    otrasEstrAnimal: t("otrasEstrAnimal"),
    otrasEstrCant:   n("otrasEstrCant"),

    // --- Captura entomológica parasitológica ---
    capturaNInsectos: n("capturaNInsectos"),
    tcruziIdNeg: n("tcruziIdNeg"),
    tcruziIdPos: n("tcruziIdPos"),
    tcruziPdNeg: n("tcruziPdNeg"),
    tcruziPdPos: n("tcruziPdPos"),

    // --- Geo ---
    lat: ultimoFix.lat,
    lng: ultimoFix.lng,
    precision: ultimoFix.precision,
    fuente: ultimoFix.fuente,

    // --- Trazabilidad ---
    opCorreo: sesion.correo,
    opNombre: sesion.nombre,

    // --- Foto (Blob local para sync, URL final tras subir) ---
    fotoBlob: fotoPendiente || (previa && previa.fotoBlob) || null,
    fotoUrl:  (fotoPendiente ? "" : (previa && previa.fotoUrl) || ""),

    // --- Flag interno: si editamos una vivienda que ya estaba sincronizada,
    // el sync tiene que llamar a update_vivienda en vez de insert_vivienda.
    _operacion: (previa && previa.estado === "sincronizado") ? "update" : "insert"
  };

  await guardarEnDB(vivienda);
  toast(esEdicion ? "Cambios guardados ✓" : "Vivienda guardada localmente ✓");

  limpiarFormulario();
  document.getElementById("formulario").classList.add("hidden");
  document.getElementById("coordBox").classList.add("hidden");
  document.getElementById("ubicacionDetectada").classList.add("hidden");
  document.getElementById("btnGuardar").innerHTML = "💾 Guardar vivienda";
  quitarPuntoDelMapa();
  ultimoFix = null;
  uuidEditando = null;
  fotoPendiente = null;
  quitarFoto();

  await renderizarLista();
  await pintarPuntosGuardados();
  if (navigator.onLine) sincronizar();
}

function limpiarFormulario() {
  const ids = [
    "nroVivienda", "apellidoNombres", "dni", "estadoVivienda",
    "tiHhIdAd", "tiHhIdN", "tiHhPdAd", "tiHhPdN",
    "otraEspecie", "otraEspId", "otraEspPd",
    "insecticidaTipo", "insecticidaCant",
    "hab04", "hab519", "habTotal",
    "techoColonizable", "paredColonizable",
    "animPerros", "animGatos", "animGallinas", "animCabras",
    "gallinero", "corral", "otrasEstrAnimal", "otrasEstrCant",
    "capturaNInsectos",
    "tcruziIdNeg", "tcruziIdPos", "tcruziPdNeg", "tcruziPdPos"
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  // Colapsar los bloques opcionales, dejar el obligatorio abierto
  const bloques = document.querySelectorAll("#formulario details.bloque");
  bloques.forEach((b, i) => { b.open = (i === 0); });
}

function expandirBloque(indice) {
  const bloques = document.querySelectorAll("#formulario details.bloque");
  if (bloques[indice]) bloques[indice].open = true;
}

function cancelarFormulario() {
  if (!confirm("¿Descartar la carga de esta vivienda?")) return;
  limpiarFormulario();
  document.getElementById("formulario").classList.add("hidden");
  document.getElementById("coordBox").classList.add("hidden");
  document.getElementById("ubicacionDetectada").classList.add("hidden");
  quitarPuntoDelMapa();
  ultimoFix = null;
}

async function sincronizar() {
  if (!navigator.onLine) { toast("Sin conexión — se sincroniza cuando haya red"); return; }
  if (CONFIG.endpointSync.includes("PEGAR_URL")) { toast("⚠ Falta configurar la URL"); return; }

  const puntos = await listarPuntos();
  const pendientes = puntos.filter(p => p.estado === "pendiente" || p.estado === "error");
  if (pendientes.length === 0) { toast("Nada para sincronizar"); return; }

  toast(`Sincronizando ${pendientes.length} vivienda(s)...`);

  for (const v of pendientes) {
    try {
      // 1) Si la vivienda tiene foto local no subida, subimos primero a Drive
      if (v.fotoBlob && !v.fotoUrl) {
        try {
          const url = await subirFotoADrive(v.uuid, v.fotoBlob);
          v.fotoUrl = url;
          await guardarEnDB(v);   // persistimos la URL para no reintentar
        } catch (eFoto) {
          console.warn("Foto no pudo subirse, sigo con la vivienda:", eFoto);
          // No frenamos el sync de la vivienda por la foto; queda sin URL
          // y en el próximo sync se reintenta.
        }
      }

      // 2) Enviamos la fila. Excluimos campos internos (Blob no serializa bien y no va al backend)
      const { estado, errorMsg, fechaSync, fotoBlob, _operacion, ...payload } = v;

      const accion = (_operacion === "update") ? "update_vivienda" : "insert_vivienda";
      const res = await fetch(CONFIG.endpointSync, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: accion,
          secret: CONFIG.secret,
          data: payload
        })
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Error del servidor");
      v.estado = "sincronizado";
      v.fechaSync = new Date().toISOString();
      // Una vez sincronizada, liberamos el Blob de foto para ahorrar espacio en IndexedDB
      if (v.fotoUrl) v.fotoBlob = null;
      await guardarEnDB(v);
    } catch (e) {
      v.estado = "error";
      v.errorMsg = e.message;
      await guardarEnDB(v);
    }
  }
  await renderizarLista();
  await pintarPuntosGuardados();
  toast("Sincronización completada");
}

// ==========================================================================
//                       FOTO DE LA VIVIENDA
// ==========================================================================

async function seleccionarFoto(fileInput) {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  toast("Comprimiendo foto (" + Math.round(file.size / 1024) + " KB)...");
  try {
    const comprimida = await comprimirImagen(file, 1024, 0.6);
    fotoPendiente = comprimida;
    mostrarPreviewFoto(comprimida);
    toast("Foto lista (" + Math.round(comprimida.size / 1024) + " KB)");
  } catch (e) {
    toast("Error al procesar la foto: " + e.message);
    console.error(e);
  } finally {
    fileInput.value = "";  // reset para que se pueda re-seleccionar el mismo archivo
  }
}

// Comprime una imagen a JPEG. Usa createImageBitmap con resize cuando está
// disponible (mucho más eficiente en RAM — el navegador puede decodificar
// y redimensionar en un solo paso sin materializar el bitmap completo).
// Fallback a Image+canvas para navegadores viejos.
async function comprimirImagen(file, maxLado, calidad) {
  // Detectar si el navegador soporta createImageBitmap con opciones de resize
  const soportaBitmapResize = ("createImageBitmap" in window);

  if (soportaBitmapResize) {
    try {
      // Primer paso: obtener dimensiones originales (rápido, sin descomprimir todo)
      const bmpInicial = await createImageBitmap(file);
      const w0 = bmpInicial.width, h0 = bmpInicial.height;
      bmpInicial.close();

      const ratio = Math.min(1, maxLado / Math.max(w0, h0));
      const w = Math.round(w0 * ratio);
      const h = Math.round(h0 * ratio);

      // Segundo paso: crear bitmap ya redimensionado (aquí es donde se ahorra RAM)
      const bmp = await createImageBitmap(file, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: "high"
      });

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close();

      return await new Promise((res, rej) => {
        canvas.toBlob((blob) => blob ? res(blob) : rej(new Error("toBlob null")), "image/jpeg", calidad);
      });
    } catch (e) {
      console.warn("createImageBitmap falló, fallback a Image+canvas:", e);
      // sigue al fallback
    }
  }

  // Fallback (menos eficiente en RAM)
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(1, maxLado / Math.max(img.width, img.height));
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("toBlob null")), "image/jpeg", calidad);
      };
      img.onerror = () => reject(new Error("no se pudo cargar la imagen"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("no se pudo leer el archivo"));
    reader.readAsDataURL(file);
  });
}

function mostrarPreviewFoto(blob) {
  const preview = document.getElementById("fotoPreview");
  const contenedor = document.getElementById("fotoContenedor");
  if (!preview || !contenedor) return;
  preview.src = URL.createObjectURL(blob);
  contenedor.classList.remove("hidden");
}

function quitarFoto() {
  fotoPendiente = null;
  const preview = document.getElementById("fotoPreview");
  const contenedor = document.getElementById("fotoContenedor");
  if (preview) { URL.revokeObjectURL(preview.src); preview.src = ""; }
  if (contenedor) contenedor.classList.add("hidden");
  toast("Foto eliminada");
}

function blobABase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = r.result;
      const base64 = dataUrl.substring(dataUrl.indexOf(",") + 1);
      res(base64);
    };
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

async function subirFotoADrive(uuid, blob) {
  const base64 = await blobABase64(blob);
  const res = await fetch(CONFIG.endpointSync, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: "upload_foto",
      secret: CONFIG.secret,
      data: { uuid: uuid, base64: base64, mimeType: blob.type || "image/jpeg" }
    })
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "upload_foto falló");
  return json.url;
}

// ==========================================================================
//                       EDICIÓN DE VIVIENDAS PENDIENTES
// ==========================================================================

async function abrirVivienda(uuid) {
  const puntos = await listarPuntos();
  const v = puntos.find(p => p.uuid === uuid);
  if (!v) { toast("Vivienda no encontrada"); return; }

  uuidEditando = uuid;
  const eraSincronizada = v.estado === "sincronizado";

  // Precargar coordenadas (bloqueadas: el punto ya fue colocado)
  ultimoFix = { lat: v.lat, lng: v.lng, precision: v.precision, fuente: v.fuente || "editado", depto: v.departamento, muni: v.municipio };

  // Restaurar todos los campos del formulario
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = (val === null || val === undefined) ? "" : val; };
  setVal("nroVivienda", v.nroVivienda);
  setVal("apellidoNombres", v.apellidoNombres);
  setVal("dni", v.dni);
  setVal("estadoVivienda", v.estadoVivienda);
  setVal("tiHhIdAd", v.tiHhIdAd);   setVal("tiHhIdN", v.tiHhIdN);
  setVal("tiHhPdAd", v.tiHhPdAd);   setVal("tiHhPdN", v.tiHhPdN);
  setVal("otraEspecie", v.otraEspecie);
  setVal("otraEspId", v.otraEspId); setVal("otraEspPd", v.otraEspPd);
  setVal("insecticidaTipo", v.insecticidaTipo); setVal("insecticidaCant", v.insecticidaCant);
  setVal("hab04", v.hab04); setVal("hab519", v.hab519); setVal("habTotal", v.habTotal);
  setVal("techoColonizable", v.techoColonizable); setVal("paredColonizable", v.paredColonizable);
  setVal("animPerros", v.animPerros); setVal("animGatos", v.animGatos);
  setVal("animGallinas", v.animGallinas); setVal("animCabras", v.animCabras);
  setVal("gallinero", v.gallinero); setVal("corral", v.corral);
  setVal("otrasEstrAnimal", v.otrasEstrAnimal); setVal("otrasEstrCant", v.otrasEstrCant);
  setVal("capturaNInsectos", v.capturaNInsectos);
  setVal("tcruziIdNeg", v.tcruziIdNeg); setVal("tcruziIdPos", v.tcruziIdPos);
  setVal("tcruziPdNeg", v.tcruziPdNeg); setVal("tcruziPdPos", v.tcruziPdPos);

  // Restaurar foto si había una guardada localmente (Blob) o URL ya subida
  fotoPendiente = v.fotoBlob || null;
  if (v.fotoBlob) {
    mostrarPreviewFoto(v.fotoBlob);
  } else if (v.fotoUrl) {
    // Ya se subió a Drive — mostrar aviso, no preview
    document.getElementById("fotoContenedor").classList.remove("hidden");
    document.getElementById("fotoPreview").src = v.fotoUrl;
  } else {
    quitarFoto();
  }

  // Mostrar coord box + formulario, cambiar título del botón
  document.getElementById("coordBox").classList.remove("hidden");
  document.getElementById("txtLat").textContent = v.lat.toFixed(6);
  document.getElementById("txtLng").textContent = v.lng.toFixed(6);
  document.getElementById("txtPrec").textContent = v.precision ? v.precision.toFixed(1) + " m" : "-";
  document.getElementById("formulario").classList.remove("hidden");
  document.getElementById("btnGuardar").innerHTML = "💾 Guardar cambios";
  document.getElementById("formulario").scrollIntoView({ behavior: "smooth" });
  if (eraSincronizada) {
    toast("Editando vivienda ya cargada — los cambios sobrescriben la base al sincronizar");
  } else {
    toast("Editando vivienda N° " + (v.nroVivienda || ""));
  }
}

// ==========================================================================
//                       FILTRO POR MUNICIPIO ACTUAL
// ==========================================================================

function municipioActualOperario() {
  if (!ubicacionOperario) return null;
  const detectado = detectarUbicacion(ubicacionOperario.lat, ubicacionOperario.lng);
  return detectado ? detectado.muni : null;
}

function filtrarPorMunicipio(puntos) {
  if (!filtroMunicipio) return puntos;
  const muniActual = municipioActualOperario();
  if (!muniActual) return puntos;   // sin GPS → no filtramos
  return puntos.filter(p => p.municipio === muniActual);
}

function toggleFiltroMunicipio() {
  filtroMunicipio = !filtroMunicipio;
  const btn = document.getElementById("btnToggleFiltro");
  if (btn) btn.textContent = filtroMunicipio ? "🔍 Solo este municipio" : "🌐 Todas";
  renderizarLista();
}

async function renderizarLista() {
  const todosLosPuntos = await listarPuntos();
  todosLosPuntos.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

  const puntos = filtrarPorMunicipio(todosLosPuntos);
  const muniActual = municipioActualOperario();

  document.getElementById("contadorPuntos").textContent = puntos.length;
  const ul = document.getElementById("listaPendientes");
  const empty = document.getElementById("sinPuntos");
  const info = document.getElementById("filtroInfo");

  // Aviso arriba de la lista con el estado del filtro
  if (info) {
    if (filtroMunicipio && muniActual) {
      const oculto = todosLosPuntos.length - puntos.length;
      info.textContent = oculto > 0
        ? `Mostrando solo ${muniActual} (${oculto} de otros municipios ocultas)`
        : `Mostrando solo ${muniActual}`;
      info.classList.remove("hidden");
    } else if (filtroMunicipio && !muniActual) {
      info.textContent = "Sin GPS o fuera de cobertura — mostrando todas";
      info.classList.remove("hidden");
    } else {
      info.textContent = "Mostrando todas las viviendas";
      info.classList.remove("hidden");
    }
  }

  if (puntos.length === 0) { ul.innerHTML = ""; empty.style.display = "block"; return; }
  empty.style.display = "none";

  ul.innerHTML = puntos.map(p => {
    const dotClass = p.estado === "sincronizado" ? "status-sincronizado"
                   : p.estado === "error" ? "status-error" : "status-pendiente";
    const fecha = new Date(p.fecha).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const nvi  = p.nroVivienda ? `N° ${escapeHtml(p.nroVivienda)}` : "Sin N°";
    const resp = p.apellidoNombres ? ` — ${escapeHtml(p.apellidoNombres)}` : "";
    const est  = p.estadoVivienda ? ` · <em>${escapeHtml(p.estadoVivienda)}</em>` : "";
    const loc  = p.municipio ? escapeHtml(p.municipio) : "sin ubicación";
    const btnEditar = `<button style="width:auto;padding:6px 10px;font-size:12px;background:#eef4ff;color:#1F4A8B;margin-right:4px;" onclick="event.stopPropagation(); abrirVivienda('${p.uuid}')">✏️ Editar</button>`;
    return `
      <li>
        <div style="flex:1; min-width:0;">
          <span class="status-dot ${dotClass}"></span>
          <strong>${nvi}</strong>${resp}${est}<br>
          <small style="color:#666;">${loc} · ${fecha} · ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</small>
        </div>
        <div style="display:flex; gap:4px; align-items:center;">
          ${btnEditar}
          <button style="width:auto;padding:6px 10px;font-size:12px;background:#eee;color:#666;"
                  onclick="event.stopPropagation(); eliminarPunto('${p.uuid}')">✕</button>
        </div>
      </li>`;
  }).join("");
}

async function eliminarPunto(uuid) {
  const puntos = await listarPuntos();
  const v = puntos.find(p => p.uuid === uuid);
  if (!v) return;

  const yaEnSheet = v.estado === "sincronizado";

  // Confirmación distinta según sea o no una vivienda ya cargada en la base
  const msg = yaEnSheet
    ? "Esta vivienda ya está cargada en la base. Se va a marcar como ELIMINADA en el Sheet (queda como registro histórico) y se borra de tu lista local. ¿Continuar?"
    : "¿Eliminar esta vivienda de la cola local?";
  if (!confirm(msg)) return;

  // Si está en Sheet, necesitamos conexión para marcarla como eliminada allá.
  if (yaEnSheet) {
    if (!navigator.onLine) {
      toast("Necesitás conexión para eliminar viviendas ya cargadas al servidor");
      return;
    }
    try {
      const res = await fetch(CONFIG.endpointSync, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "marcar_eliminada",
          secret: CONFIG.secret,
          data: { uuid: uuid }
        })
      });
      const json = await res.json();
      if (!json.ok) {
        toast("No se pudo marcar como eliminada: " + (json.error || "desconocido"));
        return;
      }
    } catch (e) {
      toast("Error de red: " + e.message);
      return;
    }
  }

  await borrarPunto(uuid);
  await renderizarLista();
  await pintarPuntosGuardados();
  toast(yaEnSheet ? "Vivienda marcada como eliminada ✓" : "Vivienda eliminada");
}

// ==========================================================================
//                           UTILIDADES + WIRING
// ==========================================================================

function actualizarEstadoConexion() {
  const badge = document.getElementById("badgeConexion");
  if (navigator.onLine) { badge.textContent = "Online"; badge.className = "badge online"; }
  else                  { badge.textContent = "Offline"; badge.className = "badge offline"; }
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}

function registrarSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js")
      .then(() => console.log("SW registrado"))
      .catch(e => console.warn("SW error:", e));
  }
}

function wireUI() {
  // Login/registro
  document.getElementById("btnLogin").addEventListener("click", intentarLogin);
  document.getElementById("btnRegister").addEventListener("click", intentarRegistro);
  document.getElementById("linkRegister").addEventListener("click", mostrarRegistro);
  document.getElementById("linkLogin").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("formRegister").classList.add("hidden");
    document.getElementById("formLogin").classList.remove("hidden");
    document.getElementById("authTitulo").textContent = "Ingreso al sistema";
  });
  document.getElementById("btnLogout").addEventListener("click", cerrarSesion);

  // Operativo
  document.getElementById("btnGuardarOperativo").addEventListener("click", confirmarOperativo);
  document.getElementById("btnCambiarOperativo").addEventListener("click", () => mostrarPantallaOperativo(true));
  document.getElementById("linkCancelarOperativo").addEventListener("click", (e) => {
    e.preventDefault();
    cancelarCambioOperativo();
  });

  // App principal
  document.getElementById("btnColocarPunto").addEventListener("click", toggleModoColocacion);
  document.getElementById("btnUsarUbicacion").addEventListener("click", usarUbicacionComoPunto);
  document.getElementById("btnRefrescarGps").addEventListener("click", refrescarUbicacionGps);
  document.getElementById("btnGuardar").addEventListener("click", guardarVivienda);
  document.getElementById("btnCancelarForm").addEventListener("click", cancelarFormulario);
  document.getElementById("btnSincronizar").addEventListener("click", sincronizar);

  // Foto (solo desde galería)
  const fotoInput = document.getElementById("fotoInput");
  if (fotoInput) fotoInput.addEventListener("change", () => seleccionarFoto(fotoInput));
  const btnFoto = document.getElementById("btnAdjuntarFoto");
  if (btnFoto) btnFoto.addEventListener("click", () => fotoInput.click());
  const btnQuitarFoto = document.getElementById("btnQuitarFoto");
  if (btnQuitarFoto) btnQuitarFoto.addEventListener("click", quitarFoto);

  // Toggle filtro por municipio
  const btnFiltro = document.getElementById("btnToggleFiltro");
  if (btnFiltro) btnFiltro.addEventListener("click", toggleFiltroMunicipio);

  // Validación en vivo: solo dígitos en inputs numéricos
  ["nroVivienda", "dni",
   "tiHhIdAd", "tiHhIdN", "tiHhPdAd", "tiHhPdN",
   "otraEspId", "otraEspPd", "insecticidaCant",
   "hab04", "hab519", "habTotal",
   "animPerros", "animGatos", "animGallinas", "animCabras", "otrasEstrCant",
   "capturaNInsectos",
   "tcruziIdNeg", "tcruziIdPos", "tcruziPdNeg", "tcruziPdPos"
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", (e) => { e.target.value = e.target.value.replace(/[^\d]/g, ""); });
  });

  document.getElementById("loginCorreo").addEventListener("keydown", (e) => {
    if (e.key === "Enter") intentarLogin();
  });
}

window.eliminarPunto = eliminarPunto;
window.abrirVivienda = abrirVivienda;
