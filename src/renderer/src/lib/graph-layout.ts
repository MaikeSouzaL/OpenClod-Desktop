/**
 * Circular layout adapted from ai-memory's Rust graph view
 * (`crates/ai-memory-web/src/routes/graph.rs`, MIT, akitaonrails/ai-memory):
 * the original `circular_layout` places N project nodes evenly on a circle.
 * Here it seeds the force simulation with a readable ring instead of random
 * positions, so the first frame already looks like a graph.
 */
export function circularLayout(
  count: number,
  centerX: number,
  centerY: number,
  radius: number
): Array<{ x: number; y: number }> {
  if (count <= 0) return []
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2
    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    }
  })
}
