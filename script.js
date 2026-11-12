"use strict";

// CONFIGURACIÓN COMERCIAL. Los precios de envío son precios finales.
const DEFAULT_USD_TO_CRC = 500; // Valor inicial editable; no depende de servicios externos.
const EXCHANGE_RATE_STORAGE_KEY = "cotizador.exchangeRate";
let exchangeRateCents = BigInt(DEFAULT_USD_TO_CRC) * 100n;
const SHIPPING_RATES = Object.freeze([
  { maxKg: 10, priceCents: 1500n, priceCrcCents: 750000n, label: "0–10 kg" },
  { maxKg: 20, priceCents: 3000n, priceCrcCents: 1500000n, label: "Más de 10–20 kg" },
  { maxKg: null, priceCents: 4000n, priceCrcCents: 2000000n, label: "Más de 20 kg" }
]);
const IVA_CONFIG = Object.freeze({
  rateBasisPoints: null // null = sin tasa definida. Al definirla: porcentaje × 100.
  // El IVA se DESGLOSA del precio de envío final, nunca se suma a las tarifas.
});
const LIMITS = Object.freeze({ priceCents: 999999999n, quantity: 9999n, weightMicros: 1000000000000n, exchangeRateCents: 100000000n });
const WEIGHT_SCALE = 1000000n; // Admite hasta 6 decimales sin redondear los rangos.
const integerFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

// Dinero en centavos enteros BigInt: evita errores como 0.1 + 0.2.
function formatAmount(cents, symbol, alwaysDecimals) {
  const whole = cents / 100n;
  const fraction = cents % 100n;
  const decimals = alwaysDecimals || fraction !== 0n ? "." + fraction.toString().padStart(2, "0") : "";
  return symbol + integerFormatter.format(whole) + decimals;
}
function usd(cents) { return formatAmount(cents, "$", true); }
function crc(cents, rateCents = exchangeRateCents) {
  return rateCents === null ? "—" : formatAmount(roundDivide(cents * rateCents, 100n), "₡", true);
}
function quoteTotalCrc(subtotalCents, shippingCrcCents, rateCents = exchangeRateCents) {
  return rateCents === null ? null : roundDivide(subtotalCents * rateCents, 100n) + shippingCrcCents;
}

// Punto o coma como separador decimal. No se aceptan separadores de miles,
// negativos, notación científica, Infinity, letras ni decimales adicionales.
function parseDecimal(raw, decimals, maxValue, message) {
  const value = raw.trim();
  if (value === "") return { value: null, error: "" };
  const pattern = new RegExp("^(?:\\d+(?:[.,]\\d{0," + decimals + "})?|[.,]\\d{1," + decimals + "})$");
  if (!pattern.test(value)) return { value: null, error: message };
  const parts = value.replace(",", ".").split(".");
  const result = BigInt(parts[0] || "0") * (10n ** BigInt(decimals)) + BigInt((parts[1] || "").padEnd(decimals, "0"));
  if (result > maxValue) return { value: null, error: message };
  return { value: result, error: "" };
}
function parsePrice(raw) {
  return parseDecimal(raw, 2, LIMITS.priceCents, "Usa un precio de 0 a 9,999,999.99, con máximo 2 decimales.");
}
function parseQuantity(raw) {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return { value: null, error: "Usa una cantidad entera de 1 a 9,999." };
  const quantity = BigInt(value);
  if (quantity < 1n || quantity > LIMITS.quantity) return { value: null, error: "Usa una cantidad entera de 1 a 9,999." };
  return { value: quantity, error: "" };
}
function parseDiscount(raw, type, subtotalCents = null) {
  if (!["percent", "fixed"].includes(type)) return { value: null, cents: 0n, error: "Selecciona porcentaje o monto fijo." };
  const parsed = parseDecimal(raw, 2, type === "percent" ? 10000n : LIMITS.priceCents * LIMITS.quantity,
    type === "percent" ? "Usa un descuento de 0 a 100 %, con máximo 2 decimales." : "Usa un descuento no negativo en USD, con máximo 2 decimales.");
  if (parsed.error) return { value: null, cents: 0n, error: parsed.error };
  const value = parsed.value ?? 0n;
  if (type === "fixed" && subtotalCents !== null && value > subtotalCents) {
    return { value: null, cents: 0n, error: "El descuento no puede superar el subtotal de este producto." };
  }
  return { value, cents: subtotalCents === null ? 0n : type === "percent" ? roundDivide(subtotalCents * value, 10000n) : value, error: "" };
}
function parseWeight(raw) {
  return parseDecimal(raw, 6, LIMITS.weightMicros, "Usa un peso de 0 a 1,000,000 kg, con máximo 6 decimales.");
}
function parseExchangeRate(raw) {
  const message = "Usa un cambio mayor que 0 y hasta 1,000,000, con máximo 2 decimales.";
  const parsed = parseDecimal(raw, 2, LIMITS.exchangeRateCents, message);
  if (parsed.value === null || parsed.value === 0n) return { value: null, error: parsed.error || message };
  return parsed;
}
function shippingIndex(weightMicros) {
  return SHIPPING_RATES.findIndex(rate => rate.maxKg === null || weightMicros <= BigInt(rate.maxKg) * WEIGHT_SCALE);
}
function roundDivide(numerator, denominator) { return (numerator + denominator / 2n) / denominator; }
function taxBreakdown(grossCents) {
  const rate = IVA_CONFIG.rateBasisPoints;
  if (rate === null) return { grossCents, netCents: null, ivaCents: null };
  if (!Number.isSafeInteger(rate) || rate < 0) throw new Error("El IVA debe ser un entero no negativo en puntos básicos.");
  const netCents = roundDivide(grossCents * 10000n, 10000n + BigInt(rate));
  return { grossCents, netCents, ivaCents: grossCents - netCents };
}

const elements = {
  list: document.getElementById("product-list"),
  exchangeRate: document.getElementById("exchange-rate"),
  weight: document.getElementById("weight"),
  copy: document.getElementById("copy-summary"),
  status: document.getElementById("summary-status"),
  dialog: document.getElementById("manual-copy-dialog")
};
let nextId = 0;
let lastQuote = null;
let toastTimer;
let showRequiredFields = false;

function restoreExchangeRate() {
  elements.exchangeRate.value = String(DEFAULT_USD_TO_CRC);
  try {
    const saved = localStorage.getItem(EXCHANGE_RATE_STORAGE_KEY);
    if (saved !== null && !parseExchangeRate(saved).error) elements.exchangeRate.value = saved;
  } catch (_) { /* El cotizador funciona aunque el navegador bloquee el almacenamiento. */ }
}
function changeExchangeRate() {
  updateQuote();
  if (exchangeRateCents === null) return;
  try {
    localStorage.setItem(EXCHANGE_RATE_STORAGE_KEY, elements.exchangeRate.value.trim().replace(",", "."));
  } catch (_) { /* Mantener el cambio durante esta sesión si no se puede guardar. */ }
}

function setText(id, value) { document.getElementById(id).textContent = value; }
function setMoneyPair(prefix, cents, unavailable = false, crcCents = undefined) {
  setText(prefix + "-usd", unavailable ? "—" : usd(cents));
  setText(prefix + "-crc", unavailable || crcCents === null ? "—" : crcCents === undefined ? crc(cents) : formatAmount(crcCents, "₡", true));
}
function showFieldError(input, message) {
  const error = document.getElementById(input.dataset.error || "weight-error");
  input.setAttribute("aria-invalid", message ? "true" : "false");
  input.setCustomValidity(message);
  error.textContent = message;
  error.hidden = !message;
}
function renumberRows() {
  [...elements.list.children].forEach((row, index) => {
    row.querySelector(".row-name").textContent = "Producto " + (index + 1);
    row.querySelector(".delete-button").setAttribute("aria-label", "Eliminar producto " + (index + 1));
  });
}
function addProduct(focus = true) {
  if (elements.list.children.length >= 100) { showToast("Puedes cotizar hasta 100 productos por pedido."); return; }
  const id = ++nextId;
  const row = document.createElement("div");
  row.className = "product-row";
  // Sólo se interpola un identificador numérico interno, nunca texto del usuario.
  row.innerHTML = `
    <div class="row-heading"><span class="row-name"></span>
      <button type="button" class="delete-button" title="Eliminar producto"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg></button>
    </div>
    <div class="field description-field"><label for="description-${id}">Descripción del producto (opcional)</label><div class="input-shell"><input id="description-${id}" class="description-input" type="text" maxlength="120" placeholder="Nombre o referencia del producto"></div></div>
    <div class="row-fields">
      <div class="field"><label for="price-${id}">Precio unitario (USD)</label>
        <div class="input-shell"><span class="input-prefix" aria-hidden="true">$</span><input id="price-${id}" class="price-input" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" maxlength="16" aria-describedby="price-error-${id}" data-error="price-error-${id}"></div>
        <p class="field-error" id="price-error-${id}" hidden></p>
      </div>
      <div class="field"><label for="quantity-${id}">Cantidad</label>
        <div class="input-shell"><input id="quantity-${id}" class="quantity-input" type="text" inputmode="numeric" autocomplete="off" value="1" maxlength="8" aria-describedby="quantity-error-${id}" data-error="quantity-error-${id}"></div>
        <p class="field-error" id="quantity-error-${id}" hidden></p>
      </div>
    </div>
    <div class="row-fields discount-fields">
      <div class="field"><label for="discount-type-${id}">Tipo de descuento</label>
        <select id="discount-type-${id}" class="discount-type"><option value="percent">Porcentaje (%)</option><option value="fixed">Monto fijo (USD)</option></select>
      </div>
      <div class="field"><label class="discount-label" for="discount-${id}">Descuento (%)</label>
        <div class="input-shell"><input id="discount-${id}" class="discount-input" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" maxlength="18" aria-describedby="discount-error-${id} discount-hint-${id}" data-error="discount-error-${id}"></div>
        <p class="field-hint discount-hint" id="discount-hint-${id}">Se aplica al subtotal de este producto.</p>
        <p class="field-error" id="discount-error-${id}" hidden></p>
      </div>
    </div>
    <label class="checkbox-label"><input class="tax-exempt-input" type="checkbox"> Producto exento (registro; no agrega impuestos)</label>
    <dl class="line-breakdown">
      <div><dt>Subtotal original</dt><dd class="line-original-usd">$0.00</dd></div>
      <div><dt>Descuento aplicado</dt><dd class="line-discount-usd">$0.00</dd></div>
      <div class="line-subtotal"><dt>Total del producto</dt><dd class="line-money"><strong class="line-usd">$0.00</strong><span class="line-crc">₡0.00</span></dd></div>
    </dl>`;
  elements.list.append(row);
  renumberRows();
  updateQuote();
  if (focus) row.querySelector(".price-input").focus();
}
function renderTariffs() {
  const body = document.getElementById("tariff-body");
  body.replaceChildren();
  SHIPPING_RATES.forEach((rate, index) => {
    const row = document.createElement("tr");
    row.dataset.rateIndex = String(index);
    [rate.label, usd(rate.priceCents), formatAmount(rate.priceCrcCents, "₡", true)].forEach(value => {
      const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
    });
    body.append(row);
  });
  const rateLabel = exchangeRateCents === null ? "—" : formatAmount(exchangeRateCents, "₡", true);
  setText("exchange-header", "$1 = " + rateLabel);
  setText("exchange-note", exchangeRateCents === null ? "Ingresa un tipo de cambio válido." : "Tipo de cambio: $1 USD = " + rateLabel + " CRC");
}
let nextPackageId = 0;
function addPackage(value = "", focus = true) {
  const list = document.getElementById("package-list");
  if (list.children.length >= 100) { showToast("Puedes agregar hasta 100 bultos por pedido."); return; }
  const id = ++nextPackageId;
  const row = document.createElement("div"); row.className = "shipping-entry package-row";
  row.innerHTML = `<div class="field"><label class="package-label" for="package-weight-${id}"></label>
    <div class="input-shell"><input id="package-weight-${id}" class="package-weight" data-error="package-error-${id}" type="text" inputmode="decimal" autocomplete="off" placeholder="0.0" maxlength="20" aria-describedby="package-error-${id} weight-hint"><span class="input-suffix">kg</span></div>
    <p class="field-error" id="package-error-${id}" hidden></p>
    <button type="button" class="small-button remove-package">Quitar bulto</button></div>
    <div class="shipping-price"><span>Tarifa de este bulto</span><strong class="package-usd">$0.00</strong><span class="package-crc">₡0</span></div>`;
  row.querySelector("input").value = value; list.append(row); renumberPackages(); updateQuote();
  if (focus) row.querySelector("input").focus();
}
function renumberPackages() {
  document.querySelectorAll(".package-row").forEach((row, index) => {
    row.querySelector(".package-label").textContent = "Peso del bulto " + (index + 1);
    row.querySelector(".remove-package")?.setAttribute("aria-label", "Quitar bulto " + (index + 1));
  });
}
function renderTax(grossCents, hasWeight) {
  const container = document.getElementById("tax-breakdown");
  container.hidden = IVA_CONFIG.rateBasisPoints === null || !hasWeight;
  if (container.hidden) return;
  const tax = taxBreakdown(grossCents);
  container.replaceChildren();
  const title = document.createElement("p"); title.textContent = "Desglose del envío · IVA " + (IVA_CONFIG.rateBasisPoints / 100) + "%";
  const list = document.createElement("dl");
  [["Sin IVA", tax.netCents], ["IVA", tax.ivaCents], ["Con IVA", tax.grossCents]].forEach(([label, cents]) => {
    const item = document.createElement("div");
    const term = document.createElement("dt"); term.textContent = label;
    const detail = document.createElement("dd"); detail.textContent = usd(cents) + " / " + crc(cents, 50000n);
    item.append(term, detail); list.append(item);
  });
  container.append(title, list);
}
function updateQuote() {
  const exchangeRate = parseExchangeRate(elements.exchangeRate.value);
  exchangeRateCents = exchangeRate.value;
  showFieldError(elements.exchangeRate, exchangeRate.error);
  renderTariffs();
  let subtotal = 0n, originalSubtotal = 0n, discounts = 0n;
  const items = [];
  let units = 0n;
  let productCount = 0;
  let hasInvalidProduct = false;
  const hasEnteredPrice = [...elements.list.children].some(row => row.querySelector(".price-input").value.trim());
  for (const row of elements.list.children) {
    const priceInput = row.querySelector(".price-input");
    const quantityInput = row.querySelector(".quantity-input");
    const price = parsePrice(priceInput.value);
    const quantity = parseQuantity(quantityInput.value);
    const discountInput = row.querySelector(".discount-input");
    const discountType = row.querySelector(".discount-type");
    row.querySelector(".discount-label").textContent = discountType.value === "fixed" ? "Descuento (USD)" : "Descuento (%)";
    // Una línea nueva intacta no modifica ni bloquea la cotización existente.
    const untouched = priceInput.value.trim() === "" && !priceInput.dataset.touched && !quantityInput.dataset.touched
      && !discountInput.dataset.touched && !discountType.dataset.touched && !(showRequiredFields && !hasEnteredPrice && row === elements.list.firstElementChild);
    const priceError = price.error || (!untouched && price.value === null ? "Ingresa el precio o elimina esta línea." : "");
    showFieldError(priceInput, priceError);
    showFieldError(quantityInput, untouched ? "" : quantity.error);
    const gross = price.value !== null && quantity.value !== null ? price.value * quantity.value : null;
    const discount = parseDiscount(discountInput.value, discountType.value, gross);
    showFieldError(discountInput, discount.error);
    const valid = gross !== null && !discount.error;
    const lineCents = valid ? gross - discount.cents : 0n;
    row.querySelector(".line-original-usd").textContent = gross === null ? untouched ? usd(0n) : "—" : usd(gross);
    row.querySelector(".line-discount-usd").textContent = discount.error ? "—" : usd(discount.cents);
    row.querySelector(".line-usd").textContent = untouched ? usd(0n) : valid ? usd(lineCents) : "—";
    row.querySelector(".line-crc").textContent = untouched ? crc(0n) : valid ? crc(lineCents) : "Pendiente";
    if (valid) {
      subtotal += lineCents; originalSubtotal += gross; discounts += discount.cents; units += quantity.value; productCount++;
      items.push({ description: row.querySelector(".description-input").value.trim() || row.querySelector(".row-name").textContent,
        quantity: quantity.value, originalSubtotal: gross, discount: discount.cents, total: lineCents });
    }
    if (!untouched && (!valid || priceError || quantity.error || discount.error)) hasInvalidProduct = true;
  }
  const packages = []; const selectedRates = new Set();
  let shipping = 0n, shippingCrc = 0n, weightMicros = 0n, hasWeight = true, weightError = false;
  document.querySelectorAll(".package-row").forEach(row => {
    const input = row.querySelector(".package-weight"); const weight = parseWeight(input.value);
    const error = weight.error || (showRequiredFields && weight.value === null ? "Ingresa el peso de este bulto." : "");
    showFieldError(input, error); weightError ||= Boolean(error);
    if (weight.value === null) hasWeight = false;
    const index = weight.value === null ? -1 : shippingIndex(weight.value);
    const rate = index < 0 ? null : SHIPPING_RATES[index];
    const cost = rate?.priceCents ?? 0n, costCrc = rate?.priceCrcCents ?? 0n;
    row.querySelector(".package-usd").textContent = weight.error ? "—" : usd(cost);
    row.querySelector(".package-crc").textContent = weight.error ? "—" : formatAmount(costCrc, "₡", true);
    shipping += cost; shippingCrc += costCrc; weightMicros += weight.value ?? 0n;
    if (rate) selectedRates.add(index);
    packages.push({ weightMicros: weight.value, shipping: cost, shippingCrc: costCrc });
  });
  setText("package-count", packages.length + (packages.length === 1 ? " bulto" : " bultos"));
  const hasAmountError = hasInvalidProduct || weightError;
  const hasError = hasAmountError || Boolean(exchangeRate.error);
  const total = subtotal + shipping;
  const totalCrc = quoteTotalCrc(subtotal, shippingCrc);
  const ready = productCount > 0 && hasWeight && !hasError;
  lastQuote = { subtotal, originalSubtotal, discounts, items, shipping, shippingCrc, packages, weightMicros, total, totalCrc, units, productCount, ready, exchangeRateCents,
    customerName: document.getElementById("customer-name")?.value.trim() || "" };

  setMoneyPair("products", subtotal, hasInvalidProduct);
  setMoneyPair("summary-products", originalSubtotal, hasInvalidProduct);
  // El ajuste de redondeo en CRC conserva subtotal original − descuento = productos netos.
  const originalCrc = quoteTotalCrc(originalSubtotal, 0n);
  const netCrc = quoteTotalCrc(subtotal, 0n);
  setMoneyPair("summary-discounts", discounts, hasInvalidProduct, originalCrc === null ? null : originalCrc - netCrc);
  setMoneyPair("shipping", shipping, weightError, shippingCrc);
  setMoneyPair("summary-shipping", shipping, weightError, shippingCrc);
  setMoneyPair("total", total, hasAmountError, totalCrc);
  setText("mobile-usd", hasAmountError ? "—" : usd(total) + " USD");
  setText("mobile-crc", hasAmountError || totalCrc === null ? "—" : formatAmount(totalCrc, "₡", true));
  setText("mobile-label", hasError ? "Revisa los datos" : ready ? "Total a pagar" : "Total parcial");
  const unitLabel = integerFormatter.format(units) + (units === 1n ? " unidad" : " unidades");
  setText("unit-count", unitLabel);
  setText("summary-count", productCount ? productCount + (productCount === 1 ? " producto · " : " productos · ") + unitLabel : "Agrega el primer producto");
  document.querySelectorAll("[data-rate-index]").forEach(row => row.classList.toggle("active", selectedRates.has(Number(row.dataset.rateIndex))));
  setText("weight-hint", hasWeight ? "Peso total: " + Number(weightMicros) / 1000000 + " kg. Se suma la tarifa de cada bulto por separado." : "Completa el peso de cada bulto para calcular el envío completo.");
  elements.copy.disabled = !ready;
  elements.status.classList.toggle("error", hasError);
  elements.status.textContent = hasError ? "Corrige los campos marcados para obtener el total." : ready ? "Lista para compartir con el cliente." : productCount === 0 ? "Agrega productos y peso para completar la cotización." : "Total parcial: completa el peso de cada bulto.";
  renderTax(shipping, hasWeight);
  document.dispatchEvent(new CustomEvent("quote:changed"));
}
function clearQuote() {
  showRequiredFields = false;
  elements.list.replaceChildren();
  elements.weight.value = "";
  document.querySelectorAll(".package-row").forEach((row, index) => { if (index) row.remove(); });
  elements.dialog.close();
  document.getElementById("manual-summary").value = "";
  addProduct(false);
  showToast("Cotización limpia. Puedes comenzar otra.");
  elements.list.querySelector(".price-input").focus();
}
function summaryText(quote) {
  return [
    quote.customerName ? "¡Hola, " + quote.customerName + "! 😊" : "¡Hola! 😊", "",
    "Con mucho gusto te compartimos la cotización de tu pedido en Mega Regalon:", "",
    ...quote.items.flatMap((item, index) => [
      (index + 1) + ". " + item.description + " · " + item.quantity + " unidades",
      "Subtotal: " + usd(item.originalSubtotal) + " · Descuento: " + usd(item.discount) + " · Total: " + usd(item.total)
    ]), "",
    "Subtotal original: " + usd(quote.originalSubtotal),
    "Descuentos individuales: " + usd(quote.discounts),
    "Productos (" + integerFormatter.format(quote.units) + " unidades): " + usd(quote.subtotal) + " / " + crc(quote.subtotal, quote.exchangeRateCents),
    "Envío: " + usd(quote.shipping) + " / " + formatAmount(quote.shippingCrc, "₡", true), "",
    ...quote.packages.map((p, i) => "Bulto " + (i + 1) + ": " + Number(p.weightMicros) / 1000000 + " kg · " + usd(p.shipping) + " / " + formatAmount(p.shippingCrc, "₡", true)), "",
    "Total estimado de tu pedido:", usd(quote.total) + " USD", formatAmount(quote.totalCrc, "₡", true) + " CRC", "",
    "Tipo de cambio: $1 USD = " + formatAmount(quote.exchangeRateCents, "₡", true) + " CRC.",
    "El monto es estimado; te confirmaremos el total final al pasar por caja.", "",
    "Si tienes alguna duda sobre tu cotización, escríbenos. ¡Con gusto te ayudamos!", "",
    "¡Gracias por confiar en nosotros! 💛",
    "MEGA REGALON TU MEJOR OPCION"
  ].join("\n");
}
function showToast(message) {
  const toast = document.getElementById("toast");
  clearTimeout(toastTimer); toast.textContent = message; toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}
// Compatibilidad al abrir index.html con file:// y al publicar por HTTPS.
function legacyCopy(text) {
  const focused = document.activeElement;
  const scrollX = window.scrollX, scrollY = window.scrollY;
  const area = document.createElement("textarea"); area.value = text; area.readOnly = true;
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;width:1px;height:1px;";
  document.body.append(area); area.select(); area.setSelectionRange(0, text.length);
  let copied = false;
  try { copied = document.execCommand("copy"); } catch (_) { copied = false; }
  area.remove(); if (focused) focused.focus({ preventScroll: true }); window.scrollTo(scrollX, scrollY);
  return copied;
}
async function copySummary() {
  if (!lastQuote || !lastQuote.ready) return;
  const text = summaryText(lastQuote);
  let copied = false;
  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(text); copied = true; } catch (_) { /* Intentar ruta local. */ }
  }
  if (!copied) copied = legacyCopy(text);
  if (copied) { showToast("Resumen copiado. Pégalo en WhatsApp."); return; }
  const area = document.getElementById("manual-summary"); area.value = text;
  elements.dialog.showModal(); area.focus(); area.select();
}

elements.list.addEventListener("input", event => {
  if (!event.target.matches("input, select")) return;
  event.target.dataset.touched = "true"; updateQuote();
});
elements.list.addEventListener("change", event => {
  if (event.target.matches(".discount-type")) { event.target.dataset.touched = "true"; updateQuote(); }
});
elements.list.addEventListener("click", event => {
  const button = event.target.closest(".delete-button");
  if (!button) return;
  const row = button.closest(".product-row");
  const focusTarget = row.nextElementSibling || row.previousElementSibling;
  row.remove(); renumberRows(); updateQuote();
  (focusTarget ? focusTarget.querySelector(".price-input") : document.getElementById("add-product")).focus();
});
document.getElementById("package-list").addEventListener("input", updateQuote);
document.getElementById("add-package").addEventListener("click", () => addPackage());
document.getElementById("package-list").addEventListener("click", event => {
  const remove = event.target.closest(".remove-package"); if (!remove) return;
  const row = remove.closest(".package-row"); const previous = row.previousElementSibling;
  row.remove(); renumberPackages(); updateQuote(); previous?.querySelector("input").focus();
});
elements.exchangeRate.addEventListener("input", changeExchangeRate);
document.getElementById("add-product").addEventListener("click", () => addProduct());
document.getElementById("clear-quote").addEventListener("click", clearQuote);
elements.copy.addEventListener("click", copySummary);
document.getElementById("close-copy-dialog").addEventListener("click", () => elements.dialog.close());
restoreExchangeRate();
addProduct(false);

function decimalInput(value, decimals = 2) {
  const n = BigInt(value); const scale = 10n ** BigInt(decimals);
  return (n / scale).toString() + "." + (n % scale).toString().padStart(decimals, "0");
}
function currentSnapshot() {
  if (!lastQuote?.ready) return null;
  const items = [...elements.list.children].flatMap(row => {
    const price = parsePrice(row.querySelector(".price-input").value);
    const quantity = parseQuantity(row.querySelector(".quantity-input").value);
    if (price.value === null || quantity.value === null) return [];
    const type = row.querySelector(".discount-type").value;
    const discount = parseDiscount(row.querySelector(".discount-input").value, type, price.value * quantity.value);
    return [{ description: row.querySelector(".description-input").value.trim() || row.querySelector(".row-name").textContent,
      unit_price_cents: price.value.toString(), quantity: Number(quantity.value),
      discount_type: type, discount_value: discount.value.toString(),
      tax_exempt: row.querySelector(".tax-exempt-input").checked }];
  });
  return { items, discount_pricing_version: 1, exchange_rate_cents: exchangeRateCents.toString(), weight_micros: lastQuote.weightMicros.toString(), packages: lastQuote.packages.map(p => ({ weight_micros: p.weightMicros.toString() })), shipping_pricing_version: 3 };
}
function loadSnapshot(snapshot) {
  showRequiredFields = false;
  elements.list.replaceChildren();
  elements.exchangeRate.value = decimalInput(snapshot.exchange_rate_cents);
  document.querySelectorAll(".package-row").forEach((row, index) => { if (index) row.remove(); });
  const packages = snapshot.packages ?? [{ weight_micros: snapshot.weight_micros }];
  elements.weight.value = decimalInput(packages[0].weight_micros, 6);
  for (const p of packages.slice(1)) addPackage(decimalInput(p.weight_micros, 6), false);
  for (const item of snapshot.items) {
    addProduct(false);
    const row = elements.list.lastElementChild;
    row.querySelector(".price-input").value = decimalInput(item.unit_price_cents);
    row.querySelector(".quantity-input").value = String(item.quantity);
    row.querySelector(".description-input").value = item.description;
    row.querySelector(".tax-exempt-input").checked = item.tax_exempt;
    row.querySelector(".discount-type").value = item.discount_type ?? "percent";
    row.querySelector(".discount-input").value = decimalInput(item.discount_value ?? "0");
  }
  updateQuote();
}
window.Cotizador = Object.freeze({ getSnapshot: currentSnapshot, loadSnapshot, clearQuote, refresh: updateQuote, showToast,
  validate() { showRequiredFields = true; updateQuote(); return lastQuote.ready; } });
