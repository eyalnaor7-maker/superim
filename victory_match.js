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
if (typeof module !== 'undefined') module.exports = { normalizeBarcode, pickExactHit, barcodeFromImage, cityFromAddress, branchFromDeliverySlots };
