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

// Turns the site's stored cart items into the popup's cart lines.
// The site keeps the LINE total (after "2 for 115" style sales) in finalCart.FormatedTotalPrice / sumPrice,
// and price.finalPrice is that same line total, not a unit price: multiplying it by the amount double counts.
function ramiCartLines(items) {
  return (Array.isArray(items) ? items : []).filter(i => i && !i.is_delivery && !String(i.name || '').includes('משלוח')).map(i => {
    const quantity = parseFloat(i.amount || 1);
    const p = i.price || {};
    // a line the site has not priced yet (just injected) only has the catalog unit price
    const total = i.finalCart?.FormatedTotalPrice ?? i.sumPrice ?? (parseFloat(p.price ?? p.finalPrice ?? 0) * quantity);
    const available = i.isAvailable !== false;
    return { code: String(i.id), name: i.name, quantity, rami_levy_total: available ? Number(total) || 0 : 0, outOfStock: !available };
  });
}
// The site keeps the delivery charge as a cart line marked is_delivery. Null when the cart has none.
function ramiDeliveryFee(items) {
  const d = (Array.isArray(items) ? items : []).find(i => i && i.is_delivery);
  const fee = d ? Number(d.finalCart?.FormatedTotalPrice ?? d.sumPrice ?? d.price?.price) : NaN;
  return Number.isFinite(fee) ? fee : null;
}
if (typeof module !== 'undefined') module.exports = { mergeGuestCart, ramiCartLines, ramiDeliveryFee };
