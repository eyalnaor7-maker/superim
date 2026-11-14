// Guest Rami Levy cart lives in localStorage["ramilevy"].cart.items (catalog objects + amount).
function mergeGuestCart(state, products, quantities) {
  const next = JSON.parse(JSON.stringify(state || {}));
  const cart = next.cart || (next.cart = {});
  const ids = new Set(products.map(p => String(p.id)));
  const kept = (Array.isArray(cart.items) ? cart.items : []).filter(i => !ids.has(String(i.id)));
  const added = products.map(p => ({ ...JSON.parse(JSON.stringify(p)), amount: Number(quantities[p.id]) }));
  cart.items = kept.concat(added);
  return next;
}
if (typeof module !== 'undefined') module.exports = { mergeGuestCart };
