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
  dbVersion: 2,
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

  if (!navigator.onLine) return;
  if (CONFIG.endpointSync.includes("PEGAR_URL")) return;

  // 2) refrescar desde el backend en paralelo (no bloquea la UI)
  try {
    const url = CONFIG.endpointSync + "?action=list_dropdowns";
    const res = await fetch(url);
    const json = await res.json();
    if (!json.ok) return;

    if (Array.isArray(json.estados)) {
      localStorage.setItem(CONFIG.cacheEstadosKey, JSON.stringify(json.estados));
      poblarSelect("estadoVivienda", json.estados, "-- Elegir --");
    }
    if (Array.isArray(json.especies)) {
      localStorage.setItem(CONFIG.cacheEspeciesKey, JSON.stringify(json.especies));
      poblarSelect("otraEspecie", json.especies, "-- Ninguna --");
    }
    if (Array.isArray(json.insecticidas)) {
      localStorage.setItem(CONFIG.cacheInsecticidasKey, JSON.stringify(json.insecticidas));
      poblarSelect("insecticidaTipo", json.insecticidas, "-- Ninguno --");
    }
  } catch (e) {
    console.warn("No se pudieron refrescar dropdowns:", e);
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
  const punto = turf.point([lng, lat]);
  for (const feat of POLIGONOS.features) {
    if (turf.booleanPointInPolygon(punto, feat)) {
      return { depto: feat.properties.depto, muni: feat.properties.muni };
    }
  }
  return null;
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

  const detectado = detectarUbicacion(lat, lng);
  const detectBox = document.getElementById("ubicacionDetectada");
  detectBox.classList.remove("hidden", "fuera-corrientes");

  if (detectado) {
    detectBox.innerHTML = `<div><strong>Departamento:</strong> ${escapeHtml(detectado.depto)}</div>
                           <div><strong>Municipio:</strong> ${escapeHtml(detectado.muni)}</div>`;
    ultimoFix = { lat, lng, precision, fuente, ...detectado };
  } else {
    detectBox.classList.add("fuera-corrientes");
    detectBox.innerHTML = `<div><strong>⚠ Punto fuera de la cobertura de polígonos cargados.</strong></div>
                           <div style="font-size: 13px; margin-top: 4px;">Se guardará sin depto/municipio automático.</div>`;
    ultimoFix = { lat, lng, precision, fuente, depto: null, muni: null };
  }

  document.getElementById("formulario").classList.remove("hidden");
  setTimeout(() => document.getElementById("nroVivienda").focus(), 200);
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

  const vivienda = {
    uuid: crypto.randomUUID(),
    fecha: new Date().toISOString(),
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
    opNombre: sesion.nombre
  };

  await guardarEnDB(vivienda);
  toast("Vivienda guardada localmente ✓");

  limpiarFormulario();
  document.getElementById("formulario").classList.add("hidden");
  document.getElementById("coordBox").classList.add("hidden");
  document.getElementById("ubicacionDetectada").classList.add("hidden");
  quitarPuntoDelMapa();
  ultimoFix = null;

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
      // Se manda TODO el objeto vivienda; el backend mapea a las columnas de BD.
      // Se excluyen los campos internos (estado, errorMsg) que solo viven en el cliente.
      const { estado, errorMsg, fechaSync, ...payload } = v;

      const res = await fetch(CONFIG.endpointSync, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "insert_vivienda",
          secret: CONFIG.secret,
          data: payload
        })
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Error del servidor");
      v.estado = "sincronizado";
      v.fechaSync = new Date().toISOString();
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
//                           LISTA DE VIVIENDAS
// ==========================================================================

async function renderizarLista() {
  const puntos = await listarPuntos();
  puntos.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

  document.getElementById("contadorPuntos").textContent = puntos.length;
  const ul = document.getElementById("listaPendientes");
  const empty = document.getElementById("sinPuntos");

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
    return `
      <li>
        <div>
          <span class="status-dot ${dotClass}"></span>
          <strong>${nvi}</strong>${resp}${est}<br>
          <small style="color:#666;">${loc} · ${fecha} · ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</small>
        </div>
        <button style="width:auto;padding:6px 10px;font-size:12px;background:#eee;color:#666;"
                onclick="eliminarPunto('${p.uuid}')">✕</button>
      </li>`;
  }).join("");
}

async function eliminarPunto(uuid) {
  if (!confirm("¿Eliminar esta vivienda de la cola local?")) return;
  await borrarPunto(uuid);
  await renderizarLista();
  await pintarPuntosGuardados();
  toast("Vivienda eliminada");
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
