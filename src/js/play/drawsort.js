// What's drawn, sorted without the garbage. three sorts each render call's list (by material, then by depth) with
// Array.prototype.sort, which makes a work array every call, and its comparisons return a fractional difference of
// depths, which handed back to the sort is a new object each time (over 100 MB of garbage in four minutes of a match
// between them). The same order with these: comparisons that return -1, 0 or 1 where they would have returned a
// fraction, and a sort in place on each list (a binary insertion sort: stable, like V8's, so with three's order, which
// never calls two of them equal, the result is the same). Pure JS: three's WebGLRenderer and its render lists.
export function quietSorting(renderer, scenes) {
  renderer.setOpaqueSort(opaqueOrder);
  renderer.setTransparentSort(transparentOrder);
  for (const scene of scenes) {
    if (!scene) continue;
    const list = renderer.renderLists.get(scene, 0); // (the list a render of it, not inside another, fills)
    list.opaque.sort = list.transmissive.sort = list.transparent.sort = sortInPlace;
  }
}

// three's painterSortStable and reversePainterSortStable (r186), with the depths compared, not subtracted.
function opaqueOrder(a, b) {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (a.material.id !== b.material.id) return a.material.id - b.material.id;
  if (a.materialVariant !== b.materialVariant) return a.materialVariant - b.materialVariant;
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  return a.id - b.id;
}
function transparentOrder(a, b) {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (a.z !== b.z) return a.z > b.z ? -1 : 1; // (back to front)
  return a.id - b.id;
}

// Array.prototype.sort's place on a render list: each item put in after the last one it doesn't come before.
function sortInPlace(order) {
  const a = this;
  for (let i = 1; i < a.length; i++) {
    const x = a[i];
    let lo = 0, hi = i;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (order(a[mid], x) > 0) hi = mid; else lo = mid + 1; }
    for (let j = i; j > lo; j--) a[j] = a[j - 1];
    a[lo] = x;
  }
  return a;
}
