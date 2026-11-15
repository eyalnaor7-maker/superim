function normalizeBarcode(value) {
  return String(value == null ? '' : value).replace(/^P_/, '').replace(/\D/g, '').replace(/^0+/, '');
}
function pickExactHit(hits, barcode) {
  const want = normalizeBarcode(barcode);
  if (!want) return null;
  return (hits || []).find(h => h && normalizeBarcode(h.sku) === want) || null;
}
function barcodeFromImage(url) {
  const m = String(url || '').match(/\/(?:product-images|gs1)\/(\d+)\//);
  return m ? m[1] : null;
}
function cityFromAddress(address, name) {
  const a = String(address || '');
  const city = a.includes(',') ? a.slice(a.lastIndexOf(',') + 1).trim() : '';
  return city || name || '';
}
// Victory's delivery-slots answer is {date: [slot]}; every slot carries the branch that delivers to that address.
function branchFromDeliverySlots(json) {
  if (!json || json.status !== 'success') return null;
  const slot = Object.values(json.data || {}).flat().find(s => s && s.branchId);
  return slot ? String(slot.branchId) : null;
}
// What `qty` units cost at Victory given the catalog unit price and the product's sales.
// Only two sale names are understood: "N ב-₪X" (N units for X) and a plain "₪X" (sale unit price).
// Card-only (Max) sales and any other wording are ignored, so the result is never lower than what a regular shopper pays.
function victorySaleTotal(unitPrice, qty, sales) {
  const regular = unitPrice * qty;
  let best = regular;
  (sales || []).forEach(s => {
    if (!s || s.isMaxSale) return;
    const m = String(s.name || '').trim().match(/^(?:(\d+)\s*ב-?\s*)?₪\s*(\d+(?:\.\d+)?)$/);
    if (!m) return;
    const n = Number(m[1] || 1), x = Number(m[2]);
    const uses = Math.min(Math.floor(qty / n), s.maxQuantity > 0 ? s.maxQuantity : Infinity);
    const total = uses * x + (qty - uses * n) * unitPrice;
    if (total > 0 && total < best) best = total;
  });
  return Math.round(best * 100) / 100;
}
if (typeof module !== 'undefined') module.exports = { victorySaleTotal, normalizeBarcode, pickExactHit, barcodeFromImage, cityFromAddress, branchFromDeliverySlots };
